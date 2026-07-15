from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, get_db
from app.models import (
    Borehole,
    Project,
    ProjectBoreholeLink,
    ProjectVirtualBorehole,
    ProjectVirtualBoreholeRevision,
    ProjectVirtualBoreholeStratum,
    User,
)
from app.services.normalization import normalize_strata_group


router = APIRouter()


class VirtualStratumInput(BaseModel):
    depth_top: float = Field(ge=0)
    depth_bottom: float = Field(gt=0)
    soil_type: str = Field(min_length=1, max_length=50)
    strata_group: str | None = None
    confidence: Literal["low", "medium", "high"] = "medium"
    note: str | None = None

    @model_validator(mode="after")
    def validate_depths(self):
        if self.depth_bottom <= self.depth_top:
            raise ValueError("지층 하단 심도는 상단 심도보다 커야 합니다.")
        return self


class VirtualBoreholeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    elevation: float
    strata: list[VirtualStratumInput] = Field(min_length=1)
    interpretation_note: str = Field(min_length=1)
    purpose: str | None = Field(default=None, max_length=200)
    influence_radius_m: float | None = Field(default=None, gt=0)


class VirtualBoreholeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    elevation: float | None = None
    strata: list[VirtualStratumInput] | None = None
    interpretation_note: str | None = Field(default=None, min_length=1)
    purpose: str | None = Field(default=None, max_length=200)
    influence_radius_m: float | None = Field(default=None, gt=0)
    status: Literal["draft", "active", "inactive", "archived"] | None = None
    model_enabled: bool | None = None
    change_reason: str = Field(min_length=1)


class VirtualBoreholeCopy(BaseModel):
    source_borehole_id: int
    name: str = Field(min_length=1, max_length=100)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    elevation: float | None = None
    interpretation_note: str = Field(min_length=1)
    purpose: str | None = Field(default=None, max_length=200)


def _validate_strata(rows: list[VirtualStratumInput]) -> float:
    ordered = sorted(rows, key=lambda row: (row.depth_top, row.depth_bottom))
    previous = 0.0
    for index, row in enumerate(ordered):
        if index == 0 and abs(row.depth_top) > 1e-6:
            raise HTTPException(status_code=422, detail="첫 지층은 심도 0m에서 시작해야 합니다.")
        if abs(row.depth_top - previous) > 1e-6:
            raise HTTPException(status_code=422, detail="지층 사이에 공백 또는 중첩이 있습니다.")
        previous = row.depth_bottom
    return previous


async def _project_or_404(db: AsyncSession, project_id: int) -> Project:
    project = (await db.execute(
        select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    )).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
    return project


async def _virtual_or_404(
    db: AsyncSession, project_id: int, virtual_id: int
) -> ProjectVirtualBorehole:
    item = (await db.execute(
        select(ProjectVirtualBorehole)
        .options(selectinload(ProjectVirtualBorehole.strata))
        .where(
            ProjectVirtualBorehole.id == virtual_id,
            ProjectVirtualBorehole.project_id == project_id,
            ProjectVirtualBorehole.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="가상 시추공을 찾을 수 없습니다.")
    return item


async def _location(db: AsyncSession, item: ProjectVirtualBorehole) -> tuple[float, float]:
    loc_json = (await db.execute(
        select(func.ST_AsGeoJSON(ProjectVirtualBorehole.location)).where(
            ProjectVirtualBorehole.id == item.id
        )
    )).scalar_one()
    coords = json.loads(loc_json)["coordinates"]
    return float(coords[0]), float(coords[1])


async def _serialize(db: AsyncSession, item: ProjectVirtualBorehole) -> dict:
    longitude, latitude = await _location(db, item)
    return {
        "id": item.id,
        "project_id": item.project_id,
        "name": item.name,
        "longitude": longitude,
        "latitude": latitude,
        "elevation": item.elevation,
        "total_depth": item.total_depth,
        "source_borehole_id": item.source_borehole_id,
        "status": item.status,
        "model_enabled": item.model_enabled,
        "constraint_mode": item.constraint_mode,
        "influence_weight": item.influence_weight,
        "influence_radius_m": item.influence_radius_m,
        "purpose": item.purpose,
        "interpretation_note": item.interpretation_note,
        "version": item.version,
        "data_origin": "virtual_interpretation",
        "project_role": "virtual",
        "is_virtual": True,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        "strata": [
            {
                "id": row.id,
                "order": row.sequence,
                "depth_top": row.depth_top,
                "depth_bottom": row.depth_bottom,
                "soil_type": row.soil_type,
                "strata_group": row.strata_group,
                "confidence": row.confidence,
                "note": row.note,
            }
            for row in item.strata
            if row.deleted_at is None
        ],
    }


def _replace_strata(item: ProjectVirtualBorehole, rows: list[VirtualStratumInput]) -> None:
    item.strata.clear()
    for sequence, row in enumerate(sorted(rows, key=lambda value: value.depth_top)):
        item.strata.append(ProjectVirtualBoreholeStratum(
            sequence=sequence,
            depth_top=row.depth_top,
            depth_bottom=row.depth_bottom,
            soil_type=row.soil_type.strip(),
            strata_group=row.strata_group or normalize_strata_group(row.soil_type),
            confidence=row.confidence,
            note=row.note,
        ))


@router.get("/{project_id}/virtual-boreholes")
async def list_virtual_boreholes(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    await _project_or_404(db, project_id)
    items = (await db.execute(
        select(ProjectVirtualBorehole)
        .options(selectinload(ProjectVirtualBorehole.strata))
        .where(
            ProjectVirtualBorehole.project_id == project_id,
            ProjectVirtualBorehole.deleted_at.is_(None),
        )
        .order_by(ProjectVirtualBorehole.id)
    )).scalars().all()
    rows = [await _serialize(db, item) for item in items]
    return {
        "virtual_boreholes": rows,
        "count": len(rows),
        "active_count": sum(1 for row in rows if row["model_enabled"]),
    }


@router.post("/{project_id}/virtual-boreholes", status_code=201)
async def create_virtual_borehole(
    project_id: int,
    body: VirtualBoreholeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await _project_or_404(db, project_id)
    total_depth = _validate_strata(body.strata)
    item = ProjectVirtualBorehole(
        project_id=project_id,
        name=body.name.strip(),
        location=func.ST_SetSRID(func.ST_MakePoint(body.longitude, body.latitude), 4326),
        elevation=body.elevation,
        total_depth=total_depth,
        interpretation_note=body.interpretation_note.strip(),
        purpose=body.purpose,
        influence_radius_m=body.influence_radius_m,
        created_by_id=current_user.id,
    )
    _replace_strata(item, body.strata)
    db.add(item)
    await db.commit()
    return await _serialize(db, await _virtual_or_404(db, project_id, item.id))


@router.post("/{project_id}/virtual-boreholes/copy", status_code=201)
async def copy_virtual_borehole(
    project_id: int,
    body: VirtualBoreholeCopy,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await _project_or_404(db, project_id)
    source = (await db.execute(
        select(Borehole)
        .options(selectinload(Borehole.strata))
        .where(Borehole.id == body.source_borehole_id, Borehole.deleted_at.is_(None))
    )).scalar_one_or_none()
    if source is None:
        raise HTTPException(status_code=404, detail="복사할 실제 시추공을 찾을 수 없습니다.")
    linked = (await db.execute(
        select(ProjectBoreholeLink.id).where(
            ProjectBoreholeLink.project_id == project_id,
            ProjectBoreholeLink.borehole_id == source.id,
            ProjectBoreholeLink.deleted_at.is_(None),
            ProjectBoreholeLink.project_role != "excluded",
        )
    )).scalar_one_or_none()
    if source.project_id != project_id and linked is None:
        raise HTTPException(status_code=409, detail="현재 프로젝트의 실제 시추공만 복사할 수 있습니다.")
    strata = [
        VirtualStratumInput(
            depth_top=row.depth_top,
            depth_bottom=row.depth_bottom,
            soil_type=row.soil_type,
            strata_group=normalize_strata_group(row.soil_type),
        )
        for row in sorted(source.strata, key=lambda value: value.depth_top)
    ]
    total_depth = _validate_strata(strata)
    snapshot = {
        "source_borehole_id": source.id,
        "name": source.name,
        "elevation": source.elevation,
        "strata": [row.model_dump() for row in strata],
    }
    item = ProjectVirtualBorehole(
        project_id=project_id,
        name=body.name.strip(),
        location=func.ST_SetSRID(func.ST_MakePoint(body.longitude, body.latitude), 4326),
        elevation=body.elevation if body.elevation is not None else float(source.elevation or 0),
        total_depth=total_depth,
        source_borehole_id=source.id,
        source_snapshot=snapshot,
        interpretation_note=body.interpretation_note.strip(),
        purpose=body.purpose,
        created_by_id=current_user.id,
    )
    _replace_strata(item, strata)
    db.add(item)
    await db.commit()
    return await _serialize(db, await _virtual_or_404(db, project_id, item.id))


@router.put("/{project_id}/virtual-boreholes/{virtual_id}")
async def update_virtual_borehole(
    project_id: int,
    virtual_id: int,
    body: VirtualBoreholeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    item = await _virtual_or_404(db, project_id, virtual_id)
    before = await _serialize(db, item)
    next_version = item.version + 1
    db.add(ProjectVirtualBoreholeRevision(
        virtual_borehole_id=item.id,
        version=item.version,
        snapshot=before,
        change_reason=body.change_reason,
        changed_by_id=current_user.id,
    ))
    if body.name is not None:
        item.name = body.name.strip()
    if body.longitude is not None or body.latitude is not None:
        current_lng, current_lat = await _location(db, item)
        item.location = func.ST_SetSRID(
            func.ST_MakePoint(
                body.longitude if body.longitude is not None else current_lng,
                body.latitude if body.latitude is not None else current_lat,
            ),
            4326,
        )
    if body.elevation is not None:
        item.elevation = body.elevation
    if body.strata is not None:
        item.total_depth = _validate_strata(body.strata)
        _replace_strata(item, body.strata)
    if body.interpretation_note is not None:
        item.interpretation_note = body.interpretation_note.strip()
    if body.purpose is not None:
        item.purpose = body.purpose
    if body.influence_radius_m is not None:
        item.influence_radius_m = body.influence_radius_m
    if body.status is not None:
        item.status = body.status
    if body.model_enabled is not None:
        if body.model_enabled:
            conflict_id = (await db.execute(
                select(Borehole.id).where(
                    Borehole.deleted_at.is_(None),
                    func.ST_DWithin(Borehole.location, item.location, 1.0),
                ).limit(1)
            )).scalar_one_or_none()
            if conflict_id is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"실제 시추공({conflict_id})과 1m 이내에서는 가상 시추공을 활성화할 수 없습니다.",
                )
        item.model_enabled = body.model_enabled
        item.status = "active" if body.model_enabled else "inactive"
    item.version = next_version
    await db.commit()
    return await _serialize(db, await _virtual_or_404(db, project_id, item.id))


@router.delete("/{project_id}/virtual-boreholes/{virtual_id}", status_code=204)
async def delete_virtual_borehole(
    project_id: int,
    virtual_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    item = await _virtual_or_404(db, project_id, virtual_id)
    item.deleted_at = func.now()
    item.model_enabled = False
    await db.commit()


@router.get("/{project_id}/virtual-boreholes/{virtual_id}/revisions")
async def list_virtual_borehole_revisions(
    project_id: int,
    virtual_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    await _virtual_or_404(db, project_id, virtual_id)
    rows = (await db.execute(
        select(ProjectVirtualBoreholeRevision)
        .where(
            ProjectVirtualBoreholeRevision.virtual_borehole_id == virtual_id,
            ProjectVirtualBoreholeRevision.deleted_at.is_(None),
        )
        .order_by(ProjectVirtualBoreholeRevision.version.desc())
    )).scalars().all()
    return {
        "revisions": [
            {
                "id": row.id,
                "version": row.version,
                "snapshot": row.snapshot,
                "change_reason": row.change_reason,
                "changed_by_id": row.changed_by_id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]
    }
