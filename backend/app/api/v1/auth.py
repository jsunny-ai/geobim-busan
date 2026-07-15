"""인증 라우터.

- POST /login  : 이메일/비밀번호 → JWT → Set-Cookie
- POST /logout : 쿠키 삭제
- GET  /me     : 현재 사용자 정보
"""

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.core.security import create_access_token, verify_password
from app.models import User
from app.schemas import UserRead

router = APIRouter()

_COOKIE_KEY = "access_token"
_COOKIE_MAX_AGE = 60 * 60 * 24  # 24시간


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/login")
async def login(
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """이메일/비밀번호 검증 후 JWT 를 httpOnly 쿠키로 발급."""
    result = await db.execute(
        select(User).where(User.email == body.email, User.is_active.is_(True))
    )
    user = result.scalar_one_or_none()

    if user is None or not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="이메일 또는 비밀번호가 올바르지 않습니다.",
        )

    token = create_access_token(subject=str(user.id))
    response.set_cookie(
        key=_COOKIE_KEY,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=_COOKIE_MAX_AGE,
        # secure=True  # HTTPS 운영 환경에서 활성화
    )
    return {"ok": True, "user_id": user.id}


@router.post("/logout")
async def logout(response: Response) -> dict:
    """액세스 토큰 쿠키 삭제."""
    response.delete_cookie(_COOKIE_KEY)
    return {"ok": True}


@router.get("/me", response_model=UserRead)
async def me(current_user: User = Depends(get_current_user)) -> User:
    """현재 로그인한 사용자 정보 반환."""
    return current_user
