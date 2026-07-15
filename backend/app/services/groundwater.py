"""Groundwater observation selection and legacy compatibility helpers."""

from __future__ import annotations

import re
from typing import Any

from app.models import Borehole, GroundwaterObservation, Stratum

_DEPTH_RE = re.compile(
    r"(?:지하수위|water[_\s-]*(?:level(?:[_\s-]*gl)?|gl))['\"]?\s*[:=]\s*['\"]?\s*"
    r"(?:GL\s*\(?\s*[-+]?\s*\)?\s*)?(-?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_MISSING_RE = re.compile(
    r"(?:지하수위|water[_\s-]*(?:level(?:[_\s-]*gl)?|gl))['\"]?\s*[:=]\s*['\"]?\s*"
    r"(?:N/?A|NONE|NULL|-)(?:['\",}\s]|$)",
    re.IGNORECASE,
)


def normalize_groundwater_values(
    *,
    elevation_m: float | None,
    depth_bgl_m: float | None,
    head_elevation_m: float | None,
    tolerance_m: float = 0.25,
) -> tuple[float | None, float | None, bool]:
    """Return normalized GL depth, EL head and inconsistency flag."""

    depth = abs(depth_bgl_m) if depth_bgl_m is not None else None
    head = head_elevation_m
    if depth is None and head is not None and elevation_m is not None:
        depth = elevation_m - head
    if head is None and depth is not None and elevation_m is not None:
        head = elevation_m - depth
    if depth is not None and depth < 0:
        return None, head, True
    inconsistent = (
        depth is not None
        and head is not None
        and elevation_m is not None
        and abs((elevation_m - depth) - head) > tolerance_m
    )
    return depth, head, inconsistent


def legacy_groundwater_depth(strata: list[Stratum]) -> float | None:
    for stratum in strata:
        raw = stratum.raw_text or ""
        if not raw or _MISSING_RE.search(raw):
            continue
        match = _DEPTH_RE.search(raw)
        if not match:
            continue
        depth = float(match.group(1))
        if depth >= 0:
            return depth
    return None


def current_groundwater_observation(
    borehole: Borehole,
) -> GroundwaterObservation | None:
    candidates = [
        observation
        for observation in getattr(borehole, "groundwater_observations", [])
        if observation.deleted_at is None
        and observation.review_status not in {"rejected", "excluded"}
        and (
            observation.depth_bgl_m is not None
            or observation.head_elevation_m is not None
        )
    ]
    if not candidates:
        return None
    priority = {"confirmed": 3, "approved": 3, "auto": 2, "needs_review": 1}
    return max(
        candidates,
        key=lambda observation: (
            priority.get(observation.review_status, 0),
            observation.observed_at or observation.created_at,
            observation.id,
        ),
    )


def groundwater_payload(borehole: Borehole) -> dict[str, Any]:
    observation = current_groundwater_observation(borehole)
    if observation is not None:
        depth = observation.depth_bgl_m
        head = observation.head_elevation_m
        if (
            observation.reference_datum == "GL"
            and depth is not None
            and borehole.elevation is not None
        ):
            head = float(borehole.elevation) - depth
        elif (
            observation.reference_datum == "EL"
            and head is not None
            and borehole.elevation is not None
        ):
            depth = float(borehole.elevation) - head
        elif depth is None and head is not None and borehole.elevation is not None:
            depth = float(borehole.elevation) - head
        elif head is None and depth is not None and borehole.elevation is not None:
            head = float(borehole.elevation) - depth
        return {
            "groundwater_depth_bgl_m": depth,
            "groundwater_head_elevation_m": head,
            "groundwater_observed_at": (
                observation.observed_at.isoformat()
                if observation.observed_at is not None
                else None
            ),
            "groundwater_observation_id": observation.id,
            "groundwater_reference_datum": observation.reference_datum,
            "groundwater_review_status": observation.review_status,
            "groundwater_confidence": observation.confidence,
            "groundwater_source": observation.source_kind,
        }

    depth = legacy_groundwater_depth(list(getattr(borehole, "strata", [])))
    return {
        "groundwater_depth_bgl_m": depth,
        "groundwater_head_elevation_m": (
            float(borehole.elevation) - depth
            if depth is not None and borehole.elevation is not None
            else None
        ),
        "groundwater_observed_at": None,
        "groundwater_observation_id": None,
        "groundwater_reference_datum": "GL" if depth is not None else None,
        "groundwater_review_status": "legacy" if depth is not None else None,
        "groundwater_confidence": None,
        "groundwater_source": "legacy_raw_text" if depth is not None else None,
    }
