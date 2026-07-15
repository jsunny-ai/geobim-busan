from __future__ import annotations

import pytest

from app.services.landxml_export import grid_to_landxml
from app.services.landxml_point_export import grids_to_cgpoints_landxml


def test_grid_to_landxml_exports_tin_surface() -> None:
    xml = grid_to_landxml(
        [127.0, 37.0, 127.001, 37.001],
        {"weathered_rock": [[10.0, 11.0], [12.0, 13.0]]},
        ["weathered_rock"],
        date_str="2026-06-18",
        time_str="12:00:00",
    )

    assert '<CoordinateSystem name="Korea 2000 Central Belt 2010" epsgCode="5186"/>' in xml
    assert '<Surface name="풍화암_상부면">' in xml
    assert xml.count("<P id=") == 4
    assert xml.count("<F>") == 2


def test_grid_to_landxml_rejects_empty_layers() -> None:
    with pytest.raises(ValueError, match="내보낼 수 있는 지층 데이터"):
        grid_to_landxml(
            [127.0, 37.0, 127.001, 37.001],
            {"weathered_rock": [[10.0, 11.0], [12.0, 13.0]]},
            [],
        )


def test_grid_to_landxml_rejects_too_small_grid() -> None:
    with pytest.raises(ValueError, match="최소 2x2"):
        grid_to_landxml(
            [127.0, 37.0, 127.001, 37.001],
            {"weathered_rock": [[10.0]]},
            ["weathered_rock"],
        )


def test_grid_to_landxml_rejects_non_square_grid() -> None:
    with pytest.raises(ValueError, match="정방형"):
        grid_to_landxml(
            [127.0, 37.0, 127.001, 37.001],
            {"weathered_rock": [[10.0, 11.0], [12.0]]},
            ["weathered_rock"],
        )


def test_grids_to_cgpoints_separates_layers_and_sources() -> None:
    xml = grids_to_cgpoints_landxml(
        [127.0, 37.0, 127.001, 37.001],
        {
            "weathered_rock": [[10.0, 11.0], [12.0, 13.0]],
            "soft_rock": [[5.0, 6.0], [7.0, 8.0]],
        },
        ["weathered_rock", "soft_rock"],
        boreholes=[
            {
                "id": 17,
                "longitude": 127.0005,
                "latitude": 37.0005,
                "elevation": 20.0,
                "strata": [
                    {
                        "strata_group": "weathered_rock",
                        "depth_top": 3.0,
                        "depth_bottom": 7.0,
                    }
                ],
            }
        ],
        date_str="2026-06-29",
        time_str="12:00:00",
    )

    assert '<CgPoints name="WEATHERED_ROCK_TOP"' in xml
    assert '<CgPoints name="SOFT_ROCK_TOP"' in xml
    assert 'code="WEATHERED_ROCK_TOP_OBSERVED"' in xml
    assert " 17.0000</CgPoint>" in xml
    assert xml.count("WEATHERED_ROCK_TOP_INTERPOLATED") == 4
    assert xml.count("SOFT_ROCK_TOP_INTERPOLATED") == 4
    assert "SOFT_ROCK_TOP_OBSERVED" not in xml
    assert "<Surface " not in xml
    assert "<Faces>" not in xml
