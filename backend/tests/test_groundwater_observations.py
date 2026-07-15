from app.services.groundwater import normalize_groundwater_values
from app.api.v1.boreholes import _apply_revision


class DummyRevision:
    def __init__(self, payload: dict, version: int = 1):
        self.payload = payload
        self.version = version


def test_gl_depth_calculates_el_head():
    depth, head, inconsistent = normalize_groundwater_values(
        elevation_m=100.0,
        depth_bgl_m=4.3,
        head_elevation_m=None,
    )
    assert depth == 4.3
    assert head == 95.7
    assert inconsistent is False


def test_el_head_calculates_gl_depth():
    depth, head, inconsistent = normalize_groundwater_values(
        elevation_m=100.0,
        depth_bgl_m=None,
        head_elevation_m=95.7,
    )
    assert round(depth, 6) == 4.3
    assert head == 95.7
    assert inconsistent is False


def test_negative_gl_notation_is_normalized_to_positive_depth():
    depth, head, inconsistent = normalize_groundwater_values(
        elevation_m=100.0,
        depth_bgl_m=-4.3,
        head_elevation_m=None,
    )
    assert depth == 4.3
    assert head == 95.7
    assert inconsistent is False


def test_conflicting_gl_and_el_requires_review():
    depth, head, inconsistent = normalize_groundwater_values(
        elevation_m=100.0,
        depth_bgl_m=4.3,
        head_elevation_m=90.0,
    )
    assert depth == 4.3
    assert head == 90.0
    assert inconsistent is True


def test_revision_elevation_recalculates_gl_groundwater_head():
    data = {
        "elevation": 103.6,
        "groundwater_reference_datum": "GL",
        "groundwater_depth_bgl_m": 2.9,
        "groundwater_head_elevation_m": 100.7,
    }

    updated = _apply_revision(data, DummyRevision({"elevation": 3.6}, version=2))

    assert updated["elevation"] == 3.6
    assert updated["groundwater_depth_bgl_m"] == 2.9
    assert round(updated["groundwater_head_elevation_m"], 6) == 0.7
    assert updated["revision_version"] == 2
