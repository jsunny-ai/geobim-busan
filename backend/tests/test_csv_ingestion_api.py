"""CSV 인제스트 라우트 배선 스모크 테스트.

DB·외부 의존성 없이 라우터가 앱에 정상 등록됐는지만 확인한다.
(상세 파싱 로직은 test_csv_ingest.py 에서 단위 검증.)

실행: cd backend && pytest tests/test_csv_ingestion_api.py
"""

from __future__ import annotations

import io

import pytest
from fastapi import HTTPException, UploadFile

def test_csv_routes_registered():
    from app.main import app

    paths = set(app.openapi()["paths"])
    assert "/api/v1/csv-ingestion/projects/{project_id}/preview" in paths
    assert "/api/v1/csv-ingestion/projects/{project_id}/commit" in paths


def test_csv_router_has_two_post_endpoints():
    from app.api.v1 import csv_ingestion

    methods = []
    for route in csv_ingestion.router.routes:
        methods.extend(getattr(route, "methods", set()) or set())
    assert methods.count("POST") == 2


def test_upload_size_limit_removes_partial_file(tmp_path, monkeypatch):
    from app.api.v1 import csv_ingestion

    monkeypatch.setattr(csv_ingestion, "_MAX_UPLOAD_BYTES", 4)
    monkeypatch.setattr(csv_ingestion, "_upload_root", lambda: tmp_path)
    upload = UploadFile(filename="large.csv", file=io.BytesIO(b"12345"))

    with pytest.raises(HTTPException) as exc:
        csv_ingestion._save_upload(upload)

    assert exc.value.status_code == 413
    assert list(tmp_path.iterdir()) == []


def test_parse_edited_rows_accepts_pdf_preview_schema():
    from app.api.v1.csv_ingestion import _parse_edited_rows

    rows = _parse_edited_rows(
        '[{"시추공명":"BH-1","lon_wgs84":127.1,"lat_wgs84":37.5,'
        '"표고":10,"상심도":0,"하심도":2,"지층명":"토사","meta_crs":"EPSG:5186"}]'
    )
    assert rows is not None
    assert rows[0]["시추공명"] == "BH-1"


def test_csv_preview_does_not_truncate_134_boreholes():
    from app.api.v1.csv_ingestion import _strip_raw

    boreholes = [
        {
            "name": f"BH-{index + 1}",
            "longitude": 127.0 + index * 0.00001,
            "latitude": 37.0,
            "source_crs": "EPSG:5186",
            "elevation": 10,
            "strata": [{"상심도": 0, "하심도": 1, "지층명": "토사", "_raw": "매립층"}],
        }
        for index in range(134)
    ]

    preview = _strip_raw(boreholes)
    assert len(preview) == 134
    assert preview[-1]["name"] == "BH-134"


def test_pdf_preview_extraction_keeps_every_review_row(monkeypatch):
    from app.services.pdf_service import PdfService

    rows = [
        {
            "시추공명": f"BH-{index + 1}",
            "lon_wgs84": 127.0 + index * 0.00001,
            "lat_wgs84": 37.0,
            "상심도": 0,
            "하심도": 1,
            "지층명": "토사",
        }
        for index in range(134)
    ]
    service = PdfService()
    monkeypatch.setattr(service, "auto_extract", lambda *_args, **_kwargs: rows)
    result = service.preview_extraction(
        db=None,
        pdf_path="test.pdf",
        project_id=1,
        project_name="전체 검수 테스트",
    )
    assert result["borehole_count"] == 134
    assert len(result["rows"]) == 134
    assert result["rows"][-1]["시추공명"] == "BH-134"
