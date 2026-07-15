"""PostGIS extension 활성화.

Revision ID: 0001_postgis_extension
Revises:
Create Date: 2026-05-14

이 마이그레이션은 PostgreSQL 에 PostGIS 확장을 활성화한다.
geoalchemy2 의 Geography 타입을 사용하기 위해 반드시 먼저 실행되어야 한다.

이후 테이블 생성 마이그레이션은 모델이 확정된 후
`alembic revision --autogenerate -m "create initial tables"` 로 생성한다.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_postgis_extension"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")


def downgrade() -> None:
    # PostGIS extension 제거는 의존 테이블이 있으면 실패하므로
    # 운영 환경에서는 수동 검토를 권장한다.
    op.execute("DROP EXTENSION IF EXISTS postgis")
