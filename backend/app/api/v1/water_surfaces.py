"""V-World 수계 경계 프록시."""

from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.services.vworld_water import fetch_water_boundaries

router = APIRouter()
http_client = httpx.AsyncClient(timeout=20.0)


@router.get("")
async def water_surfaces(
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
    result = await fetch_water_boundaries(values, http_client)
    return {
        "type": "FeatureCollection",
        "features": result.features,
        "status": result.status,
        "failed_service_ids": result.failed_service_ids,
        "fetched_at": datetime.fromtimestamp(result.fetched_at_epoch, timezone.utc).isoformat(),
    }
