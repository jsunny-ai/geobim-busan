"""Safely re-parse existing CSV upload jobs with soil-detail preservation.

Default mode is dry-run. In execute mode this uses the existing
PdfService.persist_rows same-source upsert path, so it replaces strata for
matching boreholes without wiping the database.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.database import SyncSessionLocal  # noqa: E402
from app.services import csv_ingest  # noqa: E402
from app.services.pdf_service import PdfService  # noqa: E402


def json_default(value: Any) -> str | int | float | bool | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value is not None else None


def collect_csv_jobs(db, project_id: int | None, source_file: str | None) -> list[dict[str, Any]]:
    conditions = [
        "result->>'source' = 'csv'",
        "status = 'approved'",
    ]
    params: dict[str, Any] = {}
    if project_id is not None:
        conditions.append("project_id = :project_id")
        params["project_id"] = project_id
    if source_file:
        conditions.append("file_path = :source_file")
        params["source_file"] = source_file

    return db.execute(
        text(
            f"""
            SELECT id, project_id, file_path, result, created_at
            FROM pdf_extraction_jobs
            WHERE {" AND ".join(conditions)}
            ORDER BY id
            """
        ),
        params,
    ).mappings().all()


def count_by_stratum(rows: list[dict[str, Any]]) -> dict[str, int]:
    return dict(Counter(str(row.get("지층명") or "미분류") for row in rows))


def infer_is_supplementary(db, project_id: int, source_file: str) -> bool:
    """Preserve existing new/existing project role when re-extracting."""

    row = db.execute(
        text(
            """
            SELECT
              count(*) FILTER (
                WHERE b.is_supplementary IS TRUE
                   OR l.project_role = 'new'
              ) AS new_count,
              count(*) AS total_count
            FROM boreholes b
            LEFT JOIN project_borehole_links l
              ON l.borehole_id = b.id
             AND l.project_id = :project_id
             AND l.deleted_at IS NULL
            WHERE b.project_id = :project_id
              AND b.source_file = :source_file
              AND b.deleted_at IS NULL
            """
        ),
        {"project_id": project_id, "source_file": source_file},
    ).mappings().one()
    return int(row["total_count"] or 0) > 0 and int(row["new_count"] or 0) > 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Re-parse approved CSV jobs preserving soil details.")
    parser.add_argument("--project-id", type=int, default=9718)
    parser.add_argument("--source-file")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--report", type=Path, default=Path("/tmp/csv_soil_detail_reextract_report.json"))
    args = parser.parse_args()

    service = PdfService()
    report: dict[str, Any] = {
        "started_at": datetime.now().isoformat(),
        "execute": args.execute,
        "project_id": args.project_id,
        "source_file": args.source_file,
        "successes": [],
        "skipped": [],
        "failures": [],
    }

    with SyncSessionLocal() as db:
        jobs = collect_csv_jobs(db, args.project_id, args.source_file)
        report["total_jobs"] = len(jobs)

        for index, job in enumerate(jobs, start=1):
            file_path = Path(str(job["file_path"]))
            print(f"[csv-soil-detail] {index}/{len(jobs)} job={job['id']} {file_path}")
            if not file_path.exists():
                item = {
                    "job_id": job["id"],
                    "project_id": job["project_id"],
                    "source_file": str(file_path),
                    "reason": "source file not found",
                }
                report["skipped"].append(item)
                print("[csv-soil-detail]   skipped:", item["reason"])
                continue

            try:
                mapping_meta = (job["result"] or {}).get("mapping", {})
                source_crs = mapping_meta.get("source_crs")
                table = csv_ingest.read_table(str(file_path))
                mapping = csv_ingest.infer_mapping(table, source_crs=source_crs)
                boreholes, issues = csv_ingest.build_boreholes(table, mapping)
                rows = csv_ingest.to_persist_rows(boreholes)
                is_supplementary = infer_is_supplementary(
                    db,
                    int(job["project_id"]),
                    str(file_path),
                )
                result = {
                    "job_id": job["id"],
                    "project_id": job["project_id"],
                    "source_file": str(file_path),
                    "borehole_count": len(boreholes),
                    "row_count": len(rows),
                    "soil_detail_counts": count_by_stratum(rows),
                    "is_supplementary": is_supplementary,
                    "issues": issues,
                }
                if args.execute:
                    persisted = service.persist_rows(
                        db=db,
                        rows=rows,
                        project_id=int(job["project_id"]),
                        source_file=str(file_path),
                        is_supplementary=is_supplementary,
                        job_id=int(job["id"]),
                    )
                    db.commit()
                    result["persisted"] = persisted
                else:
                    db.rollback()
                report["successes"].append(result)
                print("[csv-soil-detail]   ok:", result["soil_detail_counts"])
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                failure = {
                    "job_id": job["id"],
                    "project_id": job["project_id"],
                    "source_file": str(file_path),
                    "error": str(exc),
                }
                report["failures"].append(failure)
                print("[csv-soil-detail]   failed:", exc)

            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(
                json.dumps(report, ensure_ascii=False, indent=2, default=json_default),
                encoding="utf-8",
            )

    report["finished_at"] = datetime.now().isoformat()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=json_default),
        encoding="utf-8",
    )
    print("[csv-soil-detail] report_written:", args.report)
    print("[csv-soil-detail] successes:", len(report["successes"]))
    print("[csv-soil-detail] skipped:", len(report["skipped"]))
    print("[csv-soil-detail] failures:", len(report["failures"]))
    return 0 if not report["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
