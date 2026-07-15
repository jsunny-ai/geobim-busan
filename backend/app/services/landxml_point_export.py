"""RBF 지층 격자와 시추공 실측 접촉점을 LandXML COGO 점으로 직렬화합니다."""

from __future__ import annotations

from datetime import date, datetime
import math
from xml.sax.saxutils import quoteattr

from app.services.landxml_export import (
    LAYER_LABELS,
    _validate_bbox,
    _validated_grid,
    _wgs84_to_tm,
)


LAYER_CODES: dict[str, str] = {
    "ground_surface": "GROUND_SURFACE",
    "soil": "SOIL_TOP",
    "weathered_rock": "WEATHERED_ROCK_TOP",
    "soft_rock": "SOFT_ROCK_TOP",
    "normal_rock": "NORMAL_ROCK_TOP",
    "hard_rock": "HARD_ROCK_TOP",
}


def _observed_points(layer_name: str, boreholes: list[dict]) -> list[tuple[float, float, float, str]]:
    """지층면 보간에 사용되는 것과 같은 실측 상부 접촉 표고를 추출합니다."""
    points: list[tuple[float, float, float, str]] = []
    for index, borehole in enumerate(boreholes, start=1):
        if borehole.get("is_phantom"):
            continue
        try:
            lng = float(borehole["longitude"])
            lat = float(borehole["latitude"])
            ground_elevation = float(borehole["elevation"])
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (lng, lat, ground_elevation)):
            continue

        elevation: float | None = None
        if layer_name == "ground_surface":
            elevation = ground_elevation
        else:
            for stratum in borehole.get("strata", []) or []:
                if stratum.get("strata_group") != layer_name:
                    continue
                try:
                    depth_top = float(stratum["depth_top"])
                except (KeyError, TypeError, ValueError):
                    break
                if math.isfinite(depth_top):
                    elevation = ground_elevation - depth_top
                break

        if elevation is None or not math.isfinite(elevation):
            continue
        source = str(borehole.get("id") or borehole.get("name") or index)
        points.append((lng, lat, elevation, source))
    return points


def grids_to_cgpoints_landxml(
    bbox: list[float],
    grids: dict[str, list[list[float]]],
    layers: list[str],
    boreholes: list[dict],
    date_str: str | None = None,
    time_str: str | None = None,
) -> str:
    """지층마다 독립된 이름의 ``CgPoints`` 그룹을 생성합니다.

    각 그룹에는 시추공 실측 접촉점(OBS)과 RBF 정규격자점(INT)이 함께 들어가며,
    ``code`` 속성으로 두 출처를 명확하게 구분합니다.
    """
    date_str = date_str or date.today().isoformat()
    time_str = time_str or datetime.now().strftime("%H:%M:%S")
    min_lng, min_lat, max_lng, max_lat = _validate_bbox(bbox)

    selected_layers = [layer for layer in layers if layer in grids]
    if not selected_layers:
        raise ValueError("내보낼 수 있는 지층 점 데이터가 없습니다.")

    group_parts: list[str] = []
    for layer_name in selected_layers:
        grid = _validated_grid(layer_name, grids[layer_name])
        res = len(grid)
        lngs = [min_lng + (max_lng - min_lng) * i / (res - 1) for i in range(res)]
        lats = [min_lat + (max_lat - min_lat) * j / (res - 1) for j in range(res)]
        code = LAYER_CODES.get(layer_name, layer_name.upper())
        label = LAYER_LABELS.get(layer_name, layer_name)

        point_lines: list[str] = []
        observed_xy: set[tuple[int, int]] = set()
        for observed_index, (lng, lat, elevation, source) in enumerate(
            _observed_points(layer_name, boreholes),
            start=1,
        ):
            easting, northing = _wgs84_to_tm(lng, lat)
            # 동일 위치의 중복 실측공만 cm 단위로 제거합니다.
            xy_key = (round(easting * 100), round(northing * 100))
            if xy_key in observed_xy:
                continue
            observed_xy.add(xy_key)
            point_lines.append(
                f'    <CgPoint name="{code}_OBS_{observed_index:06d}" '
                f'code="{code}_OBSERVED" desc={quoteattr("시추공 " + source)}>'
                f"{northing:.3f} {easting:.3f} {elevation:.4f}</CgPoint>"
            )

        for row_index, lat in enumerate(lats):
            for column_index, lng in enumerate(lngs):
                easting, northing = _wgs84_to_tm(lng, lat)
                point_lines.append(
                    f'    <CgPoint name="{code}_INT_R{row_index + 1:03d}_C{column_index + 1:03d}" '
                    f'code="{code}_INTERPOLATED">'
                    f"{northing:.3f} {easting:.3f} {grid[row_index][column_index]:.4f}</CgPoint>"
                )

        west_e, south_n = _wgs84_to_tm(min_lng, min_lat)
        east_e, north_n = _wgs84_to_tm(max_lng, max_lat)
        spacing_x = abs(east_e - west_e) / (res - 1)
        spacing_y = abs(north_n - south_n) / (res - 1)
        description = (
            f"{label}; observed={len(observed_xy)}; interpolated={res * res}; "
            f"grid={res}x{res}; spacing_x={spacing_x:.2f}m; spacing_y={spacing_y:.2f}m"
        )
        group_parts.append(
            f'  <CgPoints name={quoteattr(code)} desc={quoteattr(description)}>\n'
            + "\n".join(point_lines)
            + "\n  </CgPoints>"
        )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<LandXML version="1.2" xmlns="http://www.landxml.org/schema/LandXML-1.2"\n'
        f'  date="{date_str}" time="{time_str}" language="Korean" readOnly="false">\n'
        "  <Units>\n"
        '    <Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter"\n'
        '      temperatureUnit="celsius" pressureUnit="milliBars"\n'
        '      angularUnit="decimal dd.mm.ss" directionUnit="decimal dd.mm.ss"/>\n'
        "  </Units>\n"
        '  <CoordinateSystem name="Korea 2000 Central Belt 2010" epsgCode="5186"/>\n'
        + "\n".join(group_parts)
        + "\n</LandXML>"
    )
