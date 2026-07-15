"""시추공 라우터."""

import json
import re
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from geoalchemy2 import Geometry
from pydantic import BaseModel
from sqlalchemy import String, cast, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, get_db
from app.models import (
    Borehole,
    BoreholeRevision,
    PdfExtractionJob,
    Project,
    ProjectBoreholeLink,
    ProjectBoreholeOverride,
    Stratum,
    User,
)
from app.services.normalization import normalize_strata_group
from app.services.pdf_path_resolver import pdf_display_name, resolve_pdf_path
from app.services.groundwater import groundwater_payload, legacy_groundwater_depth

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic 스키마
# ---------------------------------------------------------------------------

class StratumCreate(BaseModel):
    depth_top: float
    depth_bottom: float
    soil_type: str
    raw_text: str | None = None
    n_value: float | None = None
    uscs_code: str | None = None


class BoreholeCreate(BaseModel):
    project_id: int
    name: str
    latitude: float
    longitude: float
    elevation: float | None = None
    source_crs: str | None = "EPSG:4326"
    strata: list[StratumCreate] = []
    is_supplementary: bool = False  # True=신규 보완, False=원본 기존


class StratumInput(BaseModel):
    depth_top: float
    depth_bottom: float
    soil_type: str
    raw_text: str | None = None
    n_value: float | None = None
    uscs_code: str | None = None


class BoreholeUpdate(BaseModel):
    name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    elevation: float | None = None
    project_id: int | None = None


class BoreholeOverrideUpdate(BoreholeUpdate):
    name: str | None = None
    strata: list[StratumInput] | None = None


class RevisionCreate(BaseModel):
    """[v4.2] 개정 저장 — 원본 불변, 새 버전으로 누적."""

    elevation: float | None = None
    groundwater_depth_bgl_m: float | None = None
    strata: list[StratumInput] | None = None
    reason: str


class RestoreRequest(BaseModel):
    """[v4.2] 버전 복원 — 해당 버전 스냅샷을 복사한 새 버전 생성."""

    version: int
    reason: str | None = None
    status: str = "draft"


class ByAreaRequest(BaseModel):
    polygon: dict
    project_id: int | None = None
    include_strata: bool = False
    borehole_ids: list[int] | None = None


class DuplicateMergeRequest(BaseModel):
    mode: str = "exact"


class BoreholeMergeRequest(BaseModel):
    keep_id: int
    duplicate_ids: list[int]


# ---------------------------------------------------------------------------
# 내부 헬퍼
# ---------------------------------------------------------------------------

def _loc_to_lng_lat(loc_json: str | None) -> tuple[float, float]:
    if not loc_json:
        return 0.0, 0.0
    coords = json.loads(loc_json)["coordinates"]
    return coords[0], coords[1]


def _borehole_dict(b: Borehole, loc_json: str | None, *, include_strata: bool = False) -> dict:
    lng, lat = _loc_to_lng_lat(loc_json)
    data: dict = {
        "id": b.id,
        "project_id": b.project_id,
        "name": b.name,
        "longitude": lng,
        "latitude": lat,
        "elevation": b.elevation,
        "source_crs": b.source_crs,
        "source_file": b.source_file,
        "survey_name": getattr(b, "survey_name", None),
        "data_origin": getattr(b, "data_origin", "public"),
        "is_supplementary": getattr(b, "is_supplementary", False),
        "data_status": "supplementary" if getattr(b, "is_supplementary", False) else "original",
        "project_role": None,
        "linked_reason": None,
        "source_borehole_id": None,
        "override_id": None,
        "created_at": b.created_at.isoformat(),
    }
    if include_strata and hasattr(b, "strata"):
        data["strata"] = sorted(
            [_stratum_dict(s) for s in b.strata],
            key=lambda x: x["depth_top"],
        )
        data.update(groundwater_payload(b))
    return data


_GROUNDWATER_DEPTH_RE = re.compile(
    r"(?:지하수위|water[_\s-]*(?:level|gl))['\"]?\s*[:=]\s*['\"]?\s*"
    r"(?:GL\s*[-(]?\s*)?(-?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_GROUNDWATER_MISSING_RE = re.compile(
    r"(?:지하수위|water[_\s-]*(?:level|gl))['\"]?\s*[:=]\s*['\"]?\s*"
    r"(?:N/?A|NONE|NULL|-)(?:['\",}\s]|$)",
    re.IGNORECASE,
)


def _legacy_groundwater_depth(strata: list[Stratum]) -> float | None:
    """Recover representative GL(-) groundwater depth from legacy raw_text.

    Missing values remain None and therefore never become interpolation anchors.
    """
    return legacy_groundwater_depth(strata)


def _stratum_dict(s: Stratum) -> dict:
    return {
        "id": s.id,
        "borehole_id": s.borehole_id,
        "depth_top": s.depth_top,
        "depth_bottom": s.depth_bottom,
        "soil_type": s.soil_type,
        "strata_group": normalize_strata_group(s.soil_type),
        "raw_text": s.raw_text,
        "n_value": s.n_value,
        "uscs_code": s.uscs_code,
    }


def _stratum_payload_dict(s: dict, index: int) -> dict:
    soil_type = s.get("soil_type") or "미분류"
    return {
        "id": s.get("id") or -(index + 1),
        "borehole_id": s.get("borehole_id") or 0,
        "depth_top": float(s.get("depth_top") or 0),
        "depth_bottom": float(s.get("depth_bottom") or 0),
        "soil_type": soil_type,
        "strata_group": normalize_strata_group(soil_type),
        "raw_text": s.get("raw_text"),
        "n_value": s.get("n_value"),
        "uscs_code": s.get("uscs_code"),
    }


def _parse_bbox_filter(bbox: str | None) -> tuple[float, float, float, float] | None:
    if not bbox:
        return None
    try:
        parts = [float(part.strip()) for part in bbox.split(",")]
    except ValueError:
        raise HTTPException(status_code=422, detail="bbox must be minLng,minLat,maxLng,maxLat")
    if len(parts) != 4:
        raise HTTPException(status_code=422, detail="bbox must be minLng,minLat,maxLng,maxLat")
    min_lng, min_lat, max_lng, max_lat = parts
    if min_lng > max_lng or min_lat > max_lat:
        raise HTTPException(status_code=422, detail="bbox min values must be less than max values")
    return min_lng, min_lat, max_lng, max_lat


async def _latest_revision(db: AsyncSession, borehole_id: int) -> BoreholeRevision | None:
    """[v4.2] 최신 활성 개정 1건."""
    return (await db.execute(
        select(BoreholeRevision)
        .where(
            BoreholeRevision.borehole_id == borehole_id,
            BoreholeRevision.deleted_at.is_(None),
        )
        .order_by(BoreholeRevision.version.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _latest_revision_map(db: AsyncSession, borehole_ids: list[int]) -> dict[int, BoreholeRevision]:
    """[v4.2] 시추공별 최신 개정 일괄 조회."""
    if not borehole_ids:
        return {}
    rows = (await db.execute(
        select(BoreholeRevision)
        .where(
            BoreholeRevision.borehole_id.in_(borehole_ids),
            BoreholeRevision.deleted_at.is_(None),
        )
        .order_by(BoreholeRevision.borehole_id, BoreholeRevision.version)
    )).scalars().all()
    latest: dict[int, BoreholeRevision] = {}
    for rv in rows:
        latest[rv.borehole_id] = rv  # 버전 오름차순 정렬 → 마지막이 최신
    return latest


def _finite_float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _reconcile_groundwater_with_effective_elevation(data: dict) -> None:
    elevation = _finite_float(data.get("elevation"))
    if elevation is None:
        return

    depth = _finite_float(data.get("groundwater_depth_bgl_m"))
    head = _finite_float(data.get("groundwater_head_elevation_m"))
    datum = str(data.get("groundwater_reference_datum") or "GL").upper()

    if datum == "EL":
        if head is not None:
            data["groundwater_depth_bgl_m"] = elevation - head
        elif depth is not None:
            data["groundwater_head_elevation_m"] = elevation - depth
        return

    if depth is not None:
        data["groundwater_head_elevation_m"] = elevation - depth
    elif head is not None:
        data["groundwater_depth_bgl_m"] = elevation - head


def _apply_revision(data: dict, rev: BoreholeRevision) -> dict:
    """[v4.2] 개정 payload(완전 스냅샷)를 원본 dict에 적용 → effective 값.

    원본 테이블은 건드리지 않는다. 응답에만 최신 버전을 반영하고
    data_status="revised" + revision_version 으로 표시한다.
    """
    payload = rev.payload or {}
    if payload.get("elevation") is not None:
        data["elevation"] = payload["elevation"]
    if "groundwater_depth_bgl_m" in payload:
        data["groundwater_depth_bgl_m"] = payload["groundwater_depth_bgl_m"]
        data["groundwater_reference_datum"] = payload.get("groundwater_reference_datum") or "GL"
        if payload["groundwater_depth_bgl_m"] is None:
            data["groundwater_head_elevation_m"] = None
    if payload.get("strata") is not None and "strata" in data:
        applied = [_stratum_payload_dict(item, idx) for idx, item in enumerate(payload["strata"])]
        applied.sort(key=lambda x: x["depth_top"])
        data["strata"] = applied
    _reconcile_groundwater_with_effective_elevation(data)
    data["data_status"] = "revised"
    data["revision_version"] = rev.version
    return data


def _original_snapshot(b: Borehole) -> dict:
    """[v4.2] 원본(v0) 스냅샷 — strata 는 RevisionCreate.strata 와 동일 형태."""
    return {
        "elevation": b.elevation,
        "strata": [
            {
                "depth_top": st.depth_top,
                "depth_bottom": st.depth_bottom,
                "soil_type": st.soil_type,
                "raw_text": st.raw_text,
                "n_value": st.n_value,
                "uscs_code": st.uscs_code,
            }
            for st in sorted(b.strata, key=lambda x: x.depth_top)
        ],
    }


def _revision_dict(rev: BoreholeRevision) -> dict:
    return {
        "version": rev.version,
        "payload": rev.payload,
        "reason": rev.reason,
        "edited_by_id": rev.edited_by_id,
        "restored_from": rev.restored_from,
        "created_at": rev.created_at.isoformat() if rev.created_at else None,
    }


def _apply_project_override(
    source: Borehole,
    loc_json: str | None,
    override: ProjectBoreholeOverride,
) -> dict:
    data = _borehole_dict(source, loc_json, include_strata=True)
    payload = override.data or {}
    data.update(
        {
            "project_id": override.project_id,
            "source_borehole_id": source.id,
            "data_status": f"modified_{override.status}",
            "override_id": override.id,
            "name": payload.get("name", data["name"]),
            "longitude": payload.get("longitude", data["longitude"]),
            "latitude": payload.get("latitude", data["latitude"]),
            "elevation": payload.get("elevation", data["elevation"]),
            "is_supplementary": False,
        }
    )
    if isinstance(payload.get("strata"), list):
        data["strata"] = [
            _stratum_payload_dict({**s, "borehole_id": source.id}, index)
            for index, s in enumerate(payload["strata"])
        ]
    return data


# ---------------------------------------------------------------------------
# POST / — 시추공 직접 생성
# ---------------------------------------------------------------------------

@router.post("/", status_code=201)
async def create_borehole(
    body: BoreholeCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """수동 입력으로 시추공 + 지층을 직접 생성합니다."""
    for s in body.strata:
        if s.depth_bottom <= s.depth_top:
            raise HTTPException(
                status_code=422,
                detail=f"depth_bottom({s.depth_bottom}) > depth_top({s.depth_top}) 이어야 합니다.",
            )

    borehole = Borehole(
        project_id=body.project_id,
        name=body.name,
        elevation=body.elevation,
        source_crs=body.source_crs or "EPSG:4326",
        location=func.ST_SetSRID(func.ST_MakePoint(body.longitude, body.latitude), 4326),
        is_supplementary=body.is_supplementary,
        data_origin="manual_input" if body.is_supplementary else "public",
    )
    db.add(borehole)
    await db.flush()

    db.add(ProjectBoreholeLink(
        project_id=body.project_id,
        borehole_id=borehole.id,
        project_role="new" if body.is_supplementary else "existing",
        linked_reason="manual_created" if body.is_supplementary else "migrated",
    ))

    if body.strata:
        db.add_all([
            Stratum(
                borehole_id=borehole.id,
                depth_top=s.depth_top,
                depth_bottom=s.depth_bottom,
                soil_type=s.soil_type,
                raw_text=s.raw_text,
                n_value=s.n_value,
                uscs_code=s.uscs_code,
            )
            for s in body.strata
        ])

    await db.commit()

    loc_result = await db.execute(
        select(func.ST_AsGeoJSON(Borehole.location)).where(Borehole.id == borehole.id)
    )
    bh_result = await db.execute(
        select(Borehole).options(selectinload(Borehole.strata)).where(Borehole.id == borehole.id)
    )
    return _borehole_dict(bh_result.scalar_one(), loc_result.scalar(), include_strata=True)


# ---------------------------------------------------------------------------
# GET / — 시추공 목록
# ---------------------------------------------------------------------------

@router.get("/")
async def list_boreholes(
    project_id: int | None = None,
    ids: str | None = Query(None),
    bbox: str | None = Query(None),
    q: str | None = Query(None, max_length=200),
    data_origin: str | None = Query(None, max_length=50),
    include_strata: bool = Query(False),
    limit: int = Query(10000, ge=1, le=50000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    base_stmt = select(
        Borehole,
        func.ST_AsGeoJSON(Borehole.location).label("loc_json"),
    ).where(Borehole.deleted_at.is_(None))

    id_filter: list[int] | None = None
    if ids:
        try:
            id_filter = [int(part) for part in ids.split(",") if part.strip()]
        except ValueError:
            raise HTTPException(status_code=422, detail="ids must be a comma-separated list of integers")
        if id_filter:
            base_stmt = base_stmt.where(Borehole.id.in_(id_filter))

    if project_id is not None:
        base_stmt = base_stmt.where(Borehole.project_id == project_id)

    if q and (needle := q.strip()):
        pattern = f"%{needle}%"
        base_stmt = base_stmt.where(
            Borehole.name.ilike(pattern)
            | Borehole.source_file.ilike(pattern)
            | Borehole.source_crs.ilike(pattern)
            | func.cast(Borehole.id, String).ilike(pattern)
            | func.cast(Borehole.project_id, String).ilike(pattern)
        )

    if data_origin and data_origin != "all":
        base_stmt = base_stmt.where(Borehole.data_origin == data_origin)

    bbox_filter = _parse_bbox_filter(bbox)
    if bbox_filter is not None:
        min_lng, min_lat, max_lng, max_lat = bbox_filter
        envelope = func.ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
        base_stmt = base_stmt.where(func.ST_Intersects(cast(Borehole.location, Geometry), envelope))

    count_stmt = select(func.count()).select_from(base_stmt.subquery())
    total: int = (await db.execute(count_stmt)).scalar_one()

    if include_strata:
        ids_stmt = (
            select(Borehole.id)
            .where(Borehole.deleted_at.is_(None))
        )
        if id_filter:
            ids_stmt = ids_stmt.where(Borehole.id.in_(id_filter))
        if project_id is not None:
            ids_stmt = ids_stmt.where(Borehole.project_id == project_id)
        if q and (needle := q.strip()):
            pattern = f"%{needle}%"
            ids_stmt = ids_stmt.where(
                Borehole.name.ilike(pattern)
                | Borehole.source_file.ilike(pattern)
                | Borehole.source_crs.ilike(pattern)
                | func.cast(Borehole.id, String).ilike(pattern)
                | func.cast(Borehole.project_id, String).ilike(pattern)
            )
        if data_origin and data_origin != "all":
            ids_stmt = ids_stmt.where(Borehole.data_origin == data_origin)
        if bbox_filter is not None:
            min_lng, min_lat, max_lng, max_lat = bbox_filter
            envelope = func.ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
            ids_stmt = ids_stmt.where(func.ST_Intersects(cast(Borehole.location, Geometry), envelope))
        ids_stmt = ids_stmt.order_by(Borehole.id.desc()).limit(limit).offset(offset)

        orm_stmt = (
            select(Borehole)
            .options(selectinload(Borehole.strata))
            .where(Borehole.id.in_(ids_stmt), Borehole.deleted_at.is_(None))
        )
        boreholes_orm = (await db.execute(orm_stmt)).scalars().all()

        loc_stmt = select(
            Borehole.id,
            func.ST_AsGeoJSON(Borehole.location).label("loc_json"),
        ).where(Borehole.id.in_([b.id for b in boreholes_orm]))
        loc_map: dict[int, str] = {
            row.id: row.loc_json
            for row in (await db.execute(loc_stmt)).all()
        }
        boreholes_list = [
            _borehole_dict(b, loc_map.get(b.id), include_strata=True)
            for b in boreholes_orm
        ]
    else:
        rows = (await db.execute(
            base_stmt.order_by(Borehole.id.desc()).limit(limit).offset(offset)
        )).all()
        boreholes_list = [_borehole_dict(b, loc) for b, loc in rows]

    # [v4.2] 개정(Revision) 적용 — 원본 불변, 최신 버전을 effective 로 반환
    latest_revs = await _latest_revision_map(db, [d["id"] for d in boreholes_list])
    for d in boreholes_list:
        rv = latest_revs.get(d["id"])
        if rv is not None:
            _apply_revision(d, rv)

    return {
        "boreholes": boreholes_list,
        "count": len(boreholes_list),
        "total": total,
        "limit": limit,
        "offset": offset,
    }


# ---------------------------------------------------------------------------
# GET /{borehole_id}
# ---------------------------------------------------------------------------

@router.get("/{borehole_id}")
async def get_borehole(
    borehole_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    result = await db.execute(
        select(Borehole)
        .options(selectinload(Borehole.strata))
        .where(Borehole.id == borehole_id, Borehole.deleted_at.is_(None))
    )
    borehole = result.scalar_one_or_none()
    if borehole is None:
        raise HTTPException(status_code=404, detail="시추공을 찾을 수 없습니다.")

    loc_result = await db.execute(
        select(func.ST_AsGeoJSON(Borehole.location)).where(Borehole.id == borehole_id)
    )
    data = _borehole_dict(borehole, loc_result.scalar(), include_strata=True)

    # [v4.2] 개정 적용 (원본 불변)
    rev = await _latest_revision(db, borehole_id)
    if rev is not None:
        _apply_revision(data, rev)
    return data


# ---------------------------------------------------------------------------
# [v4.2] 개정(Revision) — 원본 불변 버전 이력
# ---------------------------------------------------------------------------

async def _get_active_borehole(db: AsyncSession, borehole_id: int, *, with_strata: bool = False) -> Borehole:
    stmt = select(Borehole).where(Borehole.id == borehole_id, Borehole.deleted_at.is_(None))
    if with_strata:
        stmt = stmt.options(selectinload(Borehole.strata))
    borehole = (await db.execute(stmt)).scalar_one_or_none()
    if borehole is None:
        raise HTTPException(status_code=404, detail="시추공을 찾을 수 없습니다.")
    return borehole


@router.post("/{borehole_id}/revisions", status_code=201)
async def create_borehole_revision(
    borehole_id: int,
    body: RevisionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """수정 저장 — 원본은 변경하지 않고 새 버전으로 누적."""
    reason = (body.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=422, detail="수정 사유(reason)는 필수입니다.")

    await _get_active_borehole(db, borehole_id)

    payload: dict = {}
    if body.elevation is not None:
        payload["elevation"] = body.elevation
    if "groundwater_depth_bgl_m" in body.model_fields_set:
        payload["groundwater_depth_bgl_m"] = body.groundwater_depth_bgl_m
        payload["groundwater_reference_datum"] = "GL"
    if body.strata is not None:
        payload["strata"] = [item.model_dump() for item in body.strata]
    if not payload:
        raise HTTPException(status_code=422, detail="변경 내용이 없습니다.")

    last = await _latest_revision(db, borehole_id)
    next_version = (last.version if last else 0) + 1
    rev = BoreholeRevision(
        borehole_id=borehole_id,
        version=next_version,
        payload=payload,
        reason=reason,
        edited_by_id=getattr(current_user, "id", None),
    )
    db.add(rev)
    await db.commit()
    return {"borehole_id": borehole_id, "version": next_version}


@router.get("/{borehole_id}/revisions")
async def list_borehole_revisions(
    borehole_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """버전 타임라인 — v0(원본) 포함 전체 이력."""
    borehole = await _get_active_borehole(db, borehole_id, with_strata=True)
    revs = (await db.execute(
        select(BoreholeRevision)
        .where(
            BoreholeRevision.borehole_id == borehole_id,
            BoreholeRevision.deleted_at.is_(None),
        )
        .order_by(BoreholeRevision.version)
    )).scalars().all()

    timeline = [{
        "version": 0,
        "payload": _original_snapshot(borehole),
        "reason": "원본 (PDF 추출)",
        "edited_by_id": None,
        "restored_from": None,
        "created_at": borehole.created_at.isoformat() if borehole.created_at else None,
    }]
    timeline.extend(_revision_dict(rv) for rv in revs)
    return {
        "borehole_id": borehole_id,
        "current_version": revs[-1].version if revs else 0,
        "revisions": timeline,
    }


@router.get("/{borehole_id}/revisions/{version}")
async def get_borehole_revision(
    borehole_id: int,
    version: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """특정 버전 스냅샷 열람 (0 = 원본)."""
    borehole = await _get_active_borehole(db, borehole_id, with_strata=True)
    if version == 0:
        return {
            "version": 0,
            "payload": _original_snapshot(borehole),
            "reason": "원본 (PDF 추출)",
            "created_at": borehole.created_at.isoformat() if borehole.created_at else None,
        }
    rev = (await db.execute(
        select(BoreholeRevision).where(
            BoreholeRevision.borehole_id == borehole_id,
            BoreholeRevision.version == version,
            BoreholeRevision.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if rev is None:
        raise HTTPException(status_code=404, detail=f"v{version} 개정을 찾을 수 없습니다.")
    return _revision_dict(rev)


@router.post("/{borehole_id}/restore", status_code=201)
async def restore_borehole_revision(
    borehole_id: int,
    body: RestoreRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """이력 보존형 복원 — 대상 버전 스냅샷을 복사한 '새 버전' 생성 (0 = 원본)."""
    borehole = await _get_active_borehole(db, borehole_id, with_strata=True)

    if body.version == 0:
        payload = _original_snapshot(borehole)
    else:
        src = (await db.execute(
            select(BoreholeRevision).where(
                BoreholeRevision.borehole_id == borehole_id,
                BoreholeRevision.version == body.version,
                BoreholeRevision.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if src is None:
            raise HTTPException(status_code=404, detail=f"v{body.version} 개정을 찾을 수 없습니다.")
        payload = dict(src.payload or {})

    last = await _latest_revision(db, borehole_id)
    next_version = (last.version if last else 0) + 1
    rev = BoreholeRevision(
        borehole_id=borehole_id,
        version=next_version,
        payload=payload,
        reason=(body.reason or "").strip() or f"v{body.version}(으)로 복원",
        edited_by_id=getattr(current_user, "id", None),
        restored_from=body.version,
    )
    db.add(rev)
    await db.commit()
    return {"borehole_id": borehole_id, "version": next_version, "restored_from": body.version}


@router.get("/{borehole_id}/source-pdf")
async def get_borehole_source_pdf(
    borehole_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """[v4.2] 시추공 → 원본 PDF job 역조회 (PDF 대조 패널용)."""
    borehole = await _get_active_borehole(db, borehole_id)
    if not borehole.source_file:
        raise HTTPException(status_code=404, detail="원본 PDF 정보가 없습니다 (수기 입력).")

    job = (await db.execute(
        select(PdfExtractionJob)
        .where(PdfExtractionJob.file_path == borehole.source_file)
        .order_by(PdfExtractionJob.id.desc())
        .limit(1)
    )).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="원본 PDF 추출 작업을 찾을 수 없습니다.")
    pdf_path = resolve_pdf_path(job.file_path)
    if pdf_path is None or not pdf_path.exists():
        raise HTTPException(status_code=404, detail="원본 PDF 파일이 존재하지 않습니다.")

    try:
        import fitz  # PyMuPDF

        doc = fitz.open(str(pdf_path))
        page_count = doc.page_count
        import re as _re

        def _norm(t: str) -> str:
            t = (t or "").lower()
            for _d in "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe63\uff0d":
                t = t.replace(_d, "-")
            return _re.sub(r"\s+", "", t)

        match_pages: list[int] = []
        needle = _norm(borehole.name or "")
        if needle:
            for i in range(page_count):
                try:
                    if needle in _norm(doc[i].get_text("text")):
                        match_pages.append(i + 1)
                except Exception:  # noqa: BLE001
                    continue
        doc.close()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"PDF 열기 실패: {exc}")

    return {
        "job_id": job.id,
        "page_count": page_count,
        "file_name": pdf_display_name(job.file_path),
        "borehole_name": borehole.name,
        "match_pages": match_pages,
    }


# ---------------------------------------------------------------------------
# PATCH /{borehole_id}
# ---------------------------------------------------------------------------

@router.patch("/{borehole_id}")
async def update_borehole(
    borehole_id: int,
    body: BoreholeUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    result = await db.execute(
        select(Borehole).where(Borehole.id == borehole_id, Borehole.deleted_at.is_(None))
    )
    borehole = result.scalar_one_or_none()
    if borehole is None:
        raise HTTPException(status_code=404, detail="시추공을 찾을 수 없습니다.")

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="시추공명은 비워둘 수 없습니다.")
        borehole.name = name

    if body.latitude is not None or body.longitude is not None:
        loc_result = await db.execute(
            select(func.ST_AsGeoJSON(Borehole.location)).where(Borehole.id == borehole_id)
        )
        cur_lng, cur_lat = _loc_to_lng_lat(loc_result.scalar())
        new_lng = body.longitude if body.longitude is not None else cur_lng
        new_lat = body.latitude if body.latitude is not None else cur_lat
        borehole.location = func.ST_SetSRID(func.ST_MakePoint(new_lng, new_lat), 4326)

    if body.elevation is not None:
        borehole.elevation = body.elevation

    if body.project_id is not None and body.project_id != borehole.project_id:
        target = (await db.execute(
            select(Project).where(Project.id == body.project_id, Project.deleted_at.is_(None))
        )).scalar_one_or_none()
        if target is None:
            raise HTTPException(status_code=404, detail="대상 프로젝트를 찾을 수 없습니다.")
        borehole.project_id = body.project_id

    await db.commit()
    await db.refresh(borehole)

    loc_result = await db.execute(
        select(func.ST_AsGeoJSON(Borehole.location)).where(Borehole.id == borehole_id)
    )
    return _borehole_dict(borehole, loc_result.scalar())


# ---------------------------------------------------------------------------
# PUT /{borehole_id}/strata
# ---------------------------------------------------------------------------

@router.put("/{borehole_id}/strata")
async def replace_strata(
    borehole_id: int,
    strata: list[StratumInput],
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[dict]:
    result = await db.execute(
        select(Borehole).where(Borehole.id == borehole_id, Borehole.deleted_at.is_(None))
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="시추공을 찾을 수 없습니다.")

    for s in strata:
        if s.depth_bottom <= s.depth_top:
            raise HTTPException(
                status_code=422,
                detail=f"depth_bottom({s.depth_bottom}) > depth_top({s.depth_top}) 이어야 합니다.",
            )

    await db.execute(delete(Stratum).where(Stratum.borehole_id == borehole_id))

    new_strata = [
        Stratum(
            borehole_id=borehole_id,
            depth_top=s.depth_top,
            depth_bottom=s.depth_bottom,
            soil_type=s.soil_type,
            raw_text=s.raw_text,
            n_value=s.n_value,
            uscs_code=s.uscs_code,
        )
        for s in strata
    ]
    db.add_all(new_strata)
    await db.commit()
    for s in new_strata:
        await db.refresh(s)

    return sorted([_stratum_dict(s) for s in new_strata], key=lambda x: x["depth_top"])


@router.delete("/{borehole_id}")
async def delete_borehole(
    borehole_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    if _current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 시추공을 삭제할 수 있습니다.")

    result = await db.execute(
        select(Borehole).where(Borehole.id == borehole_id, Borehole.deleted_at.is_(None))
    )
    borehole = result.scalar_one_or_none()
    if borehole is None:
        raise HTTPException(status_code=404, detail="시추공을 찾을 수 없습니다.")

    borehole.deleted_at = func.now()
    await db.execute(
        ProjectBoreholeLink.__table__.update()
        .where(
            ProjectBoreholeLink.borehole_id == borehole_id,
            ProjectBoreholeLink.deleted_at.is_(None),
        )
        .values(deleted_at=func.now())
    )
    await db.commit()
    return {"ok": True, "id": borehole_id}


def _strata_signature(strata: list[Stratum]) -> tuple:
    return tuple(
        (
            round(float(s.depth_top), 4),
            round(float(s.depth_bottom), 4),
            s.soil_type or "",
        )
        for s in sorted(strata, key=lambda item: (item.depth_top, item.depth_bottom, item.soil_type or ""))
        if s.deleted_at is None
    )


def _duplicate_key(borehole: Borehole, loc_json: str | None) -> tuple:
    lng, lat = _loc_to_lng_lat(loc_json)
    return borehole.name, round(lng, 7), round(lat, 7)


def _coordinate_key(_borehole: Borehole, loc_json: str | None) -> tuple:
    lng, lat = _loc_to_lng_lat(loc_json)
    return round(lng, 7), round(lat, 7)


def _duplicate_item(borehole: Borehole, loc_json: str | None) -> dict:
    lng, lat = _loc_to_lng_lat(loc_json)
    return {
        "id": borehole.id,
        "name": borehole.name,
        "project_id": borehole.project_id,
        "longitude": lng,
        "latitude": lat,
        "elevation": borehole.elevation,
        "data_origin": borehole.data_origin,
        "source_file": borehole.source_file,
        "strata_count": len([s for s in borehole.strata if s.deleted_at is None]),
        "max_depth": max([s.depth_bottom for s in borehole.strata if s.deleted_at is None], default=None),
    }


async def _load_duplicate_groups(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(
            Borehole,
            func.ST_AsGeoJSON(Borehole.location).label("loc_json"),
        )
        .options(selectinload(Borehole.strata))
        .where(Borehole.deleted_at.is_(None))
    )).all()

    grouped: dict[tuple, list[tuple[Borehole, str | None]]] = defaultdict(list)
    coord_grouped: dict[tuple, list[tuple[Borehole, str | None]]] = defaultdict(list)
    for borehole, loc_json in rows:
        grouped[_duplicate_key(borehole, loc_json)].append((borehole, loc_json))
        coord_grouped[_coordinate_key(borehole, loc_json)].append((borehole, loc_json))

    duplicate_groups: list[dict] = []
    handled_ids: set[int] = set()
    for (name, lng, lat), members in grouped.items():
        if len(members) < 2:
            continue

        signatures = {
            (
                None if borehole.elevation is None else round(float(borehole.elevation), 4),
                _strata_signature(borehole.strata),
            )
            for borehole, _loc_json in members
        }
        is_exact = len(signatures) == 1
        items = [_duplicate_item(borehole, loc_json) for borehole, loc_json in members]
        handled_ids.update(item["id"] for item in items)
        duplicate_groups.append({
            "key": {"name": name, "longitude": lng, "latitude": lat},
            "duplicate_type": "exact" if is_exact else "conflict",
            "count": len(items),
            "keep_id": min(item["id"] for item in items),
            "items": sorted(items, key=lambda item: item["id"]),
        })

    for (lng, lat), members in coord_grouped.items():
        active_members = [
            (borehole, loc_json)
            for borehole, loc_json in members
            if borehole.id not in handled_ids
        ]
        if len(active_members) < 2:
            continue
        names = {borehole.name for borehole, _loc_json in active_members}
        if len(names) < 2:
            continue

        items = [_duplicate_item(borehole, loc_json) for borehole, loc_json in active_members]
        duplicate_groups.append({
            "key": {
                "name": " / ".join(sorted(names)),
                "longitude": lng,
                "latitude": lat,
            },
            "duplicate_type": "coordinate_conflict",
            "count": len(items),
            "keep_id": min(item["id"] for item in items),
            "items": sorted(items, key=lambda item: item["id"]),
        })

    order = {"conflict": 0, "coordinate_conflict": 1, "exact": 2}
    duplicate_groups.sort(key=lambda group: (order.get(group["duplicate_type"], 9), -group["count"], group["key"]["name"]))
    return duplicate_groups


@router.get("/admin/duplicates")
async def list_duplicate_boreholes(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    if _current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 중복 시추공을 조회할 수 있습니다.")

    groups = await _load_duplicate_groups(db)
    exact_groups = [group for group in groups if group["duplicate_type"] == "exact"]
    conflict_groups = [group for group in groups if group["duplicate_type"] == "conflict"]
    coordinate_conflict_groups = [group for group in groups if group["duplicate_type"] == "coordinate_conflict"]
    return {
        "groups": groups,
        "summary": {
            "groups": len(groups),
            "exact_groups": len(exact_groups),
            "conflict_groups": len(conflict_groups),
            "coordinate_conflict_groups": len(coordinate_conflict_groups),
            "duplicate_rows": sum(group["count"] for group in groups),
            "removable_rows": sum(group["count"] - 1 for group in exact_groups),
        },
    }


async def _replace_project_bbox_ids(db: AsyncSession, id_map: dict[int, int]) -> int:
    projects = (await db.execute(
        select(Project).where(Project.deleted_at.is_(None), Project.bbox.is_not(None))
    )).scalars().all()
    changed = 0
    for project in projects:
        if not isinstance(project.bbox, dict):
            continue
        raw_ids = project.bbox.get("borehole_ids")
        if not isinstance(raw_ids, list):
            continue
        next_ids: list[int] = []
        seen: set[int] = set()
        touched = False
        for value in raw_ids:
            try:
                borehole_id = int(value)
            except (TypeError, ValueError):
                continue
            mapped_id = id_map.get(borehole_id, borehole_id)
            touched = touched or mapped_id != borehole_id
            if mapped_id not in seen:
                next_ids.append(mapped_id)
                seen.add(mapped_id)
            else:
                touched = True
        if touched:
            project.bbox = {**project.bbox, "borehole_ids": next_ids}
            changed += 1
    return changed


async def _merge_duplicate_boreholes(db: AsyncSession, keep_id: int, duplicate_ids: list[int]) -> dict:
    if not duplicate_ids:
        return {"removed": 0, "links_updated": 0, "links_deleted": 0}

    links = (await db.execute(
        select(ProjectBoreholeLink).where(
            ProjectBoreholeLink.borehole_id.in_([keep_id, *duplicate_ids]),
            ProjectBoreholeLink.deleted_at.is_(None),
        )
    )).scalars().all()

    keep_projects = {link.project_id for link in links if link.borehole_id == keep_id}
    links_updated = 0
    links_deleted = 0
    for link in links:
        if link.borehole_id == keep_id:
            continue
        if link.project_id in keep_projects:
            link.deleted_at = func.now()
            links_deleted += 1
        else:
            link.borehole_id = keep_id
            keep_projects.add(link.project_id)
            links_updated += 1

    overrides = (await db.execute(
        select(ProjectBoreholeOverride).where(
            ProjectBoreholeOverride.source_borehole_id.in_(duplicate_ids),
            ProjectBoreholeOverride.deleted_at.is_(None),
        )
    )).scalars().all()
    keep_override_projects = {
        row.project_id for row in (await db.execute(
            select(ProjectBoreholeOverride.project_id).where(
                ProjectBoreholeOverride.source_borehole_id == keep_id,
                ProjectBoreholeOverride.deleted_at.is_(None),
            )
        )).all()
    }
    overrides_updated = 0
    overrides_deleted = 0
    for override in overrides:
        if override.project_id in keep_override_projects:
            override.deleted_at = func.now()
            overrides_deleted += 1
        else:
            override.source_borehole_id = keep_id
            keep_override_projects.add(override.project_id)
            overrides_updated += 1

    await db.execute(
        Borehole.__table__.update()
        .where(Borehole.id.in_(duplicate_ids), Borehole.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
    return {
        "removed": len(duplicate_ids),
        "links_updated": links_updated,
        "links_deleted": links_deleted,
        "overrides_updated": overrides_updated,
        "overrides_deleted": overrides_deleted,
    }


@router.post("/admin/duplicates/merge-exact")
async def merge_exact_duplicate_boreholes(
    body: DuplicateMergeRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    if _current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 중복 시추공을 정리할 수 있습니다.")
    if body.mode != "exact":
        raise HTTPException(status_code=422, detail="지원되는 mode는 exact 뿐입니다.")

    groups = await _load_duplicate_groups(db)
    exact_groups = [group for group in groups if group["duplicate_type"] == "exact"]
    id_map: dict[int, int] = {}
    result = {
        "groups_merged": 0,
        "removed": 0,
        "links_updated": 0,
        "links_deleted": 0,
        "overrides_updated": 0,
        "overrides_deleted": 0,
        "projects_bbox_updated": 0,
    }

    for group in exact_groups:
        keep_id = int(group["keep_id"])
        duplicate_ids = [int(item["id"]) for item in group["items"] if int(item["id"]) != keep_id]
        for duplicate_id in duplicate_ids:
            id_map[duplicate_id] = keep_id
        merged = await _merge_duplicate_boreholes(db, keep_id, duplicate_ids)
        result["groups_merged"] += 1
        for key in ("removed", "links_updated", "links_deleted", "overrides_updated", "overrides_deleted"):
            result[key] += int(merged.get(key, 0))

    result["projects_bbox_updated"] = await _replace_project_bbox_ids(db, id_map)
    await db.commit()
    return result


@router.post("/admin/merge")
async def merge_selected_boreholes(
    body: BoreholeMergeRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """선택한 시추공을 대표(keep_id)로 병합 — 링크/override/bbox 이관 후 나머지 삭제."""
    if _current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 시추공을 병합할 수 있습니다.")
    keep_id = int(body.keep_id)
    duplicate_ids = [int(i) for i in dict.fromkeys(body.duplicate_ids) if int(i) != keep_id]
    if not duplicate_ids:
        raise HTTPException(status_code=422, detail="병합할 대상 시추공이 없습니다.")
    ids = [keep_id, *duplicate_ids]
    found = set((await db.execute(
        select(Borehole.id).where(Borehole.id.in_(ids), Borehole.deleted_at.is_(None))
    )).scalars().all())
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"존재하지 않는 시추공: {missing}")
    merged = await _merge_duplicate_boreholes(db, keep_id, duplicate_ids)
    id_map = {dup: keep_id for dup in duplicate_ids}
    projects_bbox_updated = await _replace_project_bbox_ids(db, id_map)
    await db.commit()
    return {**merged, "keep_id": keep_id, "projects_bbox_updated": projects_bbox_updated}


@router.put("/{borehole_id}/project-overrides/{project_id}")
async def upsert_project_borehole_override(
    borehole_id: int,
    project_id: int,
    body: BoreholeOverrideUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    project = (await db.execute(
        select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    )).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")

    source = (await db.execute(
        select(Borehole)
        .options(selectinload(Borehole.strata))
        .where(Borehole.id == borehole_id, Borehole.deleted_at.is_(None))
    )).scalar_one_or_none()
    if source is None:
        raise HTTPException(status_code=404, detail="시추공을 찾을 수 없습니다.")
    if source.is_supplementary:
        raise HTTPException(status_code=409, detail="신규 시추공은 원본 수정본이 아니라 직접 수정해야 합니다.")

    if body.strata:
        for s in body.strata:
            if s.depth_bottom <= s.depth_top:
                raise HTTPException(
                    status_code=422,
                    detail=f"depth_bottom({s.depth_bottom}) > depth_top({s.depth_top}) 이어야 합니다.",
                )

    payload = {
        "name": body.name or source.name,
        "latitude": body.latitude,
        "longitude": body.longitude,
        "elevation": body.elevation,
        "strata": [
            {
                "depth_top": s.depth_top,
                "depth_bottom": s.depth_bottom,
                "soil_type": s.soil_type,
                "raw_text": s.raw_text,
                "n_value": s.n_value,
                "uscs_code": s.uscs_code,
            }
            for s in (body.strata or [])
        ],
    }
    loc_json = (await db.execute(
        select(func.ST_AsGeoJSON(Borehole.location)).where(Borehole.id == source.id)
    )).scalar()
    source_lng, source_lat = _loc_to_lng_lat(loc_json)
    payload["latitude"] = payload["latitude"] if payload["latitude"] is not None else source_lat
    payload["longitude"] = payload["longitude"] if payload["longitude"] is not None else source_lng
    payload["elevation"] = payload["elevation"] if payload["elevation"] is not None else source.elevation
    if not payload["strata"]:
        payload["strata"] = [
            {
                "depth_top": s.depth_top,
                "depth_bottom": s.depth_bottom,
                "soil_type": s.soil_type,
                "raw_text": s.raw_text,
                "n_value": s.n_value,
                "uscs_code": s.uscs_code,
            }
            for s in sorted(source.strata, key=lambda s: s.depth_top)
        ]

    override = (await db.execute(
        select(ProjectBoreholeOverride).where(
            ProjectBoreholeOverride.project_id == project_id,
            ProjectBoreholeOverride.source_borehole_id == borehole_id,
            ProjectBoreholeOverride.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if override is None:
        override = ProjectBoreholeOverride(
            project_id=project_id,
            source_borehole_id=borehole_id,
            status=body.status,
            data=payload,
        )
        db.add(override)
    else:
        override.status = body.status
        override.data = payload

    await db.commit()
    await db.refresh(override)
    return _apply_project_override(source, loc_json, override)


# ---------------------------------------------------------------------------
# POST /by-area
# ---------------------------------------------------------------------------

@router.post("/by-area")
async def boreholes_by_area(
    body: ByAreaRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    geojson_str = json.dumps(body.polygon)

    stmt = select(
        Borehole,
        func.ST_AsGeoJSON(Borehole.location).label("loc_json"),
    ).where(
        Borehole.deleted_at.is_(None),
        func.ST_Contains(
            func.ST_GeomFromGeoJSON(geojson_str),
            cast(Borehole.location, Geometry),
        ),
    )

    if body.project_id is not None:
        stmt = stmt.where(Borehole.project_id == body.project_id)
    if body.borehole_ids:
        stmt = stmt.where(Borehole.id.in_(body.borehole_ids))

    rows = (await db.execute(stmt)).all()

    if body.include_strata:
        ids = [b.id for b, _loc in rows]
        if ids:
            orm_stmt = (
                select(Borehole)
                .options(selectinload(Borehole.strata))
                .where(Borehole.id.in_(ids), Borehole.deleted_at.is_(None))
            )
            boreholes_orm = (await db.execute(orm_stmt)).scalars().all()
            loc_map = {b.id: loc for b, loc in rows}
            boreholes_list = [
                _borehole_dict(b, loc_map.get(b.id), include_strata=True)
                for b in boreholes_orm
            ]
        else:
            boreholes_list = []
    else:
        boreholes_list = [_borehole_dict(b, loc) for b, loc in rows]

    return {
        "boreholes": boreholes_list,
        "count": len(boreholes_list),
        "total": len(boreholes_list),
        "limit": len(boreholes_list),
        "offset": 0,
    }
