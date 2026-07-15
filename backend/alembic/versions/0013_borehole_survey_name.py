"""add survey name to boreholes

Revision ID: 0013_borehole_survey_name
Revises: 0012_project_kind
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0013_borehole_survey_name"
down_revision = "0012_project_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("boreholes", sa.Column("survey_name", sa.String(length=255), nullable=True))
    op.create_index(op.f("ix_boreholes_survey_name"), "boreholes", ["survey_name"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_boreholes_survey_name"), table_name="boreholes")
    op.drop_column("boreholes", "survey_name")
