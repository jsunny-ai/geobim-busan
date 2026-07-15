"""통합_결과.json 파일 임포트 스크립트.

Usage:
    cd backend
    uv run python -m seeds.json_import <JSON경로>
"""

import asyncio
import json
import sys
from pathlib import Path

from geoalchemy2 import WKTElement
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Borehole, Project, Stratum, User

# soil_type을 공통 색상 기준으로 매핑하는 간단한 규칙 적용
SOIL_MAP = {
    "매립층": "soil",
    "퇴적토": "soil",
    "실트질모래": "soil",
    "풍화토": "soil",
    "풍화암": "weathered_rock",
    "연암": "soft_rock",
    "보통암": "hard_rock",
    "경암": "hard_rock",
}

def map_soil_type(raw_type: str) -> str:
    # 기본적으로 raw_type을 그대로 반환하나, 프론트엔드 색상 구분을 위해 매핑할 수 있음
    for k, v in SOIL_MAP.items():
        if k in raw_type:
            return v
    return "soil"

async def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: uv run python -m seeds.json_import <JSON경로>")
        sys.exit(1)

    json_file = Path(sys.argv[1])
    if not json_file.exists():
        print(f"[error] 파일 없음: {json_file}")
        sys.exit(1)

    print(f"[import] JSON: {json_file}")

    with open(json_file, encoding="utf-8", errors="replace") as f:
        data = json.load(f)

    engine = create_async_engine(settings.database_url, echo=False)
    async with AsyncSession(engine) as session:
        # 1. 관리자 유저 확인
        result = await session.execute(
            select(User).where(User.email == "dev@geobim.local")
        )
        owner = result.scalar_one_or_none()
        if owner is None:
            print("[import] dev@geobim.local 사용자 없음. 먼저 생성합니다.")
            owner = User(
                email="dev@geobim.local",
                hashed_password="dummy",
                full_name="Dev",
                is_active=True
            )
            session.add(owner)
            await session.commit()
            await session.refresh(owner)

        projects_data = data.get("projects", [])
        if not projects_data:
            print("No projects found in JSON.")
            return

        print("[import] Projects 벌크 등록 중...")
        for pdata in projects_data:
            pname = pdata.get("project_name", "Unknown Project")
            
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
                source_crs="EPSG:5186",
                owner_id=owner.id,
            )
            session.add(project)
            await session.flush()
            proj_id = project.id

            boreholes_data = pdata.get("boreholes", [])
            print(f"  -> Project '{pname}': {len(boreholes_data)} boreholes")
            
            for bdata in boreholes_data:
                bh_name = bdata.get("borehole_id", "Unknown")
                lon = bdata.get("longitude", 0.0)
                lat = bdata.get("latitude", 0.0)
                elev = bdata.get("elevation", 0.0)
                
                borehole = Borehole(
                    project_id=proj_id,
                    name=bh_name,
                    elevation=elev,
                    location=WKTElement(f"POINT({lon} {lat})", srid=4326),
                )
                session.add(borehole)
                await session.flush()
                bh_id = borehole.id

                strata_data = bdata.get("strata", [])
                seen_strata = set()
                for sdata in strata_data:
                    raw_type = sdata.get("soil_type", "Unknown")
                    mapped_type = map_soil_type(raw_type)
                    dt = sdata.get("depth_top", 0.0)
                    db = sdata.get("depth_bottom", 0.0)
                    
                    # 지층 유니크 제약조건 충돌 방지를 위한 중복 스킵 처리
                    key = (bh_id, dt, db, mapped_type)
                    if key in seen_strata:
                        continue
                    seen_strata.add(key)
                    
                    stratum = Stratum(
                        borehole_id=bh_id,
                        depth_top=dt,
                        depth_bottom=db,
                        soil_type=mapped_type,
                        raw_text=raw_type,
                    )
                    session.add(stratum)

        print("[import] 모든 데이터 등록 및 최종 Commit 중...")
        await session.commit()
        print("[import] 완료!")

    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(main())
