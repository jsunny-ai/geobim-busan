from app.api.v1.boreholes import _legacy_groundwater_depth


class LegacyStratum:
    def __init__(self, raw_text: str | None):
        self.raw_text = raw_text


def test_recovers_numeric_groundwater_depth():
    rows = [LegacyStratum("{'지하수위': 'GL(-) 3.25'}")]
    assert _legacy_groundwater_depth(rows) == 3.25


def test_recovers_csv_water_level_gl_key():
    rows = [LegacyStratum("{'water_level_gl': 7.2, 'water_level_el': 115.2}")]
    assert _legacy_groundwater_depth(rows) == 7.2


def test_missing_groundwater_does_not_become_zero_anchor():
    rows = [LegacyStratum("{'지하수위': 'N/A'}")]
    assert _legacy_groundwater_depth(rows) is None


def test_searches_later_rows_after_missing_metadata():
    rows = [
        LegacyStratum("{'지하수위': 'N/A'}"),
        LegacyStratum("{'지하수위': 4.8}"),
    ]
    assert _legacy_groundwater_depth(rows) == 4.8
