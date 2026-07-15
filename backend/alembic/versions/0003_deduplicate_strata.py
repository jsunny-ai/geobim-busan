"""strata 테이블 중복 레코드 제거 및 유니크 제약 추가.

Revision ID: 0003_deduplicate_strata
Revises: 397655860e44
Create Date: 2026-05-26

동일한 (borehole_id, depth_top, depth_bottom, soil_type) 조합이
여러 번 입력된 중복 행을 id 최솟값 1개만 남기고 삭제.
이후 같은 조합의 재삽입을 막기 위해 유니크 인덱스 추가.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_deduplicate_strata"
down_revision: str | Sequence[str] | None = "397655860e44"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()

    # 중복 행 삭제: 동일 (borehole_id, depth_top, depth_bottom, soil_type) 중
    # id 최솟값 1개만 유지
    conn.execute(sa.text("""
        DELETE FROM strata
        WHERE id NOT IN (
            SELECT MIN(id)
            FROM strata
            GROUP BY borehole_id, depth_top, depth_bottom, soil_type
        )
    """))

    # 유니크 인덱스: 동일 조합 재삽입 방지
    op.create_index(
        "uq_strata_borehole_depth_type",
        "strata",
        ["borehole_id", "depth_top", "depth_bottom", "soil_type"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_strata_borehole_depth_type", table_name="strata")
