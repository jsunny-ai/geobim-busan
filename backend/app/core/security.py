"""JWT / 비밀번호 해시 스텁.

Phase 1 에서는 함수 시그니처만 마련하고, 실제 인증 흐름은 Phase 2 에서 구현한다.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# ----- 비밀번호 해시 컨텍스트 -----
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain_password: str) -> str:
    """평문 비밀번호를 bcrypt 로 해시."""
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """bcrypt 해시 검증."""
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(
    subject: str | int,
    expires_delta: timedelta | None = None,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    """JWT 액세스 토큰 발급.

    Args:
        subject: 토큰의 sub 클레임 (보통 user_id 또는 email)
        expires_delta: 만료 시간 (None 이면 settings.jwt_expire_minutes 사용)
        extra_claims: 추가 클레임 (role 등)
    """
    expire = datetime.now(UTC) + (
        expires_delta or timedelta(minutes=settings.jwt_expire_minutes)
    )
    to_encode: dict[str, Any] = {
        "sub": str(subject),
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    if extra_claims:
        to_encode.update(extra_claims)
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict[str, Any]:
    """JWT 디코드 및 검증.

    Raises:
        JWTError: 토큰이 유효하지 않거나 만료된 경우
    """
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise
