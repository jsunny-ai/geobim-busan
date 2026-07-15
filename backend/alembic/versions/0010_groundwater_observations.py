"""add source-traceable groundwater observations

Revision ID: 0010_groundwater
Revises: 0009_virtual_boreholes
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0010_groundwater"
down_revision = "0009_virtual_boreholes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "groundwater_observations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("borehole_id", sa.BigInteger(), nullable=False),
        sa.Column("extraction_job_id", sa.BigInteger(), nullable=True),
        sa.Column("observation_key", sa.String(200), nullable=False),
        sa.Column("depth_bgl_m", sa.Float(), nullable=True),
        sa.Column("head_elevation_m", sa.Float(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reference_datum", sa.String(10), nullable=False),
        sa.Column("raw_value", sa.Float(), nullable=True),
        sa.Column("raw_text", sa.Text(), nullable=True),
        sa.Column("source_kind", sa.String(30), server_default="pdf", nullable=False),
        sa.Column("source_page", sa.Integer(), nullable=True),
        sa.Column("source_bbox", sa.JSON(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("review_status", sa.String(30), server_default="auto", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["borehole_id"], ["boreholes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["extraction_job_id"],
            ["pdf_extraction_jobs.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("observation_key", name="uq_groundwater_observation_key"),
    )
    op.create_index(
        "ix_groundwater_observations_borehole_id",
        "groundwater_observations",
        ["borehole_id"],
    )
    op.create_index(
        "ix_groundwater_observations_extraction_job_id",
        "groundwater_observations",
        ["extraction_job_id"],
    )
    op.create_index(
        "ix_groundwater_observations_review_status",
        "groundwater_observations",
        ["review_status"],
    )


def downgrade() -> None:
    op.drop_table("groundwater_observations")
