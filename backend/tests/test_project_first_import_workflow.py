from __future__ import annotations

from app.main import app
from app.services.pdf_service import PdfService


def _multipart_schema(path: str) -> dict:
    operation = app.openapi()["paths"][path]["post"]
    schema = operation["requestBody"]["content"]["multipart/form-data"]["schema"]
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        return app.openapi()["components"]["schemas"][name]
    return schema


def test_pdf_uploads_require_explicit_project_id() -> None:
    for path in (
        "/api/v1/pdf-extraction/upload",
        "/api/v1/pdf-extraction/manual/upload",
    ):
        schema = _multipart_schema(path)
        assert "project_id" in schema["required"]


def test_pdf_preview_never_changes_selected_project(monkeypatch) -> None:
    rows = [
        {
            "프로젝트명": "문서에서 검출된 다른 이름",
            "시추공명": "BH-1",
            "lon_wgs84": 127.0,
            "lat_wgs84": 37.0,
            "상심도": 0,
            "하심도": 1,
            "지층명": "토사",
        }
    ]
    service = PdfService()
    monkeypatch.setattr(service, "auto_extract", lambda *_args, **_kwargs: rows)

    result = service.preview_extraction(
        db=None,
        pdf_path="test.pdf",
        project_id=9708,
        project_name="사용자가 선택한 신월지하차도",
    )

    assert result["project_id"] == 9708
    assert result["project_name"] == "사용자가 선택한 신월지하차도"
