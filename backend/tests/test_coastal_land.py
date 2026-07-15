import json

from app.core.config import settings
from app.services.coastal_land import _clip_features, _load_features, load_coastal_land


def _write_geojson(path) -> None:
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "large-land"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[
                                [128.0, 34.0],
                                [130.0, 34.0],
                                [130.0, 36.0],
                                [128.0, 36.0],
                                [128.0, 34.0],
                            ]],
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_coastal_land_is_clipped_to_requested_bbox(tmp_path, monkeypatch) -> None:
    path = tmp_path / "land.geojson"
    _write_geojson(path)
    _load_features.cache_clear()
    _clip_features.cache_clear()
    monkeypatch.setattr(settings, "coastal_land_geojson_path", str(path))
    monkeypatch.setattr(settings, "coastal_land_simplify_tolerance_deg", 0.0)

    result = load_coastal_land((128.7, 34.8, 129.4, 35.4))

    assert result.status == "ok"
    assert len(result.features) == 1
    coordinates = result.features[0]["geometry"]["coordinates"][0]
    assert min(point[0] for point in coordinates) >= 128.7
    assert max(point[0] for point in coordinates) <= 129.4
    assert min(point[1] for point in coordinates) >= 34.8
    assert max(point[1] for point in coordinates) <= 35.4


def test_coastal_land_cache_reuses_unchanged_file(tmp_path, monkeypatch) -> None:
    path = tmp_path / "land.geojson"
    _write_geojson(path)
    _load_features.cache_clear()
    _clip_features.cache_clear()
    monkeypatch.setattr(settings, "coastal_land_geojson_path", str(path))

    load_coastal_land((128.7, 34.8, 129.4, 35.4))
    first = _load_features.cache_info()
    load_coastal_land((128.8, 34.9, 129.3, 35.3))
    second = _load_features.cache_info()

    assert second.hits == first.hits + 1
