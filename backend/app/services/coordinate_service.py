"""Coordinate conversion service.

The supported source CRS list intentionally follows the PDF upload workflow:
WGS84, GRS80 central/east belts, and Bessel central/east belts only.
"""

from __future__ import annotations

from pdf_convert.core.coordinate_transformer import normalize_coordinates


class CoordinateService:
    """Convert source coordinates to WGS84 using the shared PDF conversion path."""

    def to_wgs84(
        self,
        x: float,
        y: float,
        source_epsg: str | None = None,
        *,
        coordinate_order: str | None = None,
    ) -> tuple[float, float]:
        """Convert source coordinates to WGS84 ``(lon, lat)``."""
        lon, lat, _tm_x, _tm_y, _final_epsg = normalize_coordinates(
            x,
            y,
            source_crs=source_epsg,
            coordinate_order=coordinate_order,
        )
        if lon == "" or lat == "":
            raise ValueError("Could not convert coordinate to WGS84.")
        return float(lon), float(lat)

    def detect_crs(self, x: float, y: float) -> str | None:
        """Infer a supported Korean CRS from coordinate values."""
        lon, lat, _tm_x, _tm_y, final_epsg = normalize_coordinates(x, y, source_crs=None)
        if lon == "" or lat == "" or final_epsg == "UNKNOWN":
            return None
        return final_epsg.replace("_INFERRED", "")
