"""CSV/XLSX 시추공 인제스트 라우터 (옵션 B).

흐름 (PDF의 AWAITING_REVIEW→APPROVED 검수 패턴과 동일 철학):

  1) POST /csv-ingestion/projects/{id}/preview
        파일 업로드 → 컬럼 역할/포맷/CRS 자동추론 + 데이터 미리보기 반환.
        **DB 미저장.** 마법사가 이 제안을 사용자에게 보여주고 역할·CRS를 확정한다.

  2) POST /csv-ingestion/projects/{id}/commit
        사용자가 확정한 역할(role_overrides)·좌표계(source_crs)로 재파싱 →
        PdfService.persist_rows 로 적재(중복 검사·프로젝트 링크·data_origin 일원화).
        provenance 용 PdfExtractionJob(APPROVED) 레코드를 남긴다.

좌표계는 평면좌표(X/Y) 입력 시 commit 에서 필수. 자동추론은 한국 좌표계 여러 개가
모두 한반도에 떨어져 단정 불가하므로, 사용자 확정값을 우선한다.
"""

from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.core.database import SyncSessionLocal
from app.models import (
    ExtractionJobStatus,
    PdfExtractionJob,
    Project,
    ProjectMember,
    ProjectMemberRole,
    User,
)
from app.services import csv_ingest
from app.services.pdf_service import PdfService

router = APIRouter()

_ALLOWED_EXT = {".csv", ".tsv", ".xlsx", ".xlsm"}
_MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _upload_root() -> Path:
    configured_dir = Path(settings.pdf_convert_data_dir)
    if not configured_dir.is_absolute():
        configured_dir = Path(__file__).resolve().parents[3] / configured_dir
    upload_root = configured_dir / "data" / "00_source" / "temp_uploads"
    upload_root.mkdir(parents=True, exist_ok=True)
    return upload_root


def _csv_source_root() -> Path:
    return _upload_root().parent / "csv_uploads"


def _save_upload(file: UploadFile, root: Path | None = None) -> Path:
    original_name = file.filename or "source.csv"
    ext = Path(original_name).suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="CSV, TSV, XLSX 파일만 업로드할 수 있습니다.",
        )
    request_id = uuid.uuid4().hex
    target_dir = (root or _upload_root()) / request_id
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(original_name).stem).strip("._") or "source"
    target_path = target_dir / f"{safe_stem}{ext}"
    written = 0
    try:
        with target_path.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="업로드 파일은 25MB를 초과할 수 없습니다.",
                    )
                out.write(chunk)
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    return target_path


async def _require_project(db: AsyncSession, project_id: int, current_user: User) -> Project:
    project = await db.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
    if project.owner_id == current_user.id or current_user.role == "admin":
        return project
    membership = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == current_user.id,
                ProjectMember.role.in_(
                    [ProjectMemberRole.OWNER, ProjectMemberRole.EDITOR]
                ),
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=403, detail="프로젝트 데이터 업로드 권한이 없습니다.")
    return project


def _project_coordinate_anchor(project: Project) -> tuple[float, float] | None:
    bbox_payload = project.bbox if isinstance(project.bbox, dict) else None
    bbox = bbox_payload.get("bbox") if bbox_payload else None
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        min_lng, min_lat, max_lng, max_lat = [float(value) for value in bbox]
    except (TypeError, ValueError):
        return None
    if not (min_lng < max_lng and min_lat < max_lat):
        return None
    return ((min_lng + max_lng) / 2.0, (min_lat + max_lat) / 2.0)


def _parse_overrides(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"mapping JSON 파싱 실패: {exc}") from exc
    return data if isinstance(data, dict) else None


def _parse_edited_rows(raw: str | None) -> list[dict] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"edited_rows JSON 파싱 실패: {exc}") from exc
    if not isinstance(data, list) or not all(isinstance(row, dict) for row in data):
        raise HTTPException(status_code=422, detail="edited_rows는 객체 배열이어야 합니다.")
    if len(data) > csv_ingest.MAX_TABLE_ROWS:
        raise HTTPException(status_code=422, detail="편집 데이터 행 수가 허용 범위를 초과합니다.")
    return data


def _strip_raw(boreholes: list[dict]) -> list[dict]:
    """미리보기/응답에서 내부용 _raw 키 제거."""
    out = []
    for b in boreholes:
        nb = dict(b)
        nb["strata"] = [{k: v for k, v in s.items() if k != "_raw"} for s in b["strata"]]
        out.append(nb)
    return out


@router.post("/projects/{project_id}/preview")
async def preview_csv(
    project_id: int,
    file: UploadFile = File(...),
    source_crs: str | None = Form(default=None),
    mapping: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """업로드 파일을 추론만 하고 미리보기 반환(미저장)."""
    project = await _require_project(db, project_id, current_user)
    coordinate_anchor = _project_coordinate_anchor(project)
    path = _save_upload(file)
    try:
        rows = csv_ingest.read_table(str(path))
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(path.parent, ignore_errors=True)
        raise HTTPException(status_code=422, detail=f"파일을 읽을 수 없습니다: {exc}") from exc
    if not rows:
        shutil.rmtree(path.parent, ignore_errors=True)
        raise HTTPException(status_code=422, detail="데이터가 없습니다.")

    try:
        cmap = csv_ingest.infer_mapping(rows, source_crs=source_crs)
        cmap = csv_ingest.apply_overrides(cmap, _parse_overrides(mapping))
        boreholes, issues = csv_ingest.build_boreholes(
            rows,
            cmap,
            coordinate_anchor=coordinate_anchor,
        )
        response = {
            "filename": file.filename,
            "mapping": cmap.to_dict(),
            "summary": {
                "boreholes": len(boreholes),
                "strata": sum(len(b["strata"]) for b in boreholes),
                "rows_total": len(rows),
            },
            "preview": _strip_raw(boreholes),
            "issues": issues,
        }
    finally:
        shutil.rmtree(path.parent, ignore_errors=True)
    return response


@router.post("/projects/{project_id}/commit", status_code=status.HTTP_201_CREATED)
async def commit_csv(
    project_id: int,
    file: UploadFile = File(...),
    source_crs: str | None = Form(default=None),
    mapping: str | None = Form(default=None),
    edited_rows: str | None = Form(default=None),
    is_supplementary: bool = Form(default=False),
    idempotency_key: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """사용자 확정 매핑으로 적재. persist_rows 재사용(중복/링크/origin 일원화)."""
    project = await _require_project(db, project_id, current_user)
    coordinate_anchor = _project_coordinate_anchor(project)

    # A reviewed preview keeps one key across retries. If the browser retries
    # the same save, return its original job instead of inserting boreholes.
    if idempotency_key:
        # Serialize concurrent requests carrying the same key. The lock is
        # released by the job commit below, after which a waiting request can
        # see the newly-created job.
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": f"csv-commit:{project_id}:{idempotency_key}"},
        )
        recent_jobs = (await db.execute(
            select(PdfExtractionJob)
            .where(PdfExtractionJob.project_id == project_id)
            .order_by(PdfExtractionJob.id.desc())
            .limit(100)
        )).scalars().all()
        existing_job = next(
            (
                candidate
                for candidate in recent_jobs
                if isinstance(candidate.result, dict)
                and candidate.result.get("idempotency_key") == idempotency_key
            ),
            None,
        )
        if existing_job is not None:
            if existing_job.status == ExtractionJobStatus.APPROVED:
                stored = existing_job.result or {}
                created = {
                    key: value
                    for key, value in stored.items()
                    if key.endswith("_count") and isinstance(value, int)
                }
                return {
                    "job_id": existing_job.id,
                    "status": existing_job.status.value,
                    "result": created,
                    "issues": stored.get("issues", []),
                    "duplicate_request": True,
                }
            raise HTTPException(status_code=409, detail="동일한 저장 요청이 이미 처리 중입니다.")

    parsed_edited_rows = _parse_edited_rows(edited_rows)
    path = _save_upload(file, _csv_source_root())
    try:
        rows = csv_ingest.read_table(str(path))
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(path.parent, ignore_errors=True)
        raise HTTPException(status_code=422, detail=f"파일을 읽을 수 없습니다: {exc}") from exc

    cmap = csv_ingest.infer_mapping(rows, source_crs=source_crs)
    cmap = csv_ingest.apply_overrides(cmap, _parse_overrides(mapping))
    boreholes, issues = csv_ingest.build_boreholes(
        rows,
        cmap,
        coordinate_anchor=coordinate_anchor,
    )
    if not boreholes:
        shutil.rmtree(path.parent, ignore_errors=True)
        raise HTTPException(
            status_code=422,
            detail={"message": "적재 가능한 시추공이 없습니다.", "issues": issues},
        )

    persist_rows = parsed_edited_rows or csv_ingest.to_persist_rows(boreholes)

    # provenance 용 job 레코드
    job = PdfExtractionJob(
        project_id=project_id,
        file_path=str(path),
        status=ExtractionJobStatus.AWAITING_REVIEW,
        result={
            "source": "csv",
            "mapping": cmap.to_dict(),
            "issues": issues,
            "idempotency_key": idempotency_key,
        },
        is_supplementary=is_supplementary,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    with SyncSessionLocal() as sync_db:
        try:
            created = PdfService().persist_rows(
                db=sync_db,
                rows=persist_rows,
                project_id=project_id,
                source_file=str(path),
                is_supplementary=is_supplementary,
                job_id=job.id,
            )
            sync_db.commit()
        except Exception as exc:  # noqa: BLE001
            sync_db.rollback()
            job.status = ExtractionJobStatus.FAILED
            job.error = str(exc)
            await db.commit()
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    result = dict(job.result or {})
    result.update(created)
    job.result = result
    job.status = ExtractionJobStatus.APPROVED
    await db.commit()

    return {"job_id": job.id, "status": job.status.value, "result": created, "issues": issues}
