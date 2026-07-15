"""초기 테이블 생성.

Revision ID: 0002_initial_tables
Revises: 0001_postgis_extension
Create Date: 2026-05-18

모든 ORM 모델 테이블을 생성한다:
  users, projects, project_members, boreholes, strata,
  pdf_templates, pdf_extraction_jobs
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geography

# revision identifiers
revision: str = "0002_initial_tables"
down_revision: str | Sequence[str] | None = "0001_postgis_extension"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()

    # ---- enum 타입 생성 ----
    # conn.execute(
    #     sa.text(
    #         "CREATE TYPE user_role AS ENUM ('designer', 'expert', 'reviewer', 'admin')"
    #     )
    # )
    # conn.execute(
    #     sa.text(
    #         "CREATE TYPE project_member_role AS ENUM ('owner', 'editor', 'viewer')"
    #     )
    # )
    # conn.execute(
    #     sa.text(
    #         "CREATE TYPE extraction_job_status AS ENUM "
    #         "('pending', 'running', 'awaiting_review', 'approved', 'failed')"
    #     )
    # )

    # ---- users ----
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column(
            "role",
            sa.Enum("designer", "expert", "reviewer", "admin", name="user_role"),
            nullable=False,
            server_default="designer",
        ),
        sa.Column("full_name", sa.String(100), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    # ---- projects ----
    op.create_table(
        "projects",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "owner_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("region", sa.String(100), nullable=True),
        sa.Column("source_crs", sa.String(20), nullable=True),
        sa.Column("bbox", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_projects_name", "projects", ["name"])
    op.create_index("ix_projects_owner_id", "projects", ["owner_id"])
    op.create_index("ix_projects_region", "projects", ["region"])

    # ---- project_members ----
    op.create_table(
        "project_members",
        sa.Column(
            "project_id",
            sa.BigInteger(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "role",
            sa.Enum(
                "owner", "editor", "viewer",
                name="project_member_role",
            ),
            nullable=False,
            server_default="viewer",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("project_id", "user_id"),
    )

    # ---- boreholes ----
    op.create_table(
        "boreholes",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.BigInteger(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column(
            "location",
            Geography(geometry_type="POINT", srid=4326),
            nullable=False,
        ),
        sa.Column("elevation", sa.Float(), nullable=True),
        sa.Column("source_crs", sa.String(20), nullable=True),
        sa.Column("source_file", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_boreholes_project_id", "boreholes", ["project_id"])
    op.create_index("ix_boreholes_name", "boreholes", ["name"])

    # ---- strata ----
    op.create_table(
        "strata",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "borehole_id",
            sa.BigInteger(),
            sa.ForeignKey("boreholes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("depth_top", sa.Float(), nullable=False),
        sa.Column("depth_bottom", sa.Float(), nullable=False),
        sa.Column("soil_type", sa.String(50), nullable=False),
        sa.Column("raw_text", sa.Text(), nullable=True),
        sa.Column("source_file", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_strata_borehole_id", "strata", ["borehole_id"])
    op.create_index("ix_strata_soil_type", "strata", ["soil_type"])

    # ---- pdf_templates ----
    op.create_table(
        "pdf_templates",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column(
            "owner_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("region", sa.String(100), nullable=True),
        sa.Column("box_definitions", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("match_keywords", sa.JSON(), nullable=True),
        sa.Column("sample_pdf", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_pdf_templates_name", "pdf_templates", ["name"])
    op.create_index("ix_pdf_templates_owner_id", "pdf_templates", ["owner_id"])
    op.create_index("ix_pdf_templates_region", "pdf_templates", ["region"])

    # ---- pdf_extraction_jobs ----
    op.create_table(
        "pdf_extraction_jobs",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.BigInteger(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "running", "awaiting_review", "approved", "failed",
                name="extraction_job_status",
            ),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "template_id",
            sa.BigInteger(),
            sa.ForeignKey("pdf_templates.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("celery_task_id", sa.String(100), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_pdf_extraction_jobs_project_id", "pdf_extraction_jobs", ["project_id"])
    op.create_index("ix_pdf_extraction_jobs_status", "pdf_extraction_jobs", ["status"])
    op.create_index("ix_pdf_extraction_jobs_template_id", "pdf_extraction_jobs", ["template_id"])


def downgrade() -> None:
    op.drop_table("pdf_extraction_jobs")
    op.drop_table("pdf_templates")
    op.drop_table("strata")
    op.drop_table("boreholes")
    op.drop_table("project_members")
    op.drop_table("projects")
    op.drop_table("users")

    conn = op.get_bind()
    conn.execute(sa.text("DROP TYPE IF EXISTS extraction_job_status"))
    conn.execute(sa.text("DROP TYPE IF EXISTS project_member_role"))
    conn.execute(sa.text("DROP TYPE IF EXISTS user_role"))
