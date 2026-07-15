"""add explicit project creation provenance and lifecycle

Revision ID: 0011_project_lifecycle
Revises: 0010_groundwater
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0011_project_lifecycle"
down_revision = "0010_groundwater"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("creation_source", sa.String(length=30), server_default="migration", nullable=False),
    )
    op.add_column(
        "projects",
        sa.Column("lifecycle_status", sa.String(length=20), server_default="active", nullable=False),
    )
    op.create_index(
        op.f("ix_projects_lifecycle_status"),
        "projects",
        ["lifecycle_status"],
        unique=False,
    )
    op.create_check_constraint(
        "ck_projects_creation_source",
        "projects",
        "creation_source IN ('projects_ui', 'upload_ui', 'migration')",
    )
    op.create_check_constraint(
        "ck_projects_lifecycle_status",
        "projects",
        "lifecycle_status IN ('active', 'archived')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_projects_lifecycle_status", "projects", type_="check")
    op.drop_constraint("ck_projects_creation_source", "projects", type_="check")
    op.drop_index(op.f("ix_projects_lifecycle_status"), table_name="projects")
    op.drop_column("projects", "lifecycle_status")
    op.drop_column("projects", "creation_source")
