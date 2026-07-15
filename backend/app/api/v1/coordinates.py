"""Coordinate conversion endpoints."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from pdf_convert.core.coordinate_transformer import normalize_coordinates

router = APIRouter()


class CoordinateConvertRequest(BaseModel):
    x: float | str
    y: float | str
    source_crs: str | None = None
    borehole_id: str = "preview"
    coordinate_order: str | None = None


class CoordinateConvertResponse(BaseModel):
    raw_x: float | str
    raw_y: float | str
    source_crs: str | None
    lon_wgs84: float | str
    lat_wgs84: float | str
    tm_x: float | str
    tm_y: float | str
    meta_crs: str
    valid: bool
    message: str | None = None


def _is_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


@router.post("/convert", response_model=CoordinateConvertResponse)
async def convert_coordinate(payload: CoordinateConvertRequest) -> CoordinateConvertResponse:
    lon, lat, tm_x, tm_y, final_epsg = normalize_coordinates(
        payload.x,
        payload.y,
        borehole_id=payload.borehole_id,
        source_crs=payload.source_crs,
        coordinate_order=payload.coordinate_order,
    )
    valid = _is_number(lon) and _is_number(lat)
    message = None if valid else "좌표 변환 결과를 만들지 못했습니다. 원본 좌표와 좌표계를 확인해주세요."
    return CoordinateConvertResponse(
        raw_x=payload.x,
        raw_y=payload.y,
        source_crs=payload.source_crs,
        lon_wgs84=lon,
        lat_wgs84=lat,
        tm_x=tm_x,
        tm_y=tm_y,
        meta_crs=final_epsg,
        valid=valid,
        message=message,
    )
