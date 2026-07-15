"""수원시 시추공 CSV 임포트 스크립트.

Usage:
    cd backend
    uv run python -m seeds.suwon_import <CSV경로> [--dry-run]

CSV 컬럼:
    프로젝트명, lon_wgs84, lat_wgs84, meta_crs, 표고, 시추공명, 상심도, 하심도, 지층명
"""

import asyncio
import csv
import sys
from pathlib import Path

from geoalchemy2 import WKTElement
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Borehole, Project, Stratum, User

DRY_RUN = "--dry-run" in sys.argv
CSV_PATH = next((a for a in sys.argv[1:] if not a.startswith("--")), None)


# ──────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────

def parse_row(row: dict) -> dict:
    return {
        "project_name": row["프로젝트명"].strip(),
        "lon": float(row["lon_wgs84"]),
        "lat": float(row["lat_wgs84"]),
        "meta_crs": row["meta_crs"].strip(),
        "elevation": float(row["표고"]) if row["표고"] else 0.0,
        "borehole_name": row["시추공명"].strip(),
        "depth_top": float(row["상심도"]),
        "depth_bottom": float(row["하심도"]),
        "soil_type": row["지층명"].strip(),
    }


async def main() -> None:
    if not CSV_PATH:
        print("Usage: uv run python -m seeds.suwon_import <CSV경로> [--dry-run]")
        sys.exit(1)

    csv_file = Path(CSV_PATH)
    if not csv_file.exists():
        print(f"[error] 파일 없음: {csv_file}")
        sys.exit(1)

    print(f"[import] CSV: {csv_file}")
    print(f"[import] dry_run={DRY_RUN}")

    # ── 파싱 ──────────────────────────────────
    with open(csv_file, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = [parse_row(r) for r in reader]

    print(f"[import] 총 {len(rows):,}행 파싱 완료")

    # ── 그룹핑 ────────────────────────────────
    # project_name → set of (borehole_name, lon, lat, elevation, meta_crs)
    projects: dict[str, dict] = {}
    for r in rows:
        pname = r["project_name"]
        bkey = (r["borehole_name"], r["lon"], r["lat"])
        if pname not in projects:
            projects[pname] = {
                "meta_crs": r["meta_crs"],
                "boreholes": {},
            }
        if bkey not in projects[pname]["boreholes"]:
            projects[pname]["boreholes"][bkey] = {
                "name": r["borehole_name"],
                "lon": r["lon"],
                "lat": r["lat"],
                "elevation": r["elevation"],
                "strata": [],
            }
        projects[pname]["boreholes"][bkey]["strata"].append({
            "depth_top": r["depth_top"],
            "depth_bottom": r["depth_bottom"],
            "soil_type": r["soil_type"],
        })

    total_projects = len(projects)
    total_boreholes = sum(len(p["boreholes"]) for p in projects.values())
    total_strata = len(rows)
    print(f"[import] 프로젝트={total_projects}, 시추공={total_boreholes}, 지층={total_strata}")

    if DRY_RUN:
        print("[dry-run] 실제 DB 저장 없이 종료.")
        return

    # ── DB 저장 ────────────────────────────────
    engine = create_async_engine(settings.database_url, echo=False)
    async with AsyncSession(engine) as session:
        # 관리자 사용자 확인
        result = await session.execute(
            select(User).where(User.email == "dev@geobim.local")
        )
        owner = result.scalar_one_or_none()
        if owner is None:
            print("[import] dev@geobim.local 사용자 없음. dev_seed.py 먼저 실행하세요.")
            return

        # 1 단계: 중복 방지를 위한 기존 프로젝트 정화(DELETE) 및 신규 등록
        project_id_map = {}
        for pname, pdata in projects.items():
            # 이미 동일한 이름의 프로젝트가 존재하는지 사전 조회
            existing_proj_res = await session.execute(
                select(Project).where(Project.name == pname, Project.deleted_at.is_(None))
            )
            existing_proj = existing_proj_res.scalar_one_or_none()
            if existing_proj:
                print(f"[import] 기존 프로젝트 '{pname}' 발견! 깨끗한 오버라이트를 위해 하위 시추공 및 지층 데이터를 초기화합니다...")
                from sqlalchemy import text
                # 기존 시추공 ID 목록 추출
                bh_ids_res = await session.execute(
                    select(Borehole.id).where(Borehole.project_id == existing_proj.id)
                )
                bh_ids = [row[0] for row in bh_ids_res.all()]
                if bh_ids:
                    # 지층 정화
                    await session.execute(
                        text("DELETE FROM strata WHERE borehole_id = ANY(:bh_ids)").bindparams(bh_ids=bh_ids)
                    )
                    # 시추공 정화
                    await session.execute(
                        text("DELETE FROM boreholes WHERE id = ANY(:bh_ids)").bindparams(bh_ids=bh_ids)
                    )
                # 프로젝트 정화
                await session.execute(
                    text("DELETE FROM projects WHERE id = :pid").bindparams(pid=existing_proj.id)
                )
                await session.flush()

            project = Project(
                name=pname,
                region="경기도 수원시",
                source_crs=pdata["meta_crs"],
                owner_id=owner.id,
            )
            session.add(project)
            project_id_map[pname] = project

        print("[import] Projects 벌크 등록 중...")
        await session.flush()

        # 2 단계: 모든 Borehole 메모리 등록 및 일괄 Flush
        borehole_obj_map = {}
        for pname, pdata in projects.items():
            proj_id = project_id_map[pname].id
            for bkey, bdata in pdata["boreholes"].items():
                borehole = Borehole(
                    project_id=proj_id,
                    name=bdata["name"],
                    elevation=bdata["elevation"],
                    location=WKTElement(
                        f"POINT({bdata['lon']} {bdata['lat']})", srid=4326
                    ),
                )
                session.add(borehole)
                borehole_obj_map[(proj_id, bdata["name"])] = borehole

        print("[import] Boreholes 벌크 등록 중...")
        await session.flush()

        # 3 단계: 모든 Stratum 메모리 등록 및 최종 Commit
        for pname, pdata in projects.items():
            proj_id = project_id_map[pname].id
            for bkey, bdata in pdata["boreholes"].items():
                borehole_id = borehole_obj_map[(proj_id, bdata["name"])].id
                for i, s in enumerate(bdata["strata"]):
                    stratum = Stratum(
                        borehole_id=borehole_id,
                        depth_top=s["depth_top"],
                        depth_bottom=s["depth_bottom"],
                        soil_type=s["soil_type"],
                        raw_text=s["soil_type"],
                    )
                    session.add(stratum)

        print("[import] Strata 벌크 등록 및 최종 Commit 중...")
        await session.commit()
        print(f"[import] 완료! 프로젝트={total_projects}, 시추공={total_boreholes}, 지층={total_strata}")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
