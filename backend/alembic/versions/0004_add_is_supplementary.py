"""add is_supplementary to boreholes and pdf_extraction_jobs

Revision ID: 0004_add_is_supplementary
Revises: 397655860e44
Create Date: 2026-06-02

"""
from alembic import op
import sqlalchemy as sa

revision = "0004_add_is_supplementary"
down_revision = "0003_deduplicate_strata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "boreholes",
        sa.Column("is_supplementary", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "pdf_extraction_jobs",
        sa.Column("is_supplementary", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("boreholes", "is_supplementary")
    op.drop_column("pdf_extraction_jobs", "is_supplementary")
