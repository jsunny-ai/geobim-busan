"""Configured authoritative coastal land polygons with a fail-open response."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

from app.core.config import settings


@dataclass(frozen=True)
class CoastalLandResult:
    features: list[dict[str, Any]]
    status: str
    source: str
    source_date: str | None
    vertical_datum: str


@lru_cache(maxsize=4)
def _load_features(path_text: str, modified_ns: int) -> tuple[dict[str, Any], ...]:
    del modified_ns  # cache key only; invalidates automatically when the file changes.
    payload = json.loads(Path(path_text).read_text(encoding="utf-8"))
    raw_features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(raw_features, list):
        raise ValueError("GeoJSON must contain a features array")
    return tuple(feature for feature in raw_features if isinstance(feature, dict))


def _polygonal_part(geometry):
    if geometry.is_empty:
        return None
    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry
    if geometry.geom_type == "GeometryCollection":
        polygons = [
            item
            for item in geometry.geoms
            if item.geom_type in {"Polygon", "MultiPolygon"} and not item.is_empty
        ]
        return unary_union(polygons) if polygons else None
    return None


@lru_cache(maxsize=128)
def _clip_features(
    path_text: str,
    modified_ns: int,
    bbox: tuple[float, float, float, float],
    tolerance: float,
    source: str,
    source_date: str | None,
    datum: str,
) -> tuple[dict[str, Any], ...]:
    raw_features = _load_features(path_text, modified_ns)
    features: list[dict[str, Any]] = []
    clip_box = box(*bbox)
    for feature in raw_features:
        if not isinstance(feature.get("geometry"), dict):
            continue
        try:
            geometry = shape(feature["geometry"])
        except (TypeError, ValueError):
            continue
        if geometry.geom_type not in {"Polygon", "MultiPolygon"} or not geometry.intersects(clip_box):
            continue
        clipped = _polygonal_part(geometry.intersection(clip_box))
        if clipped is None:
            continue
        if tolerance:
            clipped = _polygonal_part(clipped.simplify(tolerance, preserve_topology=True))
        if clipped is None:
            continue
        copied = dict(feature)
        copied["geometry"] = mapping(clipped)
        properties = dict(copied.get("properties") or {})
        properties.setdefault("source", source)
        properties.setdefault("source_date", source_date)
        properties.setdefault("vertical_datum", datum)
        copied["properties"] = properties
        features.append(copied)
    return tuple(features)


def load_coastal_land(bbox: tuple[float, float, float, float]) -> CoastalLandResult:
    source = settings.coastal_land_source
    source_date = settings.coastal_land_source_date or None
    datum = settings.coastal_land_vertical_datum
    configured_path = settings.coastal_land_geojson_path.strip()
    if not configured_path:
        return CoastalLandResult([], "not_configured", source, source_date, datum)
    path = Path(configured_path).expanduser()
    if not path.is_file():
        return CoastalLandResult([], "missing", source, source_date, datum)
    try:
        features = _clip_features(
            str(path.resolve()),
            path.stat().st_mtime_ns,
            bbox,
            max(0.0, settings.coastal_land_simplify_tolerance_deg),
            source,
            source_date,
            datum,
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        return CoastalLandResult([], "invalid", source, source_date, datum)
    return CoastalLandResult(list(features), "ok", source, source_date, datum)
