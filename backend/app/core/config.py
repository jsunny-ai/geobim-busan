"""애플리케이션 설정 — pydantic-settings 기반.

`.env` 파일에서 환경변수를 로드한다.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """전역 설정 객체.

    필드 추가 시 backend/.env.example 도 함께 갱신할 것.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ----- 데이터베이스 -----
    database_url: str = "postgresql+asyncpg://geobim:geobim_dev_only@localhost:5432/geobim"
    database_url_sync: str = "postgresql+psycopg2://geobim:geobim_dev_only@localhost:5432/geobim"
    # Comma-separated IDs that must exist in the intended database.
    # This prevents a healthy-but-stale PostgreSQL instance from being accepted.
    db_sentinel_project_ids: str = ""

    # ----- Redis / Celery -----
    redis_url: str = "redis://localhost:6380/0"
    celery_task_always_eager: bool = False

    # ----- PDF Convert -----
    pdf_convert_data_dir: str = "pdf_convert"
    java_bin_path: str = ""
    pdf_odl_enabled: bool = True
    pdf_odl_output_dir: str = "pdf_convert/data/odl"
    pdf_odl_timeout_seconds: int = 60
    pdf_odl_hybrid_enabled: bool = True
    pdf_odl_hybrid_url: str = "http://host.docker.internal:5002"
    pdf_odl_hybrid_mode: str = "full"
    pdf_manual_odl_enabled: bool = False
    pdf_box_ocr_enabled: bool = True
    pdf_box_ocr_lang: str = "kor+eng"
    pdf_box_ocr_scale: float = 2.0
    pdf_ocr_provider: str = "tesseract"
    pdf_ocr_timeout_seconds: int = 60
    pdf_ocr_min_confidence: float = 0.25
    pdf_paddle_ocr_lang: str = "korean"
    pdf_easyocr_langs: str = "ko,en"
    pdf_easyocr_gpu: bool = False

    # ----- 보안 -----
    secret_key: str = "change-me-in-production-min-32-chars"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60

    # ----- CORS -----
    # 콤마 구분 문자열로 받은 뒤 cors_origins_list 프로퍼티로 분해
    cors_origins: str = (
        "http://localhost:5180,"
        "http://localhost:5181,"
        "http://localhost:5182,"
        "http://localhost:5183,"
        "http://localhost:5184,"
        "http://localhost:5185"
    )

    # ----- V-World 타일 -----
    vworld_api_key: str = ""
    vworld_api_base: str = "https://api.vworld.kr"
    # 콤마 구분 V-World 2D Data API 서비스 ID. 공식 카탈로그 검증 후 운영 설정.
    vworld_water_service_ids: str = ""
    vworld_water_cache_ttl_seconds: int = 86400
    coastal_land_geojson_path: str = ""
    coastal_land_source: str = "KHOA"
    coastal_land_source_date: str = ""
    coastal_land_vertical_datum: str = "approx_highest_high_water"
    coastal_land_simplify_tolerance_deg: float = 0.000005

    @property
    def vworld_water_service_id_list(self) -> list[str]:
        return [
            service_id.strip()
            for service_id in self.vworld_water_service_ids.split(",")
            if service_id.strip()
        ]

    # ----- 환경 -----
    environment: str = "development"
    debug: bool = True

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def db_sentinel_project_id_list(self) -> list[int]:
        return [
            int(project_id.strip())
            for project_id in self.db_sentinel_project_ids.split(",")
            if project_id.strip()
        ]


settings = Settings()
