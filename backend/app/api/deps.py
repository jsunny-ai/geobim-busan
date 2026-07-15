"""Common FastAPI dependencies."""

from fastapi import Cookie, Depends, HTTPException, status
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db  # noqa: F401  (re-export)
from app.core.security import decode_token
from app.models import User


async def _get_development_user(db: AsyncSession) -> User | None:
    if settings.environment != "development":
        return None

    result = await db.execute(select(User).where(User.is_active.is_(True)).limit(1))
    return result.scalar_one_or_none()


async def get_current_user(
    db: AsyncSession = Depends(get_db),
    access_token: str | None = Cookie(default=None),
) -> User:
    """Return the current user from an httpOnly JWT cookie."""
    if access_token is None:
        mock_user = await _get_development_user(db)
        if mock_user:
            return mock_user
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    try:
        payload = decode_token(access_token)
        user_id_str: str | None = payload.get("sub")
        if user_id_str is None:
            raise ValueError("token subject is missing")
        user_id = int(user_id_str)
    except (JWTError, ValueError):
        mock_user = await _get_development_user(db)
        if mock_user:
            return mock_user
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    result = await db.execute(
        select(User).where(User.id == user_id, User.is_active.is_(True))
    )
    user = result.scalar_one_or_none()
    if user is None:
        mock_user = await _get_development_user(db)
        if mock_user:
            return mock_user
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user
