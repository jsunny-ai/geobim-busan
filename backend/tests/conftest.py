"""pytest 공통 픽스처.

Phase 1 은 골격만 — 실제 픽스처 본문은 Phase 2 에서 채운다.
"""

from __future__ import annotations

import pytest


# ----------------------------------------------------------------------------
# pytest-asyncio 설정
# ----------------------------------------------------------------------------
# pyproject.toml 의 [tool.pytest.ini_options] 에서 asyncio_mode = "auto" 로 설정됨


# ----------------------------------------------------------------------------
# DB 세션 픽스처 (Phase 2 에서 실제 구현)
# ----------------------------------------------------------------------------
@pytest.fixture
async def db_session():
    """비동기 DB 세션 픽스처.

    TODO(Phase 2):
        - 트랜잭션 롤백 패턴으로 테스트 격리
        - 테스트용 DB URL 사용 (TEST_DATABASE_URL 환경변수)
        - PostGIS extension 활성화 후 모든 테이블 생성
    """
    pytest.skip("DB fixture not yet implemented (Phase 2)")


# ----------------------------------------------------------------------------
# FastAPI 테스트 클라이언트 (Phase 2)
# ----------------------------------------------------------------------------
@pytest.fixture
async def client():
    """httpx.AsyncClient + FastAPI app.

    TODO(Phase 2):
        - app.dependency_overrides[get_db] = lambda: db_session
        - lifespan=on 으로 호출
    """
    pytest.skip("Test client fixture not yet implemented (Phase 2)")
