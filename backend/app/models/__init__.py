"""SQLAlchemy ORM 모델 정의.

전체 7개 테이블 + 공통 베이스 클래스.

스타일 가이드:
- SQLAlchemy 2.x DeclarativeBase + Mapped[] / mapped_column
- 모든 테이블에 공통 컬럼(id, created_at, updated_at, deleted_at) 적용
- deleted_at IS NOT NULL → soft delete
- 시추공 location 은 PostGIS Geography(POINT, 4326) — 위경도(WGS84)
"""

from __future__ import annotations

import enum
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


# ============================================================================
# 베이스 / 공통 믹스인
# ============================================================================
class Base(DeclarativeBase):
    """모든 ORM 모델의 베이스 클래스."""


class TimestampMixin:
    """공통 타임스탬프 컬럼 (생성/수정/soft delete)."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


# ============================================================================
# 열거형
# ============================================================================
class UserRole(str, enum.Enum):
    """사용자 역할.

    - DESIGNER : 토목 설계자
    - EXPERT   : 지반 전문가
    - REVIEWER : 발주처 / 감리
    - ADMIN    : 시스템 관리자
    """

    DESIGNER = "designer"
    EXPERT = "expert"
    REVIEWER = "reviewer"
    ADMIN = "admin"


class ProjectMemberRole(str, enum.Enum):
    """프로젝트 내 멤버 역할 (User.role 과는 별개로 프로젝트별 권한)."""

    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class ExtractionJobStatus(str, enum.Enum):
    """PDF 추출 작업 상태."""

    PENDING = "pending"
    RUNNING = "running"
    AWAITING_REVIEW = "awaiting_review"
    APPROVED = "approved"
    FAILED = "failed"


# ============================================================================
# User
# ============================================================================
class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=UserRole.DESIGNER,
    )
    full_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

    # 관계
    owned_projects: Mapped[list[Project]] = relationship(
        back_populates="owner", foreign_keys="Project.owner_id"
    )
    memberships: Mapped[list[ProjectMember]] = relationship(back_populates="user")
    owned_templates: Mapped[list[PdfTemplate]] = relationship(back_populates="owner")


# ============================================================================
# Project
# ============================================================================
class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False, index=True
    )
    region: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    # 원본 좌표계 EPSG 코드 (예: 5174~5187 한국 중부원점 시리즈)
    source_crs: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # 프로젝트 경계 박스 (GeoJSON BBox: [minX, minY, maxX, maxY])
    bbox: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    creation_source: Mapped[str] = mapped_column(
        String(30), nullable=False, default="projects_ui", server_default="migration"
    )
    lifecycle_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", server_default="active", index=True
    )
    project_kind: Mapped[str] = mapped_column(
        String(30), nullable=False, default="user_workspace",
        server_default="user_workspace", index=True
    )

    # 관계
    owner: Mapped[User] = relationship(
        back_populates="owned_projects", foreign_keys=[owner_id]
    )
    members: Mapped[list[ProjectMember]] = relationship(back_populates="project")
    boreholes: Mapped[list[Borehole]] = relationship(back_populates="project")
    borehole_links: Mapped[list[ProjectBoreholeLink]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    virtual_boreholes: Mapped[list[ProjectVirtualBorehole]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    extraction_jobs: Mapped[list[PdfExtractionJob]] = relationship(back_populates="project")


# ============================================================================
# ProjectMember (Project ↔ User 다대다 + 역할)
# ============================================================================
class ProjectMember(Base, TimestampMixin):
    __tablename__ = "project_members"

    project_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[ProjectMemberRole] = mapped_column(
        Enum(ProjectMemberRole, name="project_member_role", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=ProjectMemberRole.VIEWER,
    )

    # 관계
    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships")


# ============================================================================
# Borehole (시추공)
# ============================================================================
class Borehole(Base, TimestampMixin):
    __tablename__ = "boreholes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)

    # PostGIS Geography (POINT, WGS84). 항상 위경도로 저장 — 원본 좌표계는 source_crs 에 별도 기록.
    location: Mapped[str] = mapped_column(
        Geography(geometry_type="POINT", srid=4326),
        nullable=False,
    )
    elevation: Mapped[float | None] = mapped_column(Float, nullable=True)

    # 원본 좌표계 (EPSG:5174 등)
    source_crs: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # 원본 파일 경로 (또는 외부 식별자)
    source_file: Mapped[str | None] = mapped_column(String(500), nullable=True)
    survey_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    # 보완 시추공 여부 (False=기존 원본, True=사후 추가 신규)
    is_supplementary: Mapped[bool] = mapped_column(default=False, nullable=False)
    # 전역 데이터 출처: public, user_upload, manual_input, test
    data_origin: Mapped[str] = mapped_column(String(30), default="public", nullable=False, index=True)

    # 관계
    project: Mapped[Project] = relationship(back_populates="boreholes")
    strata: Mapped[list[Stratum]] = relationship(
        back_populates="borehole", cascade="all, delete-orphan"
    )
    project_links: Mapped[list[ProjectBoreholeLink]] = relationship(
        back_populates="borehole", cascade="all, delete-orphan"
    )
    project_overrides: Mapped[list[ProjectBoreholeOverride]] = relationship(
        back_populates="source_borehole", cascade="all, delete-orphan"
    )
    groundwater_observations: Mapped[list[GroundwaterObservation]] = relationship(
        back_populates="borehole",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class GroundwaterObservation(Base, TimestampMixin):
    """A source-traceable groundwater observation for one borehole."""

    __tablename__ = "groundwater_observations"
    __table_args__ = (
        UniqueConstraint("observation_key", name="uq_groundwater_observation_key"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    extraction_job_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("pdf_extraction_jobs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    observation_key: Mapped[str] = mapped_column(String(200), nullable=False)
    depth_bgl_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    head_elevation_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reference_datum: Mapped[str] = mapped_column(String(10), nullable=False)
    raw_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_kind: Mapped[str] = mapped_column(String(30), nullable=False, default="pdf")
    source_page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_bbox: Mapped[list | dict | None] = mapped_column(JSON, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    review_status: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="auto",
        index=True,
    )

    borehole: Mapped[Borehole] = relationship(back_populates="groundwater_observations")
    extraction_job: Mapped[PdfExtractionJob | None] = relationship()


# ============================================================================
# Stratum (지층)
# ============================================================================
class Stratum(Base, TimestampMixin):
    """시추공 1개 안의 지층 1개 레이어.

    soil_type 은 5대 대분류로 정규화 (PDF_Convert 의 정규화 함수 통과 후):
      - 토사 (soil)
      - 풍화암 (weathered_rock)
      - 연암 (soft_rock)
      - 보통암 (normal_rock)
      - 경암 (hard_rock)
    """

    __tablename__ = "strata"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    depth_top: Mapped[float] = mapped_column(Float, nullable=False)
    depth_bottom: Mapped[float] = mapped_column(Float, nullable=False)
    soil_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    n_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    uscs_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    source_file: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # 관계
    borehole: Mapped[Borehole] = relationship(back_populates="strata")


# ============================================================================
# PdfTemplate (박스 추출 템플릿)
# ============================================================================
class ProjectBoreholeOverride(Base, TimestampMixin):
    __tablename__ = "project_borehole_overrides"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft", index=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)

    project: Mapped[Project] = relationship()
    source_borehole: Mapped[Borehole] = relationship(back_populates="project_overrides")


class ProjectBoreholeLink(Base, TimestampMixin):
    """프로젝트별 시추공 사용 상태.

    data_origin은 boreholes의 전역 출처이고, project_role은 현재 프로젝트에서
    신규/기존/제외로 보여줄지를 결정하는 관계 속성이다.
    """

    __tablename__ = "project_borehole_links"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # existing, new, duplicate_linked, excluded
    project_role: Mapped[str] = mapped_column(String(30), nullable=False, default="existing", index=True)
    # bbox_selected, pdf_uploaded, manual_created, duplicate_detected, migrated, test_excluded
    linked_reason: Mapped[str] = mapped_column(String(50), nullable=False, default="migrated", index=True)
    registered_from_job_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("pdf_extraction_jobs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    registered_by_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)

    project: Mapped[Project] = relationship(back_populates="borehole_links")
    borehole: Mapped[Borehole] = relationship(back_populates="project_links")
    registered_from_job: Mapped[PdfExtractionJob | None] = relationship()


class BoreholeRevision(Base, TimestampMixin):
    """시추공 개정 이력 — 원본 불변, 버전별 누적 (v4.2).

    원본(boreholes/strata) = v0 으로 간주하며 절대 직접 수정하지 않는다.
    수정할 때마다 version 1, 2, 3... 으로 누적되고, payload 는 해당 버전의
    '완전한 스냅샷'({"elevation": float|None, "strata": [...]})이라 어떤 과거
    버전도 그대로 열람할 수 있다. 복원 역시 새 버전으로 기록(restored_from)
    되어 이력이 끊기지 않는다. effective 값 = 최신 버전 적용 결과.
    """

    __tablename__ = "borehole_revisions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    edited_by_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    restored_from: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ProjectVirtualBorehole(Base, TimestampMixin):
    """Project-scoped interpretation control that is never an observed borehole."""

    __tablename__ = "project_virtual_boreholes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    location: Mapped[str] = mapped_column(
        Geography(geometry_type="POINT", srid=4326), nullable=False
    )
    elevation: Mapped[float] = mapped_column(Float, nullable=False)
    total_depth: Mapped[float] = mapped_column(Float, nullable=False)
    source_borehole_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("boreholes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)
    model_enabled: Mapped[bool] = mapped_column(default=False, nullable=False, index=True)
    constraint_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="hard")
    influence_weight: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    influence_radius_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    purpose: Mapped[str | None] = mapped_column(String(200), nullable=True)
    interpretation_note: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)

    project: Mapped[Project] = relationship(back_populates="virtual_boreholes")
    source_borehole: Mapped[Borehole | None] = relationship()
    strata: Mapped[list[ProjectVirtualBoreholeStratum]] = relationship(
        back_populates="virtual_borehole",
        cascade="all, delete-orphan",
        order_by="ProjectVirtualBoreholeStratum.sequence",
    )
    revisions: Mapped[list[ProjectVirtualBoreholeRevision]] = relationship(
        back_populates="virtual_borehole", cascade="all, delete-orphan"
    )


class ProjectVirtualBoreholeStratum(Base, TimestampMixin):
    __tablename__ = "project_virtual_borehole_strata"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    virtual_borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("project_virtual_boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    depth_top: Mapped[float] = mapped_column(Float, nullable=False)
    depth_bottom: Mapped[float] = mapped_column(Float, nullable=False)
    soil_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    strata_group: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    confidence: Mapped[str] = mapped_column(String(20), nullable=False, default="medium")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    virtual_borehole: Mapped[ProjectVirtualBorehole] = relationship(back_populates="strata")


class ProjectVirtualBoreholeRevision(Base, TimestampMixin):
    __tablename__ = "project_virtual_borehole_revisions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    virtual_borehole_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("project_virtual_boreholes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    change_reason: Mapped[str] = mapped_column(Text, nullable=False)
    changed_by_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)

    virtual_borehole: Mapped[ProjectVirtualBorehole] = relationship(back_populates="revisions")


class PdfTemplate(Base, TimestampMixin):
    """PDF 박스 추출 템플릿.

    box_definitions JSONB 스키마 (자세히는 docs/PDF_EXTRACTION_DESIGN.md 참고):
      {
        "boxes": [
          {"label": "borehole_id", "page": 1, "rect": [0.1, 0.05, 0.3, 0.1]},
          ...
        ]
      }
    rect 는 페이지 기준 정규화 좌표(0~1).
    """

    __tablename__ = "pdf_templates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    owner_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False, index=True
    )
    region: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    # 박스 정의 JSONB
    box_definitions: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # 자동 매칭에 사용할 키워드 목록 (JSONB 배열 권장)
    match_keywords: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 샘플 PDF 경로
    sample_pdf: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # 관계
    owner: Mapped[User] = relationship(back_populates="owned_templates")
    extraction_jobs: Mapped[list[PdfExtractionJob]] = relationship(back_populates="template")


# ============================================================================
# PdfExtractionJob (PDF 추출 작업)
# ============================================================================
class PdfExtractionJob(Base, TimestampMixin):
    __tablename__ = "pdf_extraction_jobs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[ExtractionJobStatus] = mapped_column(
        Enum(ExtractionJobStatus, name="extraction_job_status", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=ExtractionJobStatus.PENDING,
        index=True,
    )
    template_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("pdf_templates.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 추출 결과 (JSONB) — 박스별 텍스트 + 파싱된 시추공/지층 데이터
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Celery task id (취소/재시도용)
    celery_task_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # 보완 시추공 여부 — upload 연동 모드에서 True로 세팅
    is_supplementary: Mapped[bool] = mapped_column(default=False, nullable=False)

    # 관계
    project: Mapped[Project] = relationship(back_populates="extraction_jobs")
    template: Mapped[PdfTemplate | None] = relationship(back_populates="extraction_jobs")


# ============================================================================
# 명시적 export 목록 (Alembic autogenerate 가 모든 모델을 인식하도록)
# ============================================================================
__all__ = [
    "Base",
    "TimestampMixin",
    "UserRole",
    "ProjectMemberRole",
    "ExtractionJobStatus",
    "User",
    "Project",
    "ProjectMember",
    "Borehole",
    "GroundwaterObservation",
    "Stratum",
    "ProjectBoreholeOverride",
    "ProjectBoreholeLink",
    "BoreholeRevision",
    "ProjectVirtualBorehole",
    "ProjectVirtualBoreholeStratum",
    "ProjectVirtualBoreholeRevision",
    "PdfTemplate",
    "PdfExtractionJob",
]
