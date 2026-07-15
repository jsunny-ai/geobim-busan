"""separate user workspaces from legacy public source survey names

Revision ID: 0012_project_kind
Revises: 0011_project_lifecycle
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0012_project_kind"
down_revision = "0011_project_lifecycle"
branch_labels = None
depends_on = None

USER_WORKSPACE_IDS = (9707, 9708, 9718)


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "project_kind",
            sa.String(length=30),
            server_default="public_source_legacy",
            nullable=False,
        ),
    )
    op.execute(
        "UPDATE projects SET project_kind = 'user_workspace' "
        "WHERE id IN (9707, 9708, 9718)"
    )
    op.alter_column(
        "projects",
        "project_kind",
        server_default="user_workspace",
        existing_type=sa.String(length=30),
        existing_nullable=False,
    )
    op.create_index(
        op.f("ix_projects_project_kind"),
        "projects",
        ["project_kind"],
        unique=False,
    )
    op.create_check_constraint(
        "ck_projects_project_kind",
        "projects",
        "project_kind IN ('user_workspace', 'public_source_legacy')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_projects_project_kind", "projects", type_="check")
    op.drop_index(op.f("ix_projects_project_kind"), table_name="projects")
    op.drop_column("projects", "project_kind")
