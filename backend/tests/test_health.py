"""헬스 엔드포인트 기본 테스트.

Phase 1 에서 유일하게 동작 가능한 테스트.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_health_endpoint() -> None:
    """GET /health 가 200 OK 와 status=ok 를 반환한다."""
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body
