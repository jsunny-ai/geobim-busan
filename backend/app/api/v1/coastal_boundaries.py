"""Authoritative coastal land polygon endpoint."""

from fastapi import APIRouter, HTTPException, Query

from app.services.coastal_land import load_coastal_land

router = APIRouter()


@router.get("")
async def coastal_boundaries(
    bbox: str = Query(..., description="minLng,minLat,maxLng,maxLat"),
) -> dict:
    try:
        values = tuple(float(value.strip()) for value in bbox.split(","))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="bbox must contain four numbers") from exc
    if len(values) != 4:
        raise HTTPException(status_code=422, detail="bbox must contain four numbers")
    min_lng, min_lat, max_lng, max_lat = values
    if min_lng >= max_lng or min_lat >= max_lat:
        raise HTTPException(status_code=422, detail="bbox min values must be less than max values")
    result = load_coastal_land(values)
    return {
        "type": "FeatureCollection",
        "features": result.features,
        "status": result.status,
        "source": result.source,
        "source_date": result.source_date,
        "vertical_datum": result.vertical_datum,
    }
