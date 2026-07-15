"""Read-only inventory of projects created by the legacy PDF auto-project flow.

This script never changes data. Review its JSON report before planning any
archive or merge operation.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from sqlalchemy import func, or_, select

from app.core.database import SyncSessionLocal
from app.models import Borehole, PdfExtractionJob, Project


LEGACY_NAME_PREFIXES = ("PDF 자동 감지 대기-", "PDF 직접 지정 대기-")


def classify(output: Path) -> dict:
    with SyncSessionLocal() as db:
        rows = db.execute(
            select(
                Project.id,
                Project.name,
                Project.created_at,
                func.count(func.distinct(Borehole.id)).label("borehole_count"),
                func.count(func.distinct(PdfExtractionJob.id)).label("job_count"),
            )
            .outerjoin(
                Borehole,
                (Borehole.project_id == Project.id) & Borehole.deleted_at.is_(None),
            )
            .outerjoin(
                PdfExtractionJob,
                (PdfExtractionJob.project_id == Project.id)
                & PdfExtractionJob.deleted_at.is_(None),
            )
            .where(
                Project.deleted_at.is_(None),
                or_(*(Project.name.startswith(prefix) for prefix in LEGACY_NAME_PREFIXES)),
            )
            .group_by(Project.id)
            .order_by(Project.id)
        ).all()

    projects = [
        {
            "id": row.id,
            "name": row.name,
            "created_at": row.created_at.isoformat(),
            "borehole_count": row.borehole_count,
            "job_count": row.job_count,
            "classification": (
                "review_for_archive"
                if row.borehole_count == 0
                else "manual_target_project_required"
            ),
        }
        for row in rows
    ]
    report = {
        "read_only": True,
        "candidate_count": len(projects),
        "archive_review_count": sum(
            item["classification"] == "review_for_archive" for item in projects
        ),
        "manual_merge_review_count": sum(
            item["classification"] == "manual_target_project_required"
            for item in projects
        ),
        "projects": projects,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("legacy_pdf_projects_report.json"),
    )
    args = parser.parse_args()
    report = classify(args.output)
    print(json.dumps({key: value for key, value in report.items() if key != "projects"}))


if __name__ == "__main__":
    main()
