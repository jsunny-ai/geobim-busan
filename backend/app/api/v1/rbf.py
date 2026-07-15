import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import cast, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from geoalchemy2 import Geometry

from app.api.deps import get_current_user, get_db
from app.models import Borehole, User
from app.api.v1.boreholes import _borehole_dict
from app.services.phantom_points import generate_phantom_points
from app.services.rbf_interpolation import GeologicalRBF

router = APIRouter()

class RBFInterpolationRequest(BaseModel):
    bbox: list[float]  # [min_lng, min_lat, max_lng, max_lat]
    project_id: int | None = None
    grid_res: int = 48
    boreholes: list[dict] | None = None  # 프론트가 이미 가진 데이터를 전송하는 것도 허용

class RBFInterpolationResponse(BaseModel):
    bbox: list[float]
    res: int
    grids: dict[str, list[list[float]]]
    phantom_points: list[dict]

@router.post("/interpolate", response_model=RBFInterpolationResponse)
async def interpolate_strata(
    body: RBFInterpolationRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    지정된 bbox 및 프로젝트 범위 내의 시추공 데이터들을 RBF 보간하여 연속 3D 지층 격자 고도를 반환합니다.
    외삽 발산 방지를 위한 가상 시추공(Phantom Points) 생성 정보도 함께 제공됩니다.
    """
    if len(body.bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox는 [min_lng, min_lat, max_lng, max_lat] 형식의 4개 숫자여야 합니다.")

    # 1. 시추공 데이터 로드
    actual_bhs = []
    if body.boreholes is not None:
        actual_bhs = body.boreholes
    else:
        # DB에서 bbox 영역 내부 시추공 쿼리 (지층 포함)
        min_lng, min_lat, max_lng, max_lat = body.bbox
        polygon_geojson = {
            "type": "Polygon",
            "coordinates": [[
                [min_lng, min_lat],
                [max_lng, min_lat],
                [max_lng, max_lat],
                [min_lng, max_lat],
                [min_lng, min_lat]
            ]]
        }
        geojson_str = json.dumps(polygon_geojson)

        stmt = select(Borehole).options(selectinload(Borehole.strata)).where(
            Borehole.deleted_at.is_(None),
            cast(
                Borehole.location, Geometry
            ).op("&&")(
                cast(Borehole.location, Geometry) # bbox 인덱싱 필터링
            )
        )
        # PostgreSQL ST_Contains 적용
        stmt = select(Borehole).options(selectinload(Borehole.strata)).where(
            Borehole.deleted_at.is_(None),
            cast(
                Borehole.location, Geometry
            ).op("&&")(
                # Bbox 범위 쿼리
                cast(Borehole.location, Geometry)
            )
        )
        
        # geoWorker.ts의 by-area에 맞춘 바운딩 쿼리
        stmt = select(
            Borehole
        ).options(
            selectinload(Borehole.strata)
        ).where(
            Borehole.deleted_at.is_(None)
        )
        
        if body.project_id is not None:
            stmt = stmt.where(Borehole.project_id == body.project_id)
            
        rows = (await db.execute(stmt)).scalars().all()
        
        # 위경도 변환을 위한 loc_json 일괄 구하기
        loc_stmt = select(
            Borehole.id,
            cast(Borehole.location, Geometry).ST_AsGeoJSON().label("loc_json")
        ).where(Borehole.id.in_([r.id for r in rows]))
        loc_map = {row.id: row.loc_json for row in (await db.execute(loc_stmt)).all()}

        # bbox 범위 내부 최종 필터링
        for b in rows:
            loc_json = loc_map.get(b.id)
            if not loc_json:
                continue
            coords = json.loads(loc_json)["coordinates"]
            lng, lat = coords[0], coords[1]
            if min_lng <= lng <= max_lng and min_lat <= lat <= max_lat:
                actual_bhs.append(_borehole_dict(b, loc_json, include_strata=True))

    if not actual_bhs:
        return {
            "bbox": body.bbox,
            "res": body.grid_res,
            "grids": {l: [[0.0]*body.grid_res]*body.grid_res for l in ["soil", "weathered_rock", "soft_rock", "hard_rock"]},
            "phantom_points": []
        }

    # 2. 가상 시추공(Phantom Points) 생성
    phantom_bhs = generate_phantom_points(actual_bhs, scale=1.8, count=12)

    # 3. GeologicalRBF 엔진을 활용한 보간 계산
    rbf_engine = GeologicalRBF(actual_bhs, phantom_bhs)
    grid_data = rbf_engine.build_grid(body.bbox, res=body.grid_res)

    return {
        "bbox": body.bbox,
        "res": body.grid_res,
        "grids": grid_data["grids"],
        "phantom_points": phantom_bhs
    }
