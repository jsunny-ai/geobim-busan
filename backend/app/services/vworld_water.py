"""V-World 수계 경계 조회와 안전한 빈 결과 폴백."""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass

import httpx

from app.core.config import settings


@dataclass(frozen=True)
class WaterBoundaryResult:
    features: list[dict]
    status: str
    failed_service_ids: list[str]
    fetched_at_epoch: float


_cache: dict[str, tuple[float, WaterBoundaryResult]] = {}


def split_bbox(
    bbox: tuple[float, float, float, float],
    max_area_km2: float = 1.9,
) -> list[tuple[float, float, float, float]]:
    """V-World BOX 2km² 제한보다 작게 경위도 bbox를 분할한다."""
    min_lng, min_lat, max_lng, max_lat = bbox
    mid_lat = (min_lat + max_lat) / 2
    width_km = max((max_lng - min_lng) * 111.32 * math.cos(math.radians(mid_lat)), 0.001)
    height_km = max((max_lat - min_lat) * 110.54, 0.001)
    cells = max(1, math.ceil((width_km * height_km) / max_area_km2))
    x_cells = max(1, math.ceil(math.sqrt(cells * width_km / height_km)))
    y_cells = max(1, math.ceil(cells / x_cells))
    boxes = []
    for y in range(y_cells):
        y0 = min_lat + (max_lat - min_lat) * y / y_cells
        y1 = min_lat + (max_lat - min_lat) * (y + 1) / y_cells
        for x in range(x_cells):
            x0 = min_lng + (max_lng - min_lng) * x / x_cells
            x1 = min_lng + (max_lng - min_lng) * (x + 1) / x_cells
            boxes.append((x0, y0, x1, y1))
    return boxes


def _feature_key(feature: dict) -> str:
    feature_id = feature.get("id")
    if feature_id is not None:
        return str(feature_id)
    return json.dumps(feature.get("geometry"), sort_keys=True, ensure_ascii=False)


async def fetch_water_boundaries(
    bbox: tuple[float, float, float, float],
    client: httpx.AsyncClient,
) -> WaterBoundaryResult:
    service_ids = settings.vworld_water_service_id_list
    api_key = settings.vworld_api_key
    now = time.time()
    if not service_ids or not api_key:
        return WaterBoundaryResult([], "not_configured", [], now)

    cache_key = f"{bbox}:{','.join(service_ids)}"
    cached = _cache.get(cache_key)
    if cached and now - cached[0] <= settings.vworld_water_cache_ttl_seconds:
        return cached[1]

    features_by_key: dict[str, dict] = {}
    failed: set[str] = set()
    base = settings.vworld_api_base.rstrip("/")
    for service_id in service_ids:
        for box in split_bbox(bbox):
            params = {
                "service": "data",
                "version": "2.0",
                "request": "GetFeature",
                "key": api_key,
                "format": "json",
                "size": 1000,
                "page": 1,
                "data": service_id,
                "geomFilter": f"BOX({box[0]},{box[1]},{box[2]},{box[3]})",
                "geometry": "true",
                "attribute": "true",
                "crs": "EPSG:4326",
            }
            try:
                response = await client.get(f"{base}/req/data", params=params)
                response.raise_for_status()
                payload = response.json()
                if payload.get("response", {}).get("status") not in (None, "OK"):
                    failed.add(service_id)
                    continue
                result = payload.get("response", {}).get("result", {})
                collection = result.get("featureCollection") or result
                rows = collection.get("features", []) if isinstance(collection, dict) else []
                for feature in rows:
                    if not feature.get("geometry"):
                        continue
                    properties = feature.setdefault("properties", {})
                    properties.update(
                        {
                            "source": "vworld",
                            "source_service_id": service_id,
                            "water_elevation_m": None,
                            "elevation_source": None,
                        }
                    )
                    features_by_key[_feature_key(feature)] = feature
            except (httpx.HTTPError, ValueError, TypeError):
                failed.add(service_id)

    status = "ok" if not failed else ("partial" if features_by_key else "upstream_error")
    result = WaterBoundaryResult(list(features_by_key.values()), status, sorted(failed), now)
    _cache[cache_key] = (now, result)
    return result
