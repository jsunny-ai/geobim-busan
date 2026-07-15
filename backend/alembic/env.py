"""Alembic env.py — async SQLAlchemy 패턴.

settings.database_url 을 직접 사용하여 비동기 엔진 생성. autogenerate 대상은
`app.models.Base.metadata`. geoalchemy2 의 Geography 타입도 모델 임포트 시
자동으로 등록된다.
"""

from __future__ import annotations

import asyncio
import sys
from logging.config import fileConfig

# Windows ProactorEventLoop has issues with WSL2 port forwarding.
# Use SelectorEventLoop as a workaround.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# 모델 메타데이터 등록 — 이 import 가 있어야 autogenerate 가 동작
from app.core.config import settings
from app.models import Base  # noqa: F401  (메타데이터 등록 목적)
from app import models  # noqa: F401  (전체 모델 클래스 임포트)

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """오프라인 마이그레이션 (SQL 출력만)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=False,
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
