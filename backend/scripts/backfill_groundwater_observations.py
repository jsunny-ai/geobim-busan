"""Backfill first-class groundwater observations from legacy strata.raw_text.

Dry-run is the default:
    python scripts/backfill_groundwater_observations.py
    python scripts/backfill_groundwater_observations.py --apply
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.database import SyncSessionLocal
from app.models import Borehole, GroundwaterObservation
from app.services.groundwater import legacy_groundwater_depth


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="검출된 값을 실제 DB에 저장")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--quiet", action="store_true", help="개별 시추공 출력 생략")
    args = parser.parse_args()

    scanned = detected = skipped_existing = created = 0
    with SyncSessionLocal() as db:
        statement = (
            select(Borehole)
            .options(
                selectinload(Borehole.strata),
                selectinload(Borehole.groundwater_observations),
            )
            .where(Borehole.deleted_at.is_(None))
            .order_by(Borehole.id)
        )
        if args.limit:
            statement = statement.limit(args.limit)

        for borehole in db.execute(statement).scalars().unique():
            scanned += 1
            active = [
                observation
                for observation in borehole.groundwater_observations
                if observation.deleted_at is None
            ]
            if active:
                skipped_existing += 1
                continue

            depth = legacy_groundwater_depth(list(borehole.strata))
            if depth is None:
                continue
            detected += 1
            head = (
                float(borehole.elevation) - depth
                if borehole.elevation is not None
                else None
            )
            if not args.quiet:
                print(
                    f"borehole={borehole.id} name={borehole.name!r} "
                    f"depth_bgl_m={depth} head_elevation_m={head}"
                )
            if not args.apply:
                continue

            db.add(
                GroundwaterObservation(
                    borehole_id=borehole.id,
                    extraction_job_id=None,
                    observation_key=f"legacy:borehole:{borehole.id}:raw_text",
                    depth_bgl_m=depth,
                    head_elevation_m=head,
                    reference_datum="GL",
                    raw_value=depth,
                    raw_text="Migrated from strata.raw_text",
                    source_kind="legacy_raw_text",
                    confidence=0.6,
                    review_status="auto",
                )
            )
            created += 1

        if args.apply:
            db.commit()
        else:
            db.rollback()

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"{mode}: scanned={scanned} detected={detected} "
        f"skipped_existing={skipped_existing} created={created}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
