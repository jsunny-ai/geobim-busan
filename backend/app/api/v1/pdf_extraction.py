"""PDF extraction API."""

from __future__ import annotations

import logging
import re
import shutil
import uuid
from pathlib import Path

import fitz
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.core.database import SyncSessionLocal
from app.models import (
    Borehole,
    ExtractionJobStatus,
    PdfExtractionJob,
    Project,
    ProjectMember,
    ProjectMemberRole,
    User,
)
from app.services.pdf_path_resolver import resolve_pdf_path
from app.services.pdf_service import PdfService
from app.workers.pdf_tasks import auto_extract_task

router = APIRouter()
logger = logging.getLogger(__name__)


def _run_extraction_background(job_id: int) -> None:
    """BackgroundTasks용 동기 PDF 추출 실행기.
    
    Redis/Celery 없이 로컬 개발 환경에서 사용합니다.
    FastAPI BackgroundTasks가 별도 스레드에서 호출하므로 HTTP 응답을 블록하지 않습니다.
    """
    with SyncSessionLocal() as db:
        job = db.get(PdfExtractionJob, job_id)
        if job is None:
            return
        try:
            project_name = db.execute(
                select(Project.name).where(Project.id == job.project_id)
            ).scalar_one()
            job.status = ExtractionJobStatus.RUNNING
            job.error = None
            db.commit()

            result = PdfService().preview_extraction(
                db=db,
                pdf_path=job.file_path,
                project_id=job.project_id,
                project_name=project_name,
            )
            job.result = result
            job.status = ExtractionJobStatus.AWAITING_REVIEW
            # [이상 PDF 자동분류] 전면실패 의심 시 경고 로그 + 결과에 플래그(검토 UI 노출용)
            quality = (result or {}).get("quality") or {}
            if quality.get("is_anomalous"):
                logger.warning(
                    "[추출품질] 이상 PDF 의심: %s | 사유: %s",
                    job.file_path, "; ".join(quality.get("reasons", [])),
                )
            db.commit()
        except Exception as exc:
            try:
                db.rollback()
            except Exception:
                pass
            with SyncSessionLocal() as db2:
                job2 = db2.get(PdfExtractionJob, job_id)
                if job2 is not None:
                    job2.error = str(exc)
                    job2.status = ExtractionJobStatus.FAILED
                    db2.commit()


_ALLOWED_EXTENSIONS = {".pdf", ".docx", ".hwpx"}


async def _require_upload_project(
    db: AsyncSession, project_id: int, current_user: User
) -> Project:
    project = await db.get(Project, project_id)
    if project is None or project.deleted_at is not None or project.lifecycle_status != "active":
        raise HTTPException(status_code=404, detail="활성 프로젝트를 찾을 수 없습니다.")
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


@router.post("/upload", status_code=status.HTTP_202_ACCEPTED)
async def upload_pdf(
    project_id: int = Form(...),
    pdf_file: UploadFile = File(...),
    is_supplementary: bool = Form(default=False),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Upload a source document and enqueue automatic extraction."""
    original_name = pdf_file.filename or "source.pdf"
    ext = Path(original_name).suffix.lower()
    if ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail="PDF, DOCX, HWPX 파일만 업로드할 수 있습니다.",
        )

    upload_root = _upload_root()
    request_id = uuid.uuid4().hex

    await _require_upload_project(db, project_id, current_user)

    target_dir = upload_root / request_id
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(original_name).stem).strip("._")
    safe_stem = safe_stem or "source"
    target_path = target_dir / f"{safe_stem}{ext}"

    with target_path.open("wb") as out:
        shutil.copyfileobj(pdf_file.file, out)

    job = PdfExtractionJob(
        project_id=project_id,
        file_path=str(target_path),
        status=ExtractionJobStatus.PENDING,
        result={"target_project_id": project_id},
        is_supplementary=is_supplementary,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    if settings.celery_task_always_eager:
        # Dev 모드: Redis 없이 백그라운드 스레드에서 즉시 실행 (응답 블록 없음)
        background_tasks.add_task(_run_extraction_background, job.id)
    else:
        # Prod 모드: Celery 큐에 위임
        try:
            async_result = auto_extract_task.delay(job.id)
            job.celery_task_id = async_result.id
            await db.commit()
        except Exception:
            # Celery 브로커 연결 실패 시 백그라운드 폴백
            background_tasks.add_task(_run_extraction_background, job.id)

    return {"job_id": job.id, "project_id": project_id, "status": "pending"}


@router.post("/manual/upload", status_code=status.HTTP_202_ACCEPTED)
async def upload_manual_pdf(
    project_id: int = Form(...),
    pdf_file: UploadFile = File(...),
    is_supplementary: bool = Form(default=False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Upload a PDF for manual box-based extraction."""
    original_name = pdf_file.filename or "source.pdf"
    ext = Path(original_name).suffix.lower()
    if ext != ".pdf":
        raise HTTPException(status_code=422, detail="직접 지정은 PDF 파일만 지원합니다.")

    upload_root = _upload_root()
    request_id = uuid.uuid4().hex

    await _require_upload_project(db, project_id, current_user)

    target_dir = upload_root / request_id
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(original_name).stem).strip("._")
    safe_stem = safe_stem or "source"
    target_path = target_dir / f"{safe_stem}.pdf"

    with target_path.open("wb") as out:
        shutil.copyfileobj(pdf_file.file, out)

    try:
        doc = fitz.open(target_path)
        page_count = len(doc)
        doc.close()
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"PDF를 열 수 없습니다: {exc}") from exc

    job = PdfExtractionJob(
        project_id=project_id,
        file_path=str(target_path),
        status=ExtractionJobStatus.PENDING,
        result={"manual": True, "target_project_id": project_id},
        is_supplementary=is_supplementary,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    return {
        "job_id": job.id,
        "status": job.status.value,
        "project_id": project_id,
        "page_count": page_count,
    }


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """Return extraction job status for polling."""
    job = await db.get(PdfExtractionJob, job_id)
    if job is None or job.deleted_at is not None:
        raise HTTPException(status_code=404, detail="추출 작업을 찾을 수 없습니다.")

    borehole_count = 0
    if job.status == ExtractionJobStatus.APPROVED:
        borehole_count = (
            await db.execute(
                select(func.count(Borehole.id)).where(
                    Borehole.project_id == job.project_id,
                    Borehole.source_file == job.file_path,
                    Borehole.deleted_at.is_(None),
                )
            )
        ).scalar_one()

    return {
        "id": job.id,
        "project_id": job.project_id,
        "status": job.status.value,
        "borehole_count": borehole_count,
        "result": job.result,
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


@router.get("/jobs/{job_id}/preview")
async def preview_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """Return extraction result preview."""
    job = await db.get(PdfExtractionJob, job_id)
    if job is None or job.deleted_at is not None:
        raise HTTPException(status_code=404, detail="추출 작업을 찾을 수 없습니다.")
    return {"id": job.id, "status": job.status.value, "result": job.result, "error": job.error}


@router.get("/jobs/{job_id}/pages/{page_number}.png")
async def render_job_page(
    job_id: int,
    page_number: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Response:
    """Render a PDF page as PNG for manual box drawing."""
    job = await db.get(PdfExtractionJob, job_id)
    if job is None or job.deleted_at is not None:
        raise HTTPException(status_code=404, detail="추출 작업을 찾을 수 없습니다.")
    if page_number < 1:
        raise HTTPException(status_code=422, detail="페이지 번호는 1 이상이어야 합니다.")

    try:
        pdf_path = resolve_pdf_path(job.file_path)
        if pdf_path is None or not pdf_path.exists():
            raise HTTPException(status_code=404, detail="원본 PDF 파일이 존재하지 않습니다.")
        doc = fitz.open(str(pdf_path))
        if page_number > len(doc):
            raise HTTPException(status_code=404, detail="페이지를 찾을 수 없습니다.")
        page = doc[page_number - 1]
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        png = pixmap.tobytes("png")
        doc.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"페이지 렌더링 실패: {exc}") from exc

    return Response(content=png, media_type="image/png")


@router.post("/jobs/{job_id}/extract-boxes")
async def extract_job_boxes(
    job_id: int,
    payload: dict,
    _current_user: User = Depends(get_current_user),
) -> dict:
    """Extract rows from user-drawn boxes and move the job to review."""
    box_definitions = payload.get("box_definitions") or {}
    if not box_definitions.get("boxes"):
        raise HTTPException(status_code=422, detail="추출할 박스가 없습니다.")

    with SyncSessionLocal() as sync_db:
        job = sync_db.get(PdfExtractionJob, job_id)
        if job is None or job.deleted_at is not None:
            raise HTTPException(status_code=404, detail="추출 작업을 찾을 수 없습니다.")

        try:
            project_name = sync_db.execute(
                select(Project.name).where(Project.id == job.project_id)
            ).scalar_one()
            service = PdfService()
            rows = service.extract_rows_with_template(
                job.file_path,
                box_definitions,
                project_name=project_name,
            )
            summary = {
                "borehole_count": len({str(row.get("시추공명") or "UNKNOWN") for row in rows}),
                "stratum_count": len(rows),
            }
            result = {
                "project_id": job.project_id,
                "project_name": project_name,
                "source_file": job.file_path,
                "box_definitions": box_definitions,
                "odl": service.last_odl_metadata,
                "ocr": service.last_manual_ocr_metadata,
                "rows": rows,
                **summary,
            }
            job.result = result
            job.error = None
            job.status = ExtractionJobStatus.AWAITING_REVIEW
            sync_db.commit()
            return {
                "id": job.id,
                "project_id": job.project_id,
                "status": job.status.value,
                "borehole_count": 0,
                "result": result,
                "error": None,
                "created_at": job.created_at.isoformat(),
                "updated_at": job.updated_at.isoformat(),
            }
        except ValueError as exc:
            sync_db.rollback()
            job = sync_db.get(PdfExtractionJob, job_id)
            if job is not None:
                job.status = ExtractionJobStatus.FAILED
                job.error = str(exc)
                sync_db.commit()
            raise HTTPException(status_code=400, detail=str(exc))
        except HTTPException:
            raise
        except Exception as exc:
            sync_db.rollback()
            job = sync_db.get(PdfExtractionJob, job_id)
            if job is not None:
                job.status = ExtractionJobStatus.FAILED
                job.error = str(exc)
                sync_db.commit()
            raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/approve")
async def approve_job(
    job_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """Mark an extracted job as approved."""
    job = await db.get(PdfExtractionJob, job_id)
    if job is None or job.deleted_at is not None:
        raise HTTPException(status_code=404, detail="추출 작업을 찾을 수 없습니다.")
    if job.status != ExtractionJobStatus.AWAITING_REVIEW:
        raise HTTPException(status_code=409, detail="승인 가능한 상태가 아닙니다.")

    if payload and "rows" in payload:
        result = dict(job.result or {})
        result["rows"] = payload["rows"]
        job.result = result
        db.add(job)
        await db.commit()
        await db.refresh(job)

    rows = (job.result or {}).get("rows") if job.result else None
    if not rows:
        raise HTTPException(status_code=409, detail="저장할 미리보기 데이터가 없습니다.")

    with SyncSessionLocal() as sync_db:
        try:
            created = PdfService().persist_rows(
                db=sync_db,
                rows=rows,
                project_id=job.project_id,
                source_file=job.file_path,
                is_supplementary=job.is_supplementary,
                job_id=job.id,
            )
            sync_db.commit()
        except Exception as exc:
            sync_db.rollback()
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    result = dict(job.result or {})
    result.pop("rows", None)
    result.update(created)
    job.result = result
    job.status = ExtractionJobStatus.APPROVED
    await db.commit()
    return {"id": job.id, "status": job.status.value, "result": job.result}


def _upload_root() -> Path:
    configured_dir = Path(settings.pdf_convert_data_dir)
    if not configured_dir.is_absolute():
        configured_dir = Path(__file__).resolve().parents[3] / configured_dir
    upload_root = configured_dir / "data" / "00_source" / "temp_uploads"
    upload_root.mkdir(parents=True, exist_ok=True)
    return upload_root
