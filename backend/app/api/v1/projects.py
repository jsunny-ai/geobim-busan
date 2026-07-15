"""프로젝트 라우터.

- GET /          : 프로젝트 목록 (borehole_count 포함)
- GET /{id}      : 프로젝트 상세 (borehole_count 포함)
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, get_db
from app.api.v1.boreholes import _apply_revision, _latest_revision_map
from app.models import Borehole, Project, ProjectBoreholeLink, ProjectBoreholeOverride, Stratum, User
from app.schemas import ProjectRead, ProjectCreate
from app.services.normalization import normalize_strata_group
from app.services.groundwater import groundwater_payload

router = APIRouter()


def _project_with_count(project: Project, borehole_count: int) -> dict:
    data = ProjectRead.model_validate(project).model_dump()
    data["borehole_count"] = borehole_count
    return data


def _loc_to_lng_lat(loc_json: str | None) -> tuple[float, float]:
    import json

    if not loc_json:
        return 0.0, 0.0
    coords = json.loads(loc_json)["coordinates"]
    return coords[0], coords[1]


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


def _borehole_dict(b: Borehole, loc_json: str | None) -> dict:
    lng, lat = _loc_to_lng_lat(loc_json)
    data = {
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
        "is_supplementary": b.is_supplementary,
        "data_status": "supplementary" if b.is_supplementary else "original",
        "project_role": None,
        "linked_reason": None,
        "registered_from_job_id": None,
        "source_borehole_id": None,
        "override_id": None,
        "created_at": b.created_at.isoformat(),
        "strata": sorted([_stratum_dict(s) for s in b.strata], key=lambda x: x["depth_top"]),
    }
    data.update(groundwater_payload(b))
    return data


def _override_stratum_dict(source_id: int, s: dict, index: int) -> dict:
    soil_type = s.get("soil_type") or "미분류"
    return {
        "id": s.get("id") or -(index + 1),
        "borehole_id": source_id,
        "depth_top": float(s.get("depth_top") or 0),
        "depth_bottom": float(s.get("depth_bottom") or 0),
        "soil_type": soil_type,
        "strata_group": normalize_strata_group(soil_type),
        "raw_text": s.get("raw_text"),
        "n_value": s.get("n_value"),
        "uscs_code": s.get("uscs_code"),
    }


def _apply_override(data: dict, override: ProjectBoreholeOverride) -> dict:
    payload = override.data or {}
    merged = {**data}
    merged.update(
        {
            "project_id": override.project_id,
            "source_borehole_id": data["id"],
            "override_id": override.id,
            "data_status": f"modified_{override.status}",
            "is_supplementary": False,
            "name": payload.get("name", data["name"]),
            "longitude": payload.get("longitude", data["longitude"]),
            "latitude": payload.get("latitude", data["latitude"]),
            "elevation": payload.get("elevation", data["elevation"]),
        }
    )
    if isinstance(payload.get("strata"), list):
        merged["strata"] = [
            _override_stratum_dict(data["id"], s, index)
            for index, s in enumerate(payload["strata"])
        ]
    return merged


def _apply_project_link(data: dict, link: ProjectBoreholeLink) -> dict:
    role = link.project_role or "existing"
    merged = {**data}
    merged.update(
        {
            "project_id": link.project_id,
            "project_role": role,
            "linked_reason": link.linked_reason,
            "registered_from_job_id": link.registered_from_job_id,
            "is_supplementary": role == "new",
            "data_status": role,
        }
    )
    return merged


def _bbox_borehole_ids(bbox: dict | None) -> list[int]:
    if not isinstance(bbox, dict):
        return []
    raw_ids = bbox.get("borehole_ids")
    if not isinstance(raw_ids, list):
        return []

    ids: list[int] = []
    seen: set[int] = set()
    for value in raw_ids:
        try:
            borehole_id = int(value)
        except (TypeError, ValueError):
            continue
        if borehole_id not in seen:
            ids.append(borehole_id)
            seen.add(borehole_id)
    return ids


async def _sync_project_borehole_links(
    db: AsyncSession,
    project: Project,
    selected_borehole_ids: list[int],
    user: User,
) -> None:
    if not selected_borehole_ids:
        return

    boreholes = (await db.execute(
        select(Borehole).where(
            Borehole.id.in_(selected_borehole_ids),
            Borehole.deleted_at.is_(None),
        )
    )).scalars().all()
    borehole_map = {b.id: b for b in boreholes}

    links = (await db.execute(
        select(ProjectBoreholeLink).where(
            ProjectBoreholeLink.project_id == project.id,
            ProjectBoreholeLink.borehole_id.in_(selected_borehole_ids),
        )
    )).scalars().all()

    link_map: dict[int, ProjectBoreholeLink] = {}
    for link in links:
        current = link_map.get(link.borehole_id)
        if current is None or (current.deleted_at is not None and link.deleted_at is None):
            link_map[link.borehole_id] = link

    for borehole_id in selected_borehole_ids:
        borehole = borehole_map.get(borehole_id)
        if borehole is None:
            continue

        desired_role = (
            "new"
            if borehole.project_id == project.id and borehole.is_supplementary
            else "existing"
        )
        link = link_map.get(borehole_id)
        if link is None:
            db.add(ProjectBoreholeLink(
                project_id=project.id,
                borehole_id=borehole_id,
                project_role=desired_role,
                linked_reason="bbox_selected",
                registered_by_id=user.id,
            ))
            continue

        link.deleted_at = None
        if link.project_role == "excluded":
            link.project_role = desired_role
            link.linked_reason = "bbox_selected"


@router.get("/")
async def list_projects(
    has_bbox: bool | None = None,
    status: str = "active",
    kind: str = "user_workspace",
    include_legacy_pdf_placeholders: bool = False,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[dict]:
    """전체 프로젝트 목록 (soft delete 제외, borehole_count 포함)."""
    stmt = (
        select(Project, func.count(Borehole.id).label("borehole_count"))
        .outerjoin(Borehole, (Borehole.project_id == Project.id) & Borehole.deleted_at.is_(None))
        .where(Project.deleted_at.is_(None))
    )
    if status != "all":
        stmt = stmt.where(Project.lifecycle_status == status)
    if kind != "all":
        stmt = stmt.where(Project.project_kind == kind)
    if not include_legacy_pdf_placeholders:
        stmt = stmt.where(
            ~Project.name.startswith("PDF 자동 감지 대기-"),
            ~Project.name.startswith("PDF 직접 지정 대기-"),
        )
    
    if has_bbox is not None:
        if has_bbox:
            stmt = stmt.where(Project.bbox.is_not(None))
        else:
            stmt = stmt.where(Project.bbox.is_(None))
            
    stmt = stmt.group_by(Project.id).order_by(Project.created_at.desc())
    rows = (await db.execute(stmt)).all()
    projects = [_project_with_count(p, cnt) for p, cnt in rows]
    if projects:
        project_ids = [p["id"] for p in projects]
        link_counts = (await db.execute(
            select(ProjectBoreholeLink.project_id, func.count(ProjectBoreholeLink.id))
            .where(
                ProjectBoreholeLink.project_id.in_(project_ids),
                ProjectBoreholeLink.deleted_at.is_(None),
                ProjectBoreholeLink.project_role != "excluded",
            )
            .group_by(ProjectBoreholeLink.project_id)
        )).all()
        count_map = {project_id: count for project_id, count in link_counts}
        for project_data in projects:
            if project_data["id"] in count_map:
                project_data["borehole_count"] = count_map[project_data["id"]]
    return projects


@router.get("/{project_id}/boreholes/effective")
async def list_effective_project_boreholes(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    project = (await db.execute(
        select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    )).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")

    selected_ids = []
    if isinstance(project.bbox, dict):
        raw_ids = project.bbox.get("borehole_ids")
        if isinstance(raw_ids, list):
            selected_ids = [int(v) for v in raw_ids if str(v).strip()]

    project_links = (await db.execute(
        select(ProjectBoreholeLink)
        .options(selectinload(ProjectBoreholeLink.borehole).selectinload(Borehole.strata))
        .where(
            ProjectBoreholeLink.project_id == project_id,
            ProjectBoreholeLink.deleted_at.is_(None),
            ProjectBoreholeLink.project_role != "excluded",
        )
        .order_by(ProjectBoreholeLink.id)
    )).scalars().all()
    if project_links:
        linked_boreholes = [link.borehole for link in project_links if link.borehole.deleted_at is None]
        linked_ids = {b.id for b in linked_boreholes}
        supplementary_stmt = (
            select(Borehole)
            .options(selectinload(Borehole.strata))
            .where(
                Borehole.project_id == project_id,
                Borehole.deleted_at.is_(None),
                Borehole.is_supplementary.is_(True),
            )
        )
        if linked_ids:
            supplementary_stmt = supplementary_stmt.where(~Borehole.id.in_(linked_ids))
        unlinked_supplementary = (await db.execute(supplementary_stmt)).scalars().all()
        all_boreholes = linked_boreholes + unlinked_supplementary

        loc_rows = (await db.execute(
            select(
                Borehole.id,
                func.ST_AsGeoJSON(Borehole.location).label("loc_json"),
            ).where(Borehole.id.in_([b.id for b in all_boreholes]))
        )).all()
        loc_map = {row.id: row.loc_json for row in loc_rows}

        overrides = (await db.execute(
            select(ProjectBoreholeOverride).where(
                ProjectBoreholeOverride.project_id == project_id,
                ProjectBoreholeOverride.source_borehole_id.in_([b.id for b in linked_boreholes]),
                ProjectBoreholeOverride.deleted_at.is_(None),
                ProjectBoreholeOverride.status != "rejected",
            )
        )).scalars().all()
        override_map = {o.source_borehole_id: o for o in overrides}
        latest_revs = await _latest_revision_map(db, [b.id for b in all_boreholes])

        rows: list[dict] = []
        for link in project_links:
            b = link.borehole
            if b.deleted_at is not None:
                continue
            item = _borehole_dict(b, loc_map.get(b.id))
            rev = latest_revs.get(b.id)
            if rev is not None:
                item = _apply_revision(item, rev)
            override = override_map.get(b.id)
            if override:
                item = _apply_override(item, override)
            rows.append(_apply_project_link(item, link))
        for b in unlinked_supplementary:
            item = _borehole_dict(b, loc_map.get(b.id))
            rev = latest_revs.get(b.id)
            if rev is not None:
                item = _apply_revision(item, rev)
            rows.append({
                **item,
                "project_role": "new",
                "linked_reason": "supplementary_project_member",
                "is_supplementary": True,
                "data_status": "new",
            })

        return {
            "boreholes": rows,
            "count": len(rows),
            "total": len(rows),
            "selected_count": len([link for link in project_links if link.project_role == "existing"]),
            "new_count": len([link for link in project_links if link.project_role == "new"]) + len(unlinked_supplementary),
            "override_count": len(overrides),
        }

    base_boreholes: list[Borehole] = []
    if selected_ids:
        base_boreholes = (await db.execute(
            select(Borehole)
            .options(selectinload(Borehole.strata))
            .where(Borehole.id.in_(selected_ids), Borehole.deleted_at.is_(None))
        )).scalars().all()

    supplementary = (await db.execute(
        select(Borehole)
        .options(selectinload(Borehole.strata))
        .where(
            Borehole.project_id == project_id,
            Borehole.deleted_at.is_(None),
            Borehole.is_supplementary.is_(True),
        )
    )).scalars().all()

    all_boreholes = base_boreholes + supplementary
    if all_boreholes:
        loc_rows = (await db.execute(
            select(
                Borehole.id,
                func.ST_AsGeoJSON(Borehole.location).label("loc_json"),
            ).where(Borehole.id.in_([b.id for b in all_boreholes]))
        )).all()
        loc_map = {row.id: row.loc_json for row in loc_rows}
    else:
        loc_map = {}

    overrides = []
    if selected_ids:
        overrides = (await db.execute(
            select(ProjectBoreholeOverride).where(
                ProjectBoreholeOverride.project_id == project_id,
                ProjectBoreholeOverride.source_borehole_id.in_(selected_ids),
                ProjectBoreholeOverride.deleted_at.is_(None),
                ProjectBoreholeOverride.status != "rejected",
            )
        )).scalars().all()
    override_map = {o.source_borehole_id: o for o in overrides}

    # [v4.2] 전역 개정(Revision) 적용 — 적용 순서: 원본 → Revision(정정) → Override(프로젝트 보정)
    latest_revs = await _latest_revision_map(db, [b.id for b in all_boreholes])

    selected_order = {borehole_id: index for index, borehole_id in enumerate(selected_ids)}
    rows: list[dict] = []
    for b in sorted(base_boreholes, key=lambda item: selected_order.get(item.id, 0)):
        item = _borehole_dict(b, loc_map.get(b.id))
        rev = latest_revs.get(b.id)
        if rev is not None:
            item = _apply_revision(item, rev)
        override = override_map.get(b.id)
        rows.append(_apply_override(item, override) if override else item)
    for b in supplementary:
        item = _borehole_dict(b, loc_map.get(b.id))
        rev = latest_revs.get(b.id)
        if rev is not None:
            item = _apply_revision(item, rev)
        rows.append(item)

    return {
        "boreholes": rows,
        "count": len(rows),
        "total": len(rows),
        "selected_count": len(selected_ids),
        "override_count": len(overrides),
    }


@router.get("/{project_id}")
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """프로젝트 상세 (borehole_count 포함)."""
    stmt = (
        select(Project, func.count(Borehole.id).label("borehole_count"))
        .outerjoin(Borehole, (Borehole.project_id == Project.id) & Borehole.deleted_at.is_(None))
        .where(Project.id == project_id, Project.deleted_at.is_(None))
        .group_by(Project.id)
    )
    row = (await db.execute(stmt)).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
    project, borehole_count = row
    data = _project_with_count(project, borehole_count)
    link_count = (await db.execute(
        select(func.count(ProjectBoreholeLink.id)).where(
            ProjectBoreholeLink.project_id == project_id,
            ProjectBoreholeLink.deleted_at.is_(None),
            ProjectBoreholeLink.project_role != "excluded",
        )
    )).scalar_one()
    if link_count:
        data["borehole_count"] = link_count
    return data


@router.post("/", response_model=ProjectRead)
async def create_project(
    project_in: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Project:
    """새 프로젝트 생성."""
    project = Project(
        name=project_in.name,
        description=project_in.description,
        region=project_in.region,
        source_crs=project_in.source_crs,
        bbox=project_in.bbox,
        creation_source=project_in.creation_source,
        lifecycle_status=project_in.lifecycle_status,
        project_kind=project_in.project_kind,
        owner_id=_current_user.id,
    )
    db.add(project)
    await db.flush()
    await _sync_project_borehole_links(
        db,
        project,
        _bbox_borehole_ids(project_in.bbox),
        _current_user,
    )
    await db.commit()
    await db.refresh(project)
    return project


@router.put("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: int,
    project_in: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Project:
    """기존 프로젝트 수정 (영역 BBox 및 선택 시추공 리스트 업데이트)."""
    stmt = select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
        
    if project.owner_id != _current_user.id and _current_user.role != "admin":
        raise HTTPException(status_code=403, detail="프로젝트 수정 권한이 없습니다.")
        
    project.name = project_in.name
    project.description = project_in.description
    project.region = project_in.region
    project.source_crs = project_in.source_crs
    project.bbox = project_in.bbox
    project.lifecycle_status = project_in.lifecycle_status
    await _sync_project_borehole_links(
        db,
        project,
        _bbox_borehole_ids(project_in.bbox),
        _current_user,
    )
    
    await db.commit()
    await db.refresh(project)
    return project


@router.delete("/{project_id}")
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """프로젝트 삭제 (soft delete)."""
    stmt = select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
    
    # 간이 권한 검사 (소유자 또는 관리자만 삭제 가능)
    if project.owner_id != _current_user.id and _current_user.role != "admin":
        raise HTTPException(status_code=403, detail="프로젝트 삭제 권한이 없습니다.")
        
    project.deleted_at = func.now()
    await db.commit()
    return {"status": "success"}
