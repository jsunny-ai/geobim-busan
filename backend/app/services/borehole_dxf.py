from __future__ import annotations

import ast
import json
import math

from app.services.landxml_export import _wgs84_to_tm


LAYER_STYLE: dict[str, tuple[str, int]] = {
    "soil": ("STRATUM_SOIL", 43),
    "weathered_rock": ("STRATUM_WEATHERED_ROCK", 41),
    "soft_rock": ("STRATUM_SOFT_ROCK", 94),
    "normal_rock": ("STRATUM_NORMAL_ROCK", 106),
    "hard_rock": ("STRATUM_HARD_ROCK", 250),
    "unknown": ("STRATUM_UNKNOWN", 9),
}

_LABEL_LAYER = "BOREHOLE_LABEL"


def _layer_name(group: str) -> str:
    return LAYER_STYLE.get(group, LAYER_STYLE["unknown"])[0]


def _layer_aci(group: str) -> int:
    return LAYER_STYLE.get(group, LAYER_STYLE["unknown"])[1]


def _finite_float(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _dict_from_raw_text(raw_text: object) -> dict:
    if not isinstance(raw_text, str) or not raw_text.strip():
        return {}
    for parser in (json.loads, ast.literal_eval):
        try:
            parsed = parser(raw_text)
        except (ValueError, SyntaxError, TypeError, json.JSONDecodeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _source_tm_xy(bh: dict) -> tuple[float, float] | None:
    """Return original extracted TM coordinates when they are available.

    Imported boreholes store WGS84 as the canonical geometry, but many source
    reports also keep their original TM coordinates in strata raw_text. Reusing
    those values avoids millimeter/centimeter differences from WGS84 round trips.
    """
    direct_x = _finite_float(bh.get("tm_x"))
    direct_y = _finite_float(bh.get("tm_y"))
    if direct_x is not None and direct_y is not None:
        return direct_x, direct_y

    for stratum in bh.get("strata") or []:
        if not isinstance(stratum, dict):
            continue
        raw = _dict_from_raw_text(stratum.get("raw_text"))
        tm_x = _finite_float(raw.get("tm_x"))
        tm_y = _finite_float(raw.get("tm_y"))
        if tm_x is not None and tm_y is not None:
            return tm_x, tm_y

    return None


def boreholes_to_dxf(
    boreholes: list[dict],
    layers: list[str] | None = None,
    radius: float = 1.5,
    sides: int = 8,
    label_height: float = 2.0,
    max_total_depth: float = 300.0,
) -> str:
    """Convert borehole strata intervals into layer-colored vertical DXF LINE entities.

    The DXF intentionally contains simple vertical lines instead of faces/solids.
    Civil 3D can import these reliably; use scripts/geobim_lines_to_solids.lsp
    to convert selected lines into native cylindrical 3D solids.
    """
    del radius, sides
    allow = set(layers) if layers else None

    used_groups: set[str] = set()
    body_lines: list[str] = []

    for bh in boreholes:
        lng, lat, elev = bh.get("longitude"), bh.get("latitude"), bh.get("elevation")
        if lng is None or lat is None or elev is None:
            continue
        if not all(math.isfinite(float(v)) for v in (lng, lat, elev)):
            continue

        source_tm = _source_tm_xy(bh)
        east, north = source_tm if source_tm is not None else _wgs84_to_tm(float(lng), float(lat))
        elev = float(elev)

        strata = sorted(
            (s for s in (bh.get("strata") or []) if s.get("depth_top") is not None),
            key=lambda s: float(s.get("depth_top", 0.0)),
        )

        for idx, s in enumerate(strata):
            group = s.get("strata_group") or "unknown"
            if allow is not None and group not in allow:
                continue
            try:
                dtop = float(s["depth_top"])
                dbot = float(s["depth_bottom"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (math.isfinite(dtop) and math.isfinite(dbot)) or dbot <= dtop:
                continue
            if dbot > max_total_depth:
                continue

            z_top = elev - dtop
            z_bot = elev - dbot
            used_groups.add(group)
            body_lines.extend(_line(east, north, z_bot, z_top, _layer_name(group)))

        name = str(bh.get("name") or bh.get("id") or "BH")
        body_lines.extend(_text(east, north, elev + label_height * 0.5, name, label_height))

    return _assemble(body_lines, used_groups)


def _line(x: float, y: float, z_bot: float, z_top: float, layer: str) -> list[str]:
    return [
        "0",
        "LINE",
        "8",
        layer,
        "10",
        f"{x:.4f}",
        "20",
        f"{y:.4f}",
        "30",
        f"{z_bot:.4f}",
        "11",
        f"{x:.4f}",
        "21",
        f"{y:.4f}",
        "31",
        f"{z_top:.4f}",
    ]


def _text(x: float, y: float, z: float, value: str, height: float) -> list[str]:
    return [
        "0",
        "TEXT",
        "8",
        _LABEL_LAYER,
        "10",
        f"{x:.4f}",
        "20",
        f"{y:.4f}",
        "30",
        f"{z:.4f}",
        "40",
        f"{height:.3f}",
        "1",
        value,
    ]


def _assemble(body_lines: list[str], used_groups: set[str]) -> str:
    layers = [_layer_name(g) for g in sorted(used_groups)] + [_LABEL_LAYER]
    layer_styles = {
        _layer_name(g): _layer_aci(g)
        for g in used_groups
    }
    layer_styles[_LABEL_LAYER] = 7

    lines: list[str] = [
        "0",
        "SECTION",
        "2",
        "HEADER",
        "9",
        "$ACADVER",
        "1",
        "AC1009",
        "9",
        "$INSUNITS",
        "70",
        "6",
        "0",
        "ENDSEC",
        "0",
        "SECTION",
        "2",
        "TABLES",
        "0",
        "TABLE",
        "2",
        "LAYER",
        "70",
        str(len(layers)),
    ]
    for name in layers:
        aci = layer_styles[name]
        lines += [
            "0",
            "LAYER",
            "2",
            name,
            "70",
            "0",
            "62",
            str(aci),
            "6",
            "CONTINUOUS",
        ]
    lines += ["0", "ENDTAB", "0", "ENDSEC"]
    lines += ["0", "SECTION", "2", "ENTITIES"]
    lines += body_lines
    lines += ["0", "ENDSEC", "0", "EOF"]
    return "\n".join(lines) + "\n"
