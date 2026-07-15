"""add project borehole overrides

Revision ID: 0005_project_borehole_overrides
Revises: 0004_add_is_supplementary
Create Date: 2026-06-08

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0005_project_borehole_overrides"
down_revision = "0004_add_is_supplementary"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_borehole_overrides",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("source_borehole_id", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="draft"),
        sa.Column("data", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["approved_by_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_borehole_id"], ["boreholes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_borehole_overrides_project_id", "project_borehole_overrides", ["project_id"])
    op.create_index(
        "ix_project_borehole_overrides_source_borehole_id",
        "project_borehole_overrides",
        ["source_borehole_id"],
    )
    op.create_index("ix_project_borehole_overrides_status", "project_borehole_overrides", ["status"])
    op.create_index(
        "uq_project_borehole_overrides_active",
        "project_borehole_overrides",
        ["project_id", "source_borehole_id"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_project_borehole_overrides_active", table_name="project_borehole_overrides")
    op.drop_index("ix_project_borehole_overrides_status", table_name="project_borehole_overrides")
    op.drop_index("ix_project_borehole_overrides_source_borehole_id", table_name="project_borehole_overrides")
    op.drop_index("ix_project_borehole_overrides_project_id", table_name="project_borehole_overrides")
    op.drop_table("project_borehole_overrides")
