"""Restore a JSON DB snapshot into the currently configured database.

The snapshot format is produced by scripts/rebuild_db_from_pdf_storage.py.
Only project/borehole/stratum/extraction-job related tables are restored;
users and templates in the target DB are kept.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.database import SyncSessionLocal, sync_engine  # noqa: E402


DELETE_ORDER = [
    "borehole_revisions",
    "project_borehole_overrides",
    "strata",
    "boreholes",
    "pdf_extraction_jobs",
    "project_members",
    "projects",
]

RESTORE_ORDER = [
    "projects",
    "project_members",
    "boreholes",
    "strata",
    "project_borehole_overrides",
    "borehole_revisions",
    "pdf_extraction_jobs",
]

SEQUENCES = {
    "projects": "projects_id_seq",
    "boreholes": "boreholes_id_seq",
    "strata": "strata_id_seq",
    "project_borehole_overrides": "project_borehole_overrides_id_seq",
    "borehole_revisions": "borehole_revisions_id_seq",
    "pdf_extraction_jobs": "pdf_extraction_jobs_id_seq",
}


def normalize_value(value: Any) -> Any:
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False)
    return value


def insert_row(db, table: str, row: dict[str, Any]) -> None:
    if not row:
        return

    if table == "boreholes":
        data = {k: normalize_value(v) for k, v in row.items() if k != "location_wkt"}
        cols = list(data.keys()) + ["location"]
        placeholders = [f":{col}" for col in data.keys()] + ["ST_GeogFromText(:location_wkt)"]
        data["location_wkt"] = row["location_wkt"]
    else:
        data = {k: normalize_value(v) for k, v in row.items()}
        cols = list(data.keys())
        placeholders = [f":{col}" for col in cols]

    quoted_cols = ", ".join(cols)
    placeholder_sql = ", ".join(placeholders)
    db.execute(text(f"INSERT INTO {table} ({quoted_cols}) VALUES ({placeholder_sql})"), data)


def reset_sequence(db, table: str, sequence: str) -> None:
    max_id = db.execute(text(f"SELECT COALESCE(MAX(id), 0) FROM {table}")).scalar_one()
    db.execute(text("SELECT setval(:seq, :value, :called)"), {
        "seq": sequence,
        "value": max(max_id, 1),
        "called": max_id > 0,
    })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    if not args.snapshot.exists():
        raise SystemExit(f"Snapshot not found: {args.snapshot}")

    payload = json.loads(args.snapshot.read_text(encoding="utf-8"))
    tables: dict[str, list[dict[str, Any]]] = payload.get("tables") or {}

    print("[restore] snapshot:", args.snapshot)
    for table in RESTORE_ORDER:
        print(f"[restore] {table}: {len(tables.get(table, []))}")

    if not args.execute:
        print("[restore] dry-run only. Add --execute to restore.")
        return 0

    sync_engine.echo = False
    with SyncSessionLocal() as db:
        for table in DELETE_ORDER:
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()

        for table in RESTORE_ORDER:
            for row in tables.get(table, []):
                insert_row(db, table, row)
            db.commit()
            print(f"[restore] inserted {table}: {len(tables.get(table, []))}")

        for table, sequence in SEQUENCES.items():
            reset_sequence(db, table, sequence)
        db.commit()

        counts = {}
        for table in ["projects", "boreholes", "strata", "pdf_extraction_jobs"]:
            counts[table] = db.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
        print("[restore] final_counts:", counts)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
