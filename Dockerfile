# =============================================================================
# GeoBIM Stratum — Backend Dockerfile
#
# 빌드: docker build -t geobim-backend .
# 실행: docker compose -f docker-compose.prod.yml up
#
# 스테이지:
#   builder  — 의존성 설치 (pip wheel 캐싱)
#   runtime  — 최소 이미지 (wheel 복사, 소스만 포함)
# =============================================================================

# ── 1. builder ──────────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# 시스템 의존성 (geoalchemy2 → libgeos, psycopg2 빌드 → libpq-dev)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    libgeos-dev \
    && rm -rf /var/lib/apt/lists/*

# pip 업그레이드 + wheel 빌드
COPY backend/pyproject.toml ./
RUN pip install --upgrade pip \
 && pip wheel --no-cache-dir --wheel-dir /wheels \
    "fastapi>=0.115" \
    "uvicorn[standard]>=0.32" \
    "python-multipart>=0.0.9" \
    "sqlalchemy[asyncio]>=2.0" \
    "asyncpg>=0.29" \
    "psycopg2-binary>=2.9" \
    "alembic>=1.13" \
    "geoalchemy2>=0.15" \
    "pydantic>=2.9" \
    "pydantic-settings>=2.5" \
    "email-validator>=2.0" \
    "dnspython>=2.0" \
    "python-jose[cryptography]>=3.3" \
    "bcrypt==3.2.2" \
    "passlib[bcrypt]>=1.7" \
    "celery[redis]>=5.4" \
    "redis>=5.0" \
    "pymupdf>=1.24" \
    "httpx>=0.27" \
    "numpy>=1.26" \
    "scipy>=1.12" \
    "pyproj>=3.6" \
    "shapely>=2.0" \
    "opendataloader-pdf>=0.0.0" \
    "pillow>=10.0" \
    "pytesseract>=0.3.13" \
    "openpyxl>=3.1"

# ── 2. runtime ──────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# 런타임 시스템 의존성만 (빌드 도구 제외)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    libgeos-c1v5 \
    openjdk-21-jre \
    tesseract-ocr \
    tesseract-ocr-kor \
    tesseract-ocr-eng \
    curl \
    && rm -rf /var/lib/apt/lists/*

# wheel 설치
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels /wheels/* \
 && rm -rf /wheels

# 비루트 사용자 (보안)
RUN useradd -m -u 1000 appuser

# 소스 복사 (backend/) — 복사 단계에서 소유권을 지정해 대용량 데이터 재귀 chown 방지
COPY --chown=appuser:appuser backend/ .
USER appuser

# Alembic 마이그레이션 후 uvicorn 실행
# docker-compose 의 command 로 override 가능
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]

EXPOSE 8000
