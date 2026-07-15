"""Generate deterministic, LLM-readable database documentation.

Usage (from repository root):
    python backend/scripts/generate_db_wiki.py
    python backend/scripts/generate_db_wiki.py --check
    python backend/scripts/generate_db_wiki.py --check-live

The SQLAlchemy model is the documentation source of truth. ``--check-live``
additionally compares the deployed PostgreSQL schema with that model.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.schema import Column, MetaData, Table

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "db-wiki"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.models import Base  # noqa: E402


TABLE_DESCRIPTIONS = {
    "users": "서비스 사용자와 전역 권한",
    "projects": "시추 데이터 작업 단위와 지도 선택 영역",
    "project_members": "프로젝트별 사용자 권한",
    "boreholes": "시추공 위치·표고·원본 출처",
    "strata": "시추공별 심도 구간과 지층 분류",
    "groundwater_observations": "시추공별 지하수위 관측 이력과 추출 계보",
    "project_borehole_overrides": "공공 원본을 보존하면서 프로젝트별로 적용하는 수정안",
    "project_borehole_links": "프로젝트와 시추공의 역할·등록 작업 연결",
    "borehole_revisions": "시추공 수정 이력",
    "project_virtual_boreholes": "프로젝트에서 생성한 가상 시추공",
    "project_virtual_borehole_strata": "가상 시추공의 지층 구간",
    "project_virtual_borehole_revisions": "가상 시추공 수정 이력",
    "pdf_templates": "PDF 영역 추출 템플릿",
    "pdf_extraction_jobs": "PDF·CSV 추출 및 저장 작업 이력",
}

COLUMN_DESCRIPTIONS = {
    ("boreholes", "location"): "WGS84 경도·위도 PostGIS POINT (SRID 4326)",
    ("boreholes", "elevation"): "해수면 기준 시추공 표고(m)",
    ("boreholes", "source_crs"): "원본 평면좌표계 EPSG 코드",
    ("boreholes", "source_file"): "원본 파일 또는 추출 작업의 파일 경로",
    ("boreholes", "data_origin"): "public, user_upload, manual_input, test",
    ("boreholes", "is_supplementary"): "프로젝트 생성 후 추가 등록된 자료 여부",
    ("strata", "depth_top"): "지표면(GL) 기준 지층 상단 심도(m, 아래 방향 양수)",
    ("strata", "depth_bottom"): "지표면(GL) 기준 지층 하단 심도(m, 아래 방향 양수)",
    ("strata", "soil_type"): "추출된 지층명",
    ("strata", "raw_text"): "원본 추출 행과 레거시 메타데이터 보존 문자열",
    ("groundwater_observations", "depth_bgl_m"): "지표면(GL) 아래 지하수위 깊이(m, 아래 방향 양수)",
    ("groundwater_observations", "head_elevation_m"): "해수면(EL) 기준 지하수 수두 표고(m)",
    ("groundwater_observations", "reference_datum"): "원본 기준면: GL, EL 또는 GL+EL",
    ("groundwater_observations", "observation_key"): "업로드 재시도 중복 방지용 관측 고유키",
    ("groundwater_observations", "review_status"): "auto, confirmed, needs_review, rejected",
    ("groundwater_observations", "source_kind"): "pdf, csv, legacy_raw_text",
    ("project_borehole_links", "project_role"): "existing, new, duplicate_linked, excluded",
    ("project_borehole_links", "registered_from_job_id"): "시추공을 등록한 추출 작업",
    ("pdf_extraction_jobs", "result"): "추출 매핑·이슈·저장 결과 JSON",
    ("pdf_extraction_jobs", "is_supplementary"): "기존 프로젝트에 신규 자료로 추가하는 작업 여부",
}


def _default_text(column: Column[Any]) -> str | None:
    value = column.server_default or column.default
    if value is None:
        return None
    argument = getattr(value, "arg", value)
    if callable(argument):
        return getattr(argument, "__name__", argument.__class__.__name__)
    return str(argument)


def _column_record(table: Table, column: Column[Any]) -> dict[str, Any]:
    foreign_keys = sorted(
        {
            f"{foreign_key.column.table.name}.{foreign_key.column.name}"
            for foreign_key in column.foreign_keys
        }
    )
    return {
        "name": column.name,
        "type": str(column.type),
        "nullable": bool(column.nullable),
        "primary_key": bool(column.primary_key),
        "unique": bool(column.unique),
        "indexed": bool(column.index),
        "default": _default_text(column),
        "foreign_keys": foreign_keys,
        "description": COLUMN_DESCRIPTIONS.get((table.name, column.name)),
    }


def build_schema(metadata: MetaData) -> dict[str, Any]:
    tables: list[dict[str, Any]] = []
    for table in sorted(metadata.sorted_tables, key=lambda item: item.name):
        indexes = [
            {
                "name": index.name,
                "unique": bool(index.unique),
                "columns": [column.name for column in index.columns],
            }
            for index in sorted(table.indexes, key=lambda item: item.name or "")
        ]
        unique_constraints = sorted(
            [
                sorted(column.name for column in constraint.columns)
                for constraint in table.constraints
                if constraint.__class__.__name__ == "UniqueConstraint"
            ]
        )
        tables.append(
            {
                "name": table.name,
                "description": TABLE_DESCRIPTIONS.get(table.name),
                "columns": [_column_record(table, column) for column in table.columns],
                "indexes": indexes,
                "unique_constraints": unique_constraints,
            }
        )
    return {
        "schema_version": 1,
        "source": "backend/app/models/__init__.py:Base.metadata",
        "table_count": len(tables),
        "tables": tables,
    }


def _yes_no(value: bool) -> str:
    return "Y" if value else "N"


def render_markdown(schema: dict[str, Any]) -> str:
    lines = [
        "# GeoBIM DB Wiki — 자동 생성 스키마",
        "",
        "> 이 파일은 `backend/scripts/generate_db_wiki.py`가 생성합니다. 직접 수정하지 마세요.",
        "> 업무 의미와 계산 규칙은 [SEMANTICS.md](./SEMANTICS.md)에 기록합니다.",
        "",
        f"- 원본: `{schema['source']}`",
        f"- 테이블 수: {schema['table_count']}",
        "- 좌표 저장 기준: `boreholes.location`은 항상 WGS84(EPSG:4326)",
        "- 삭제 기준: `deleted_at IS NULL`인 행만 활성 데이터",
        "",
        "## 관계도",
        "",
        "```mermaid",
        "erDiagram",
    ]
    relationships: set[tuple[str, str]] = set()
    for table in schema["tables"]:
        for column in table["columns"]:
            for foreign_key in column["foreign_keys"]:
                target_table = foreign_key.split(".", 1)[0]
                relationships.add((target_table, table["name"]))
    for parent, child in sorted(relationships):
        lines.append(f'    {parent} ||--o{{ {child} : "참조"')
    lines.extend(["```", "", "## 테이블 목록", ""])
    for table in schema["tables"]:
        lines.append(
            f"- [`{table['name']}`](#{table['name'].replace('_', '-')})"
            f" — {table['description'] or '설명 필요'}"
        )

    for table in schema["tables"]:
        lines.extend(
            [
                "",
                f"## `{table['name']}`",
                "",
                table["description"] or "업무 설명이 아직 등록되지 않았습니다.",
                "",
                "| 컬럼 | 타입 | NULL | PK | FK | 기본값 | 설명 |",
                "|---|---|---:|---:|---|---|---|",
            ]
        )
        for column in table["columns"]:
            foreign_keys = ", ".join(f"`{value}`" for value in column["foreign_keys"]) or ""
            default = f"`{column['default']}`" if column["default"] is not None else ""
            description = (column["description"] or "").replace("|", "\\|")
            lines.append(
                f"| `{column['name']}` | `{column['type']}` | "
                f"{_yes_no(column['nullable'])} | {_yes_no(column['primary_key'])} | "
                f"{foreign_keys} | {default} | {description} |"
            )
        if table["indexes"]:
            lines.extend(["", "인덱스:"])
            for index in table["indexes"]:
                unique = " UNIQUE" if index["unique"] else ""
                lines.append(
                    f"- `{index['name']}`{unique}: "
                    + ", ".join(f"`{column}`" for column in index["columns"])
                )
        if table["unique_constraints"]:
            lines.extend(["", "고유 제약:"])
            for columns in table["unique_constraints"]:
                lines.append("- " + ", ".join(f"`{column}`" for column in columns))
    lines.append("")
    return "\n".join(lines)


def _write_or_check(path: Path, content: str, check: bool) -> bool:
    if check:
        return path.exists() and path.read_text(encoding="utf-8") == content
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def _sync_database_url(value: str) -> str:
    return value.replace("postgresql+asyncpg://", "postgresql+psycopg2://")


def check_live_schema(metadata: MetaData, database_url: str) -> list[str]:
    engine = create_engine(_sync_database_url(database_url))
    inspector = inspect(engine)
    differences: list[str] = []
    model_tables = set(metadata.tables)
    with engine.connect() as connection:
        extension_tables = {
            row[0]
            for row in connection.execute(
                text(
                    """
                    SELECT DISTINCT c.relname
                    FROM pg_class c
                    JOIN pg_depend d ON d.objid = c.oid
                    JOIN pg_extension e ON e.oid = d.refobjid
                    WHERE d.deptype = 'e' AND c.relkind IN ('r', 'p')
                    """
                )
            )
        }
    ignored_tables = extension_tables | {"alembic_version"}
    live_tables = set(inspector.get_table_names()) - ignored_tables
    for name in sorted(model_tables - live_tables):
        differences.append(f"DB에 모델 테이블이 없음: {name}")
    for name in sorted(live_tables - model_tables):
        differences.append(f"모델에 없는 DB 테이블: {name}")
    for name in sorted(model_tables & live_tables):
        model_columns = {column.name for column in metadata.tables[name].columns}
        live_columns = {column["name"] for column in inspector.get_columns(name)}
        for column in sorted(model_columns - live_columns):
            differences.append(f"DB에 모델 컬럼이 없음: {name}.{column}")
        for column in sorted(live_columns - model_columns):
            differences.append(f"모델에 없는 DB 컬럼: {name}.{column}")
    engine.dispose()
    return differences


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="생성 문서가 최신인지 검사")
    parser.add_argument("--check-live", action="store_true", help="실행 DB와 ORM 모델 비교")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"))
    args = parser.parse_args()

    schema = build_schema(Base.metadata)
    json_content = json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    markdown_content = render_markdown(schema)
    outputs = {
        args.output_dir / "schema.json": json_content,
        args.output_dir / "SCHEMA.md": markdown_content,
    }
    stale = [path for path, content in outputs.items() if not _write_or_check(path, content, args.check)]
    if stale:
        print("DB Wiki가 최신 모델과 다릅니다:")
        for path in stale:
            print(f"- {path.relative_to(REPO_ROOT)}")
        print("생성 명령: python backend/scripts/generate_db_wiki.py")
        return 1

    if args.check_live:
        if not args.database_url:
            print("--check-live에는 DATABASE_URL 또는 --database-url이 필요합니다.")
            return 2
        differences = check_live_schema(Base.metadata, args.database_url)
        if differences:
            print("실행 DB와 ORM 모델이 다릅니다:")
            for difference in differences:
                print(f"- {difference}")
            return 1
        print("실행 DB와 ORM 모델의 테이블·컬럼이 일치합니다.")

    print("DB Wiki 검사 완료." if args.check else "DB Wiki 생성 완료.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
