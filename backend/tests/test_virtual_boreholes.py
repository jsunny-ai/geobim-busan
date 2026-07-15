import pytest
from fastapi import HTTPException

from app.api.v1.virtual_boreholes import VirtualStratumInput, _validate_strata


def test_virtual_strata_must_be_contiguous_from_surface():
    rows = [
        VirtualStratumInput(depth_top=0, depth_bottom=5, soil_type="토사"),
        VirtualStratumInput(depth_top=5, depth_bottom=12, soil_type="풍화암"),
    ]
    assert _validate_strata(rows) == 12


def test_virtual_strata_reject_gap():
    rows = [
        VirtualStratumInput(depth_top=0, depth_bottom=5, soil_type="토사"),
        VirtualStratumInput(depth_top=6, depth_bottom=12, soil_type="풍화암"),
    ]
    with pytest.raises(HTTPException):
        _validate_strata(rows)
