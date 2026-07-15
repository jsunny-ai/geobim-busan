"""add project-scoped virtual boreholes

Revision ID: 0009_virtual_boreholes
Revises: 0008_reclassify_links
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from geoalchemy2 import Geography


revision = "0009_virtual_boreholes"
down_revision = "0008_reclassify_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_virtual_boreholes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("location", Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("elevation", sa.Float(), nullable=False),
        sa.Column("total_depth", sa.Float(), nullable=False),
        sa.Column("source_borehole_id", sa.BigInteger(), nullable=True),
        sa.Column("source_snapshot", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(20), server_default="draft", nullable=False),
        sa.Column("model_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("constraint_mode", sa.String(20), server_default="hard", nullable=False),
        sa.Column("influence_weight", sa.Float(), server_default="1", nullable=False),
        sa.Column("influence_radius_m", sa.Float(), nullable=True),
        sa.Column("purpose", sa.String(200), nullable=True),
        sa.Column("interpretation_note", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_borehole_id"], ["boreholes.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_virtual_boreholes_project_id", "project_virtual_boreholes", ["project_id"])
    op.create_index("ix_virtual_boreholes_model_enabled", "project_virtual_boreholes", ["model_enabled"])

    op.create_table(
        "project_virtual_borehole_strata",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("virtual_borehole_id", sa.BigInteger(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("depth_top", sa.Float(), nullable=False),
        sa.Column("depth_bottom", sa.Float(), nullable=False),
        sa.Column("soil_type", sa.String(50), nullable=False),
        sa.Column("strata_group", sa.String(30), nullable=False),
        sa.Column("confidence", sa.String(20), server_default="medium", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["virtual_borehole_id"], ["project_virtual_boreholes.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_virtual_strata_borehole_id",
        "project_virtual_borehole_strata",
        ["virtual_borehole_id"],
    )

    op.create_table(
        "project_virtual_borehole_revisions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("virtual_borehole_id", sa.BigInteger(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("change_reason", sa.Text(), nullable=False),
        sa.Column("changed_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["virtual_borehole_id"], ["project_virtual_boreholes.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["changed_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_virtual_revisions_borehole_id",
        "project_virtual_borehole_revisions",
        ["virtual_borehole_id"],
    )


def downgrade() -> None:
    op.drop_table("project_virtual_borehole_revisions")
    op.drop_table("project_virtual_borehole_strata")
    op.drop_table("project_virtual_boreholes")
