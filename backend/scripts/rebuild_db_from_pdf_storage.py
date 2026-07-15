"""Rebuild project/borehole/stratum data from the original PDF storage.

This script is intentionally conservative:
- default mode is dry-run
- existing project/borehole/stratum/extraction-job data is exported before wipe
- users and PDF templates are kept
- each PDF is parsed and committed independently

Example:
    python scripts/rebuild_db_from_pdf_storage.py --execute
    python scripts/rebuild_db_from_pdf_storage.py --execute --limit 10
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import traceback
from datetime import date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.database import SyncSessionLocal, sync_engine  # noqa: E402
from app.models import ExtractionJobStatus, PdfExtractionJob, Project, User, UserRole  # noqa: E402
from app.services.pdf_service import PdfService  # noqa: E402


DEFAULT_STORAGE = Path(r"C:\antigravity\#1_1_PDF_Download\PDF_Storage")
DEFAULT_BACKUP_DIR = ROOT / "db_backups"
TARGET_REGIONS = {"서울특별시", "경기도 수원시"}
AFFECTED_TABLES = [
    "projects",
    "project_members",
    "boreholes",
    "strata",
    "project_borehole_overrides",
    "borehole_revisions",
    "pdf_extraction_jobs",
]


def json_default(value: Any) -> str | int | float | bool | None:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return str(value) if value is not None else None


def collect_pdfs(storage: Path, regions: set[str]) -> list[tuple[str, Path]]:
    items: list[tuple[str, Path]] = []
    for region_dir in sorted((p for p in storage.iterdir() if p.is_dir()), key=lambda p: p.name):
        if regions and region_dir.name not in regions:
            continue
        for pdf in sorted(region_dir.rglob("*"), key=lambda p: str(p)):
            if pdf.is_file() and pdf.suffix.lower() == ".pdf":
                items.append((region_dir.name, pdf))
    return items


def get_counts(db) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in AFFECTED_TABLES:
        counts[table] = db.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
    return counts


def export_table(db, table: str) -> list[dict[str, Any]]:
    if table == "boreholes":
        rows = db.execute(
            text(
                """
                SELECT
                    id, project_id, name, ST_AsText(location::geometry) AS location_wkt,
                    elevation, source_crs, source_file, is_supplementary,
                    created_at, updated_at, deleted_at
                FROM boreholes
                ORDER BY id
                """
            )
        ).mappings()
    else:
        rows = db.execute(text(f"SELECT * FROM {table} ORDER BY 1")).mappings()
    return [dict(row) for row in rows]


def backup_existing_data(db, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"pre_pdf_rebuild_{stamp}.json"
    payload = {
        "created_at": datetime.now().isoformat(),
        "tables": {table: export_table(db, table) for table in AFFECTED_TABLES},
    }
    backup_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=json_default),
        encoding="utf-8",
    )
    return backup_path


def wipe_project_data(db) -> None:
    statements = [
        "DELETE FROM borehole_revisions",
        "DELETE FROM project_borehole_overrides",
        "DELETE FROM strata",
        "DELETE FROM boreholes",
        "DELETE FROM pdf_extraction_jobs",
        "DELETE FROM project_members",
        "DELETE FROM projects",
    ]
    for statement in statements:
        db.execute(text(statement))
    db.commit()


def get_or_create_owner(db) -> User:
    owner = db.query(User).order_by(User.id).first()
    if owner is not None:
        return owner
    owner = User(
        email="pdf-rebuild-admin@local",
        hashed_password="disabled",
        role=UserRole.ADMIN,
        full_name="PDF Rebuild Admin",
        is_active=True,
    )
    db.add(owner)
    db.commit()
    db.refresh(owner)
    return owner


def create_staging_project(db, owner: User) -> Project:
    project = Project(
        name="PDF 재구축 임시 프로젝트",
        owner_id=owner.id,
        description="PDF batch rebuild staging project; replaced by extracted project names.",
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def parse_and_store_pdf(db, service: PdfService, staging: Project, region: str, pdf_path: Path) -> dict[str, Any]:
    rows = service.auto_extract(str(pdf_path), pdf_path.stem)
    project_id, project_name = service.resolve_project(
        db=db,
        rows=rows,
        project_id=staging.id,
        project_name=staging.name,
        auto_project=True,
        fallback_project_name=pdf_path.stem,
    )
    project = db.get(Project, project_id)
    if project is not None:
        project.region = region
        db.add(project)

    created = service.persist_rows(
        db=db,
        rows=rows,
        project_id=project_id,
        source_file=str(pdf_path),
        is_supplementary=False,
    )
    result = {
        "project_id": project_id,
        "project_name": project_name,
        "region": region,
        "source_file": str(pdf_path),
        "borehole_count": created["borehole_count"],
        "stratum_count": created["stratum_count"],
    }
    job = PdfExtractionJob(
        project_id=project_id,
        file_path=str(pdf_path),
        status=ExtractionJobStatus.APPROVED,
        result=result,
        is_supplementary=False,
    )
    db.add(job)
    db.commit()
    return result


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=json_default), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild GeoBIM DB data from original PDF storage.")
    parser.add_argument("--storage", type=Path, default=DEFAULT_STORAGE)
    parser.add_argument("--backup-dir", type=Path, default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--execute", action="store_true", help="Actually backup, wipe, parse, and save.")
    parser.add_argument("--parse-smoke", action="store_true", help="Parse selected PDFs without backing up, wiping, or saving.")
    parser.add_argument("--limit", type=int, default=0, help="Only process the first N PDFs.")
    parser.add_argument("--region", action="append", choices=sorted(TARGET_REGIONS), help="Process one region. Can be repeated.")
    parser.add_argument("--continue-on-error", action="store_true", default=True)
    parser.add_argument("--verbose", action="store_true", help="Show parser and SQLAlchemy info logs.")
    args = parser.parse_args()

    if not args.verbose:
        sync_engine.echo = False
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
        logging.getLogger("pdf_convert").setLevel(logging.WARNING)
        logging.getLogger().setLevel(logging.WARNING)

    if not args.storage.exists():
        raise SystemExit(f"PDF storage not found: {args.storage}")

    regions = set(args.region or TARGET_REGIONS)
    pdfs = collect_pdfs(args.storage, regions)
    if args.limit > 0:
        pdfs = pdfs[: args.limit]

    with SyncSessionLocal() as db:
        before_counts = get_counts(db)

        print("[pdf-rebuild] storage:", args.storage)
        print("[pdf-rebuild] regions:", ", ".join(sorted(regions)))
        print("[pdf-rebuild] pdf_count:", len(pdfs))
        print("[pdf-rebuild] current_counts:", before_counts)

        if args.parse_smoke:
            service = PdfService()
            failures = 0
            for index, (region, pdf_path) in enumerate(pdfs, start=1):
                print(f"[pdf-rebuild] smoke {index}/{len(pdfs)} {region} :: {pdf_path.name}")
                try:
                    rows = service.auto_extract(str(pdf_path), pdf_path.stem)
                    project_name = next(
                        (
                            str(row.get("프로젝트명") or row.get("project_name")).strip()
                            for row in rows
                            if str(row.get("프로젝트명") or row.get("project_name") or "").strip()
                        ),
                        pdf_path.stem,
                    )
                    borehole_names = {
                        str(row.get("시추공명") or row.get("borehole_name") or "UNKNOWN").strip()
                        for row in rows
                    }
                    print(
                        "[pdf-rebuild]   parsed:",
                        project_name,
                        f"rows={len(rows)}",
                        f"boreholes={len(borehole_names)}",
                    )
                except Exception as exc:
                    failures += 1
                    print("[pdf-rebuild]   failed:", exc)
                    if not args.continue_on_error:
                        break
            print("[pdf-rebuild] smoke_failures:", failures)
            return 0 if failures == 0 else 1

        if not args.execute:
            print("[pdf-rebuild] dry-run only. Add --execute to backup, wipe, parse, and save.")
            return 0

        backup_path = backup_existing_data(db, args.backup_dir)
        print("[pdf-rebuild] backup_written:", backup_path)

        owner = get_or_create_owner(db)
        wipe_project_data(db)
        staging = create_staging_project(db, owner)

        report = {
            "started_at": datetime.now().isoformat(),
            "storage": str(args.storage),
            "backup_path": str(backup_path),
            "regions": sorted(regions),
            "total_files": len(pdfs),
            "successes": [],
            "failures": [],
        }
        report_path = args.backup_dir / f"pdf_rebuild_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

        service = PdfService()
        for index, (region, pdf_path) in enumerate(pdfs, start=1):
            print(f"[pdf-rebuild] {index}/{len(pdfs)} {region} :: {pdf_path.name}")
            try:
                result = parse_and_store_pdf(db, service, staging, region, pdf_path)
                report["successes"].append(result)
                print(
                    "[pdf-rebuild]   ok:",
                    result["project_name"],
                    f"BH={result['borehole_count']}",
                    f"STR={result['stratum_count']}",
                )
            except Exception as exc:
                db.rollback()
                failure = {
                    "region": region,
                    "source_file": str(pdf_path),
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                }
                report["failures"].append(failure)
                print("[pdf-rebuild]   failed:", exc)
                if not args.continue_on_error:
                    break
            finally:
                write_report(report_path, report)

        if not report["successes"]:
            raise SystemExit("No PDFs were saved successfully. Existing data is backed up but project data is empty.")

        if staging.id is not None:
            db.delete(staging)
            db.commit()

        report["finished_at"] = datetime.now().isoformat()
        report["final_counts"] = get_counts(db)
        write_report(report_path, report)
        print("[pdf-rebuild] report_written:", report_path)
        print("[pdf-rebuild] final_counts:", report["final_counts"])
        print("[pdf-rebuild] failures:", len(report["failures"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
