# =============================================================================
# export.py — LandXML / Civil 3D 내보내기 API
# POST /api/v1/export/landxml
# =============================================================================

import json
import math
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import cast, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from geoalchemy2 import Geometry

from app.api.deps import get_current_user, get_db
from app.api.v1.boreholes import _borehole_dict
from app.models import Borehole, User
from app.services.borehole_dxf import boreholes_to_dxf
from app.services.landxml_export import grid_to_landxml
from app.services.landxml_point_export import grids_to_cgpoints_landxml
from app.services.phantom_points import generate_phantom_points
from app.services.rbf_interpolation import GeologicalRBF, merge_nearby_boreholes

router = APIRouter()

AVAILABLE_LAYERS = [
    "ground_surface",
    "soil",
    "weathered_rock",
    "soft_rock",
    "normal_rock",
    "hard_rock",
]

DEFAULT_LAYERS = ["weathered_rock", "soft_rock", "normal_rock", "hard_rock"]


class LandXMLExportRequest(BaseModel):
    bbox: list[float]                          # [min_lng, min_lat, max_lng, max_lat]
    project_id: int | None = None
    grid_res: int = Field(default=48, ge=2, le=256)
    boreholes: list[dict] | None = None        # None → DB에서 조회
    borehole_ids: list[int] | None = None
    layers: list[str] = Field(default_factory=lambda: DEFAULT_LAYERS.copy())
    mode: Literal["merge", "new_only"] = "merge"
    data_type: Literal["cogo_points", "tin_surface"] = "cogo_points"

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[float]) -> list[float]:
        if len(value) != 4:
            raise ValueError("bbox는 [min_lng, min_lat, max_lng, max_lat] 형식이어야 합니다.")
        if any(not isinstance(v, (int, float)) or not math.isfinite(float(v)) for v in value):
            raise ValueError("bbox 값은 모두 유한한 숫자여야 합니다.")
        min_lng, min_lat, max_lng, max_lat = [float(v) for v in value]
        if min_lng >= max_lng or min_lat >= max_lat:
            raise ValueError("bbox의 최소 좌표는 최대 좌표보다 작아야 합니다.")
        return [min_lng, min_lat, max_lng, max_lat]

    @field_validator("layers")
    @classmethod
    def validate_layers(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("내보낼 지층 경계면을 1개 이상 선택해야 합니다.")
        return value


class BoreholeColumnExportRequest(BaseModel):
    bbox: list[float]
    project_id: int | None = None
    boreholes: list[dict] | None = None
    borehole_ids: list[int] | None = None
    layers: list[str] | None = None              # 포함할 strata_group(None=전체)
    mode: Literal["merge", "new_only"] = "merge"
    radius: float = Field(default=1.5, gt=0, le=50)   # 기둥 단면 반경(m)
    sides: int = Field(default=8, ge=3, le=64)        # 단면 다각형 변 수

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[float]) -> list[float]:
        if len(value) != 4:
            raise ValueError("bbox는 [min_lng, min_lat, max_lng, max_lat] 형식이어야 합니다.")
        if any(not isinstance(v, (int, float)) or not math.isfinite(float(v)) for v in value):
            raise ValueError("bbox 값은 모두 유한한 숫자여야 합니다.")
        min_lng, min_lat, max_lng, max_lat = [float(v) for v in value]
        if min_lng >= max_lng or min_lat >= max_lat:
            raise ValueError("bbox의 최소 좌표는 최대 좌표보다 작아야 합니다.")
        return [min_lng, min_lat, max_lng, max_lat]


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def _sanitize_strata(strata: object) -> list[dict]:
    if not isinstance(strata, list):
        return []

    cleaned: list[dict] = []
    for item in strata:
        if not isinstance(item, dict):
            continue
        top = item.get("depth_top")
        bottom = item.get("depth_bottom")
        if not _finite_number(top) or not _finite_number(bottom):
            continue
        if float(bottom) <= float(top):
            continue
        cleaned.append(
            {
                **item,
                "depth_top": float(top),
                "depth_bottom": float(bottom),
                "strata_group": item.get("strata_group") or "unknown",
                "soil_type": item.get("soil_type") or "미분류",
            }
        )
    return cleaned


def _sanitize_boreholes(boreholes: list[dict]) -> tuple[list[dict], list[dict]]:
    valid: list[dict] = []
    skipped: list[dict] = []

    for bh in boreholes:
        lng = bh.get("longitude")
        lat = bh.get("latitude")
        elev = bh.get("elevation")
        if not (_finite_number(lng) and _finite_number(lat) and _finite_number(elev)):
            skipped.append(
                {
                    "id": bh.get("id"),
                    "name": bh.get("name"),
                    "reason": "invalid_coordinates_or_elevation",
                }
            )
            continue
        valid.append(
            {
                **bh,
                "longitude": float(lng),
                "latitude": float(lat),
                "elevation": float(elev),
                "strata": _sanitize_strata(bh.get("strata", [])),
            }
        )

    return valid, skipped


async def _resolve_boreholes(body, db: AsyncSession) -> tuple[list[dict], list[dict]]:
    """
    요청(body)으로부터 보간/내보내기에 쓸 시추공 목록을 해석하고 정제(sanitize)한다.
    LandXML·DXF 등 여러 내보내기 엔드포인트가 공유한다.

    반환: (정제된 all_bhs, 제외된 skipped_bhs)
    """
    min_lng, min_lat, max_lng, max_lat = body.bbox

    if body.mode == "new_only":
        # 신규 데이터만 사용
        all_bhs = body.boreholes or []
    elif body.boreholes is not None and not body.borehole_ids:
        # The supplement site sends the same effective boreholes shown on screen.
        all_bhs = body.boreholes
    else:
        # DB에서 기존 시추공 조회
        stmt = select(Borehole).options(selectinload(Borehole.strata)).where(
            Borehole.deleted_at.is_(None)
        )
        if body.project_id is not None:
            stmt = stmt.where(Borehole.project_id == body.project_id)
        if body.borehole_ids is not None:
            stmt = stmt.where(Borehole.id.in_(body.borehole_ids))
        rows = (await db.execute(stmt)).scalars().all()

        loc_map: dict[int, str] = {}
        if rows:
            loc_stmt = select(
                Borehole.id,
                cast(Borehole.location, Geometry).ST_AsGeoJSON().label("loc_json"),
            ).where(Borehole.id.in_([r.id for r in rows]))
            loc_map = {row.id: row.loc_json for row in (await db.execute(loc_stmt)).all()}

        db_bhs: list[dict] = []
        for b in rows:
            loc_json = loc_map.get(b.id)
            if not loc_json:
                continue
            coords = json.loads(loc_json)["coordinates"]
            lng, lat = coords[0], coords[1]
            if min_lng <= lng <= max_lng and min_lat <= lat <= max_lat:
                db_bhs.append(_borehole_dict(b, loc_json, include_strata=True))

        # 신규 시추공이 있으면 merge 모드로 합산
        extra_bhs = body.boreholes or []
        all_bhs = db_bhs + extra_bhs

    if not all_bhs:
        raise HTTPException(status_code=422, detail="사용할 시추공 데이터가 없습니다.")

    all_bhs, skipped_bhs = _sanitize_boreholes(all_bhs)
    if not all_bhs:
        raise HTTPException(
            status_code=422,
            detail="유효한 좌표와 표고를 가진 시추공 데이터가 없습니다.",
        )
    return all_bhs, skipped_bhs


@router.post("/landxml")
async def export_landxml(
    body: LandXMLExportRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    RBF 보간 결과를 Civil 3D 호환 LandXML 1.2 파일로 내보냅니다.

    - mode="merge"    : DB 기존 시추공 + body.boreholes 신규 시추공 합산 보간
    - mode="new_only" : body.boreholes 신규 시추공만으로 독립 보간
    - data_type="cogo_points": 지층별 COGO Point Group(기본)
    - data_type="tin_surface": 기존 TIN Surface
    """
    valid_layers = [l for l in body.layers if l in AVAILABLE_LAYERS]
    if not valid_layers:
        raise HTTPException(status_code=422, detail="내보낼 수 있는 지층 경계면이 없습니다.")

    # ── 1. 시추공 데이터 준비 ──────────────────────────────────────────────────
    all_bhs, skipped_bhs = await _resolve_boreholes(body, db)
    if skipped_bhs:
        # 제외 내역은 서버 로그/모니터링에서 추적할 수 있게 남긴다. 응답 파일 형식은 XML로 유지한다.
        import logging

        logging.getLogger(__name__).warning("[LANDXML] skipped invalid boreholes: %s", skipped_bhs)

    # ── 2. RBF 보간 ──────────────────────────────────────────────────────────
    # 근접/중복 시추공(같은 부지 다중 로그·재시추)을 먼저 병합한다.
    # 좌표가 cm 단위로 겹친 채 보간에 들어가면 RBF 행렬이 특이해져
    # 격자 Z가 전역 발산하므로, 팬텀 생성·보간 이전에 반드시 수행한다.
    # COGO 출력에는 팬텀이나 병합 전 원본이 아닌, 정제된 실측 접촉점을 기록한다.
    observed_bhs = list(all_bhs)
    all_bhs = merge_nearby_boreholes(all_bhs, threshold_m=2.0)

    phantom_bhs = generate_phantom_points(all_bhs, scale=1.8, count=12)
    rbf_engine = GeologicalRBF(all_bhs, phantom_bhs)
    grid_result = rbf_engine.build_grid(body.bbox, res=body.grid_res)

    # ── 2.5 실측 근거 없는 지층 제외 ──────────────────────────────────────────
    # 어떤 실측 시추공도 해당 strata_group을 갖지 않는 지층은, 보간 시 상위 지층
    # 바닥을 복제한 '가짜' 경계면으로만 채워진다(예: 풍화암까지만 시추된 부지에서
    # 연암/보통암/경암이 풍화암 바닥과 동일한 면으로 출력됨). 실존하지 않는
    # 경계면을 TIN Surface로 내보내면 사용자가 실측처럼 오인하므로 제외한다.
    # ground_surface 는 공구표고로 항상 산출되므로 예외적으로 유지한다.
    exportable_layers = [
        l for l in valid_layers
        if l == "ground_surface" or rbf_engine.count_layer_real_hits(l) > 0
    ]
    excluded_layers = [l for l in valid_layers if l not in exportable_layers]

    if not exportable_layers:
        raise HTTPException(
            status_code=422,
            detail="선택한 지층 중 실측 데이터가 있는 경계면이 없습니다. 시추공 지층 구성을 확인하세요.",
        )

    if excluded_layers:
        import logging

        logging.getLogger(__name__).warning(
            "[LANDXML] 실측 근거 없는 지층 제외: %s", excluded_layers
        )

    # ── 3. LandXML 생성 ──────────────────────────────────────────────────────
    try:
        common_args = {
            "bbox": body.bbox,
            "grids": grid_result["grids"],
            "layers": exportable_layers,
            "date_str": date.today().isoformat(),
            "time_str": datetime.now().strftime("%H:%M:%S"),
        }
        if body.data_type == "cogo_points":
            xml_content = grids_to_cgpoints_landxml(
                **common_args,
                boreholes=observed_bhs,
            )
        else:
            xml_content = grid_to_landxml(**common_args)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    suffix = "points" if body.data_type == "cogo_points" else "surfaces"
    filename = f"geobim_stratum_{suffix}_{date.today().strftime('%Y%m%d')}.xml"

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if excluded_layers:
        # 프런트가 사용자에게 안내할 수 있도록 제외된 지층을 헤더로 노출한다.
        headers["X-Excluded-Layers"] = ",".join(excluded_layers)
        headers["Access-Control-Expose-Headers"] = "X-Excluded-Layers"

    return Response(
        content=xml_content.encode("utf-8"),
        media_type="application/xml",
        headers=headers,
    )


@router.post("/boreholes-dxf")
async def export_boreholes_dxf(
    body: BoreholeColumnExportRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    시추공 주상도를 지층별 색상 3D 기둥 DXF로 내보냅니다.

    LandXML 지층면과 동일한 EPSG:5186 TM 좌표(X=Easting, Y=Northing, Z=표고)로
    그려지므로, Civil 3D에서 같은 도면에 겹쳐 보간면이 실측 주상도와 맞는지
    육안 검수할 수 있습니다. 보간(RBF/phantom/merge) 없이 실측 시추공만 사용합니다.
    """
    valid_layers = None
    if body.layers:
        valid_layers = [l for l in body.layers if l in AVAILABLE_LAYERS]
        if not valid_layers:
            raise HTTPException(status_code=422, detail="유효한 지층이 없습니다.")

    all_bhs, skipped_bhs = await _resolve_boreholes(body, db)
    if skipped_bhs:
        import logging

        logging.getLogger(__name__).warning("[DXF] skipped invalid boreholes: %s", skipped_bhs)

    dxf_content = boreholes_to_dxf(
        all_bhs,
        layers=valid_layers,
        radius=body.radius,
        sides=body.sides,
    )

    filename = f"geobim_strata_lines_{date.today().strftime('%Y%m%d')}.dxf"
    return Response(
        content=dxf_content.encode("utf-8"),
        media_type="image/vnd.dxf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
