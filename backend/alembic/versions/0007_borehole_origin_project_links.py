"""add borehole origin and project links

Revision ID: 0007_origin_links
Revises: 0006_borehole_revisions
Create Date: 2026-06-16

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0007_origin_links"
down_revision = "0006_borehole_revisions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "boreholes",
        sa.Column("data_origin", sa.String(length=30), nullable=False, server_default="public"),
    )
    op.create_index("ix_boreholes_data_origin", "boreholes", ["data_origin"])

    op.create_table(
        "project_borehole_links",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("borehole_id", sa.BigInteger(), nullable=False),
        sa.Column("project_role", sa.String(length=30), nullable=False, server_default="existing"),
        sa.Column("linked_reason", sa.String(length=50), nullable=False, server_default="migrated"),
        sa.Column("registered_from_job_id", sa.BigInteger(), nullable=True),
        sa.Column("registered_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["borehole_id"], ["boreholes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["registered_from_job_id"], ["pdf_extraction_jobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["registered_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_borehole_links_project_id", "project_borehole_links", ["project_id"])
    op.create_index("ix_project_borehole_links_borehole_id", "project_borehole_links", ["borehole_id"])
    op.create_index("ix_project_borehole_links_project_role", "project_borehole_links", ["project_role"])
    op.create_index("ix_project_borehole_links_linked_reason", "project_borehole_links", ["linked_reason"])
    op.create_index(
        "ix_project_borehole_links_registered_from_job_id",
        "project_borehole_links",
        ["registered_from_job_id"],
    )
    op.create_index(
        "uq_project_borehole_links_active",
        "project_borehole_links",
        ["project_id", "borehole_id"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    # Source classification. Seeded storage files are public; temp uploads are
    # user data unless explicitly marked as a test fixture below.
    op.execute(
        """
        UPDATE boreholes
        SET data_origin = 'user_upload'
        WHERE source_file LIKE '%temp_uploads%'
          AND deleted_at IS NULL
        """
    )
    op.execute(
        """
        UPDATE boreholes
        SET data_origin = 'manual_input'
        WHERE source_file IS NULL
          AND deleted_at IS NULL
          AND is_supplementary IS TRUE
        """
    )
    op.execute(
        """
        UPDATE boreholes
        SET data_origin = 'test'
        WHERE project_id = 9708
          AND name = 'NH-1'
          AND source_file LIKE '%page1_project4_report.pdf'
          AND deleted_at IS NULL
        """
    )

    # Existing project bbox selections become project-level existing links.
    op.execute(
        """
        INSERT INTO project_borehole_links (project_id, borehole_id, project_role, linked_reason)
        SELECT p.id, (jsonb_array_elements_text(p.bbox::jsonb -> 'borehole_ids'))::bigint, 'existing', 'bbox_selected'
        FROM projects p
        WHERE p.deleted_at IS NULL
          AND p.bbox IS NOT NULL
          AND jsonb_typeof(p.bbox::jsonb -> 'borehole_ids') = 'array'
        ON CONFLICT DO NOTHING
        """
    )

    # Project-owned upload/manual rows get project-level roles. This preserves
    # the user's current project as "new" while letting later projects link the
    # same global boreholes as existing.
    op.execute(
        """
        INSERT INTO project_borehole_links (project_id, borehole_id, project_role, linked_reason)
        SELECT
          b.project_id,
          b.id,
          CASE
            WHEN b.data_origin = 'test' THEN 'excluded'
            WHEN b.is_supplementary IS TRUE THEN 'new'
            WHEN b.source_file LIKE '%temp_uploads%' THEN 'new'
            ELSE 'existing'
          END,
          CASE
            WHEN b.data_origin = 'test' THEN 'test_excluded'
            WHEN b.is_supplementary IS TRUE THEN 'pdf_uploaded'
            WHEN b.source_file LIKE '%temp_uploads%' THEN 'pdf_uploaded'
            ELSE 'migrated'
          END
        FROM boreholes b
        WHERE b.deleted_at IS NULL
        ON CONFLICT DO NOTHING
        """
    )

    # Some uploaded rows were also stored in the selected bbox list. In that
    # case the bbox migration above creates an "existing" link first, so make
    # the project-owned upload/test classification authoritative.
    op.execute(
        """
        UPDATE project_borehole_links l
        SET
          project_role = CASE
            WHEN b.data_origin = 'test' THEN 'excluded'
            ELSE 'new'
          END,
          linked_reason = CASE
            WHEN b.data_origin = 'test' THEN 'test_excluded'
            ELSE 'pdf_uploaded'
          END
        FROM boreholes b
        WHERE l.borehole_id = b.id
          AND l.project_id = b.project_id
          AND l.deleted_at IS NULL
          AND b.deleted_at IS NULL
          AND (
            b.data_origin = 'test'
            OR b.is_supplementary IS TRUE
            OR b.source_file LIKE '%temp_uploads%'
          )
        """
    )


def downgrade() -> None:
    op.drop_index("uq_project_borehole_links_active", table_name="project_borehole_links")
    op.drop_index("ix_project_borehole_links_registered_from_job_id", table_name="project_borehole_links")
    op.drop_index("ix_project_borehole_links_linked_reason", table_name="project_borehole_links")
    op.drop_index("ix_project_borehole_links_project_role", table_name="project_borehole_links")
    op.drop_index("ix_project_borehole_links_borehole_id", table_name="project_borehole_links")
    op.drop_index("ix_project_borehole_links_project_id", table_name="project_borehole_links")
    op.drop_table("project_borehole_links")
    op.drop_index("ix_boreholes_data_origin", table_name="boreholes")
    op.drop_column("boreholes", "data_origin")
