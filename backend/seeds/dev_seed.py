"""Development seed data.

Usage:
    cd backend
    uv run python -m seeds.dev_seed

Creates or repairs:
    - user: kunhwa / 1234  (role=admin)
"""

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.core.security import hash_password
from app.models import User, UserRole


async def main() -> None:
    engine = create_async_engine(settings.database_url, echo=False)

    async with AsyncSession(engine) as session:
        result = await session.execute(
            select(User).where(User.email == "kunhwa")
        )
        existing = result.scalar_one_or_none()

        if existing is not None:
            email, user_id = existing.email, existing.id  # commit 후 lazy refresh 방지
            existing.hashed_password = hash_password("1234")
            existing.role = UserRole.ADMIN
            existing.full_name = existing.full_name or "Dev User"
            existing.is_active = True
            await session.commit()
            print(f"[seed] repaired user: {email} (id={user_id})")
        else:
            user = User(
                email="kunhwa",
                hashed_password=hash_password("1234"),
                role=UserRole.ADMIN,
                full_name="Dev User",
                is_active=True,
            )
            session.add(user)
            await session.commit()
            await session.refresh(user)
            print(f"[seed] created user: {user.email} (id={user.id})")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
