"""reclassify uploaded project links

Revision ID: 0008_reclassify_links
Revises: 0007_origin_links
Create Date: 2026-06-16

"""
from __future__ import annotations

from alembic import op


revision = "0008_reclassify_links"
down_revision = "0007_origin_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Databases that already ran 0007 before the upload-link correction need a
    # forward migration so user-upload rows are project-new in their owner
    # project, while still remaining reusable as existing data elsewhere.
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
    op.execute(
        """
        UPDATE project_borehole_links l
        SET project_role = 'existing',
            linked_reason = 'bbox_selected'
        FROM boreholes b
        WHERE l.borehole_id = b.id
          AND l.project_id = b.project_id
          AND l.deleted_at IS NULL
          AND b.deleted_at IS NULL
          AND b.source_file LIKE '%temp_uploads%'
        """
    )
