"""Safely re-extract existing PDF boreholes without wiping the database.

This script is for the soil-detail preservation rollout. It parses PDFs from the
mounted storage path, maps each PDF back to the existing Windows-style
`boreholes.source_file`, and calls PdfService.persist_rows with that source file.
The existing same-source upsert path then replaces strata for matching boreholes.

Default mode is dry-run.
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
from app.services.pdf_service import PdfService  # noqa: E402


DEFAULT_STORAGE = Path("/pdf_storage")
DEFAULT_WINDOWS_ROOT = r"C:\antigravity\#1_1_PDF_Download\PDF_Storage"
TARGET_REGIONS = {"서울특별시", "경기도 수원시"}


def json_default(value: Any) -> str | int | float | bool | None:
    if isinstance(value, datetime):
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


def to_windows_source_file(pdf_path: Path, storage: Path, windows_root: str) -> str:
    rel = pdf_path.relative_to(storage)
    return windows_root.rstrip("\\/") + "\\" + "\\".join(rel.parts)


def existing_project_id(db, source_file: str) -> int | None:
    rows = db.execute(
        text(
            """
            SELECT project_id, count(*) AS borehole_count
            FROM boreholes
            WHERE source_file = :source_file
              AND deleted_at IS NULL
            GROUP BY project_id
            ORDER BY borehole_count DESC
            """
        ),
        {"source_file": source_file},
    ).mappings().all()
    if len(rows) != 1:
        return None
    return int(rows[0]["project_id"])


def soil_detail_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    return dict(Counter(str(row.get("지층명") or "미분류") for row in rows))


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely re-extract soil-detail PDF rows.")
    parser.add_argument("--storage", type=Path, default=DEFAULT_STORAGE)
    parser.add_argument("--windows-root", default=DEFAULT_WINDOWS_ROOT)
    parser.add_argument("--region", action="append", choices=sorted(TARGET_REGIONS))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--report", type=Path, default=Path("/tmp/soil_detail_reextract_report.json"))
    args = parser.parse_args()

    if not args.storage.exists():
        raise SystemExit(f"PDF storage not found: {args.storage}")

    regions = set(args.region or TARGET_REGIONS)
    pdfs = collect_pdfs(args.storage, regions)
    if args.limit > 0:
        pdfs = pdfs[: args.limit]

    service = PdfService()
    report: dict[str, Any] = {
        "started_at": datetime.now().isoformat(),
        "execute": args.execute,
        "storage": str(args.storage),
        "regions": sorted(regions),
        "total_files": len(pdfs),
        "successes": [],
        "skipped": [],
        "failures": [],
    }

    with SyncSessionLocal() as db:
        for index, (region, pdf_path) in enumerate(pdfs, start=1):
            source_file = to_windows_source_file(pdf_path, args.storage, args.windows_root)
            print(f"[soil-detail-reextract] {index}/{len(pdfs)} {region} :: {pdf_path.name}")
            project_id = existing_project_id(db, source_file)
            if project_id is None:
                item = {
                    "region": region,
                    "pdf_path": str(pdf_path),
                    "source_file": source_file,
                    "reason": "existing source_file not found or ambiguous",
                }
                report["skipped"].append(item)
                print("[soil-detail-reextract]   skipped:", item["reason"])
                continue

            try:
                rows = service.auto_extract(str(pdf_path), pdf_path.stem)
                result = {
                    "region": region,
                    "pdf_path": str(pdf_path),
                    "source_file": source_file,
                    "project_id": project_id,
                    "row_count": len(rows),
                    "soil_detail_counts": soil_detail_counts(rows),
                }
                if args.execute:
                    persisted = service.persist_rows(
                        db=db,
                        rows=rows,
                        project_id=project_id,
                        source_file=source_file,
                        is_supplementary=False,
                    )
                    db.commit()
                    result["persisted"] = persisted
                else:
                    db.rollback()
                report["successes"].append(result)
                print("[soil-detail-reextract]   ok:", result["soil_detail_counts"])
            except Exception as exc:
                db.rollback()
                failure = {
                    "region": region,
                    "pdf_path": str(pdf_path),
                    "source_file": source_file,
                    "project_id": project_id,
                    "error": str(exc),
                }
                report["failures"].append(failure)
                print("[soil-detail-reextract]   failed:", exc)

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
    print("[soil-detail-reextract] report_written:", args.report)
    print("[soil-detail-reextract] successes:", len(report["successes"]))
    print("[soil-detail-reextract] skipped:", len(report["skipped"]))
    print("[soil-detail-reextract] failures:", len(report["failures"]))
    return 0 if not report["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
