"""borehole_revisions — 원본 불변 버전 이력 (v4.2)

Revision ID: 0006_borehole_revisions
Revises: 0005_project_borehole_overrides
Create Date: 2026-06-10

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0006_borehole_revisions"
down_revision = "0005_project_borehole_overrides"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "borehole_revisions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("borehole_id", sa.BigInteger(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("edited_by_id", sa.BigInteger(), nullable=True),
        sa.Column("restored_from", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["borehole_id"], ["boreholes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["edited_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_borehole_revisions_borehole_id", "borehole_revisions", ["borehole_id"])
    op.create_index(
        "ix_borehole_revisions_borehole_version",
        "borehole_revisions",
        ["borehole_id", "version"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_borehole_revisions_borehole_version", table_name="borehole_revisions")
    op.drop_index("ix_borehole_revisions_borehole_id", table_name="borehole_revisions")
    op.drop_table("borehole_revisions")
