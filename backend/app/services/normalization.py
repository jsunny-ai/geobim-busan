"""Stratum name normalization helpers."""

from __future__ import annotations

import re
from typing import Literal

StrataGroup = Literal[
    "soil",
    "weathered_rock",
    "soft_rock",
    "normal_rock",
    "hard_rock",
    "unknown",
]

SOIL_DETAIL_ALIASES: dict[str, str] = {
    "토사": "토사",
    "표토": "토사",
    "토층": "토사",
    "매립층": "매립토",
    "매립토": "매립토",
    "되메움": "매립토",
    "퇴적층": "퇴적토",
    "퇴적토": "퇴적토",
    "충적층": "충적토",
    "충적토": "충적토",
    "붕적층": "붕적토",
    "붕적토": "붕적토",
    "풍화토": "풍화토",
    "잔류토": "풍화토",
    "퇴적점토": "퇴적점토",
    "퇴적모래": "퇴적모래",
    "퇴적자갈": "퇴적자갈",
    "점성토": "점토",
    "점토": "점토",
    "실트": "실트",
    "사질토": "모래",
    "모래": "모래",
    "역질토": "자갈",
    "자갈": "자갈",
    "유기질토": "유기질토",
    "이탄": "유기질토",
    "부식토": "유기질토",
    "사질점토": "사질점토",
    "점토질모래": "점토질모래",
    "CL": "점토",
    "CH": "점토",
    "ML": "실트",
    "MH": "실트",
    "SW": "모래",
    "SP": "모래",
    "SM": "모래",
    "SC": "모래",
    "GW": "자갈",
    "GP": "자갈",
    "GM": "자갈",
    "GC": "자갈",
    "OL": "유기질토",
    "OH": "유기질토",
    "PT": "유기질토",
}

_ROCK_SYNONYMS: dict[str, StrataGroup] = {
    "풍화암": "weathered_rock",
    "풍화대": "weathered_rock",
    "풍화기반암": "weathered_rock",
    "연암": "soft_rock",
    "리핑암": "soft_rock",
    "보통암": "normal_rock",
    "경암": "hard_rock",
    "발파암": "hard_rock",
    "극경암": "hard_rock",
    "화강암": "hard_rock",
}

_GROUP_CODES: set[StrataGroup] = {
    "soil",
    "weathered_rock",
    "soft_rock",
    "normal_rock",
    "hard_rock",
    "unknown",
}


def _clean_text(raw: str | None) -> str:
    if not raw:
        return ""
    text = str(raw).strip()
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"\(.*?\)", "", text)
    return text


def normalize_soil_detail(raw: str | None) -> str | None:
    """Return the display soil detail name when the input is soil-family text."""

    cleaned = _clean_text(raw)
    if not cleaned:
        return None
    upper = cleaned.upper()
    if upper in SOIL_DETAIL_ALIASES:
        return SOIL_DETAIL_ALIASES[upper]
    if cleaned in SOIL_DETAIL_ALIASES:
        return SOIL_DETAIL_ALIASES[cleaned]
    matches = [
        (key, value)
        for key, value in SOIL_DETAIL_ALIASES.items()
        if not key.isascii() and key in cleaned
    ]
    if matches:
        return sorted(matches, key=lambda item: len(item[0]), reverse=True)[0][1]
    return None


def normalize_strata_group(raw: str | None) -> StrataGroup:
    """Normalize raw stratum text into the broad modeling group."""

    if not raw:
        return "unknown"
    raw_lower = str(raw).strip().lower()
    if raw_lower in _GROUP_CODES:
        return raw_lower  # type: ignore[return-value]
    if normalize_soil_detail(raw):
        return "soil"
    cleaned = _clean_text(raw)
    for key, group in sorted(_ROCK_SYNONYMS.items(), key=lambda item: len(item[0]), reverse=True):
        if key in cleaned:
            return group
    return "unknown"


STRATA_COLORS_HEX: dict[StrataGroup, str] = {
    "soil": "#8B7355",
    "weathered_rock": "#C4A57B",
    "soft_rock": "#6B8E5A",
    "normal_rock": "#5F6552",
    "hard_rock": "#3D3D3D",
    "unknown": "#B4B4B4",
}

STRATA_COLORS_RGB: dict[StrataGroup, tuple[int, int, int]] = {
    "soil": (139, 115, 85),
    "weathered_rock": (196, 165, 123),
    "soft_rock": (107, 142, 90),
    "normal_rock": (95, 101, 82),
    "hard_rock": (61, 61, 61),
    "unknown": (180, 180, 180),
}


def get_strata_color_hex(raw: str | None) -> str:
    return STRATA_COLORS_HEX[normalize_strata_group(raw)]


def get_strata_color_rgb(raw: str | None) -> tuple[int, int, int]:
    return STRATA_COLORS_RGB[normalize_strata_group(raw)]
