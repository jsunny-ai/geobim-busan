"""Pydantic 스키마 (요청/응답 DTO).

원칙:
- 모델당 Base / Create / Read 페어
- ORM 호환: model_config = ConfigDict(from_attributes=True)
- 검증 로직은 Phase 2 에서 추가 (Phase 1 은 필드 정의만)
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models import (
    ExtractionJobStatus,
    ProjectMemberRole,
    UserRole,
)


class ORMModel(BaseModel):
    """ORM 변환 가능한 베이스 스키마."""

    model_config = ConfigDict(from_attributes=True)


# ============================================================================
# User
# ============================================================================
class UserBase(BaseModel):
    email: str
    full_name: str | None = None
    role: UserRole = UserRole.DESIGNER


class UserCreate(UserBase):
    password: str = Field(min_length=8)


class UserRead(UserBase, ORMModel):
    id: int
    is_active: bool
    created_at: datetime
    updated_at: datetime


# ============================================================================
# Project
# ============================================================================
class ProjectBase(BaseModel):
    name: str
    description: str | None = None
    region: str | None = None
    source_crs: str | None = None
    bbox: dict | None = None
    creation_source: Literal["projects_ui", "upload_ui", "migration"] = "projects_ui"
    lifecycle_status: Literal["active", "archived"] = "active"
    project_kind: Literal["user_workspace", "public_source_legacy"] = "user_workspace"


class ProjectCreate(ProjectBase):
    pass


class ProjectRead(ProjectBase, ORMModel):
    id: int
    owner_id: int
    created_at: datetime
    updated_at: datetime


# ============================================================================
# ProjectMember
# ============================================================================
class ProjectMemberBase(BaseModel):
    user_id: int
    role: ProjectMemberRole = ProjectMemberRole.VIEWER


class ProjectMemberCreate(ProjectMemberBase):
    pass


class ProjectMemberRead(ProjectMemberBase, ORMModel):
    project_id: int
    created_at: datetime


# ============================================================================
# Borehole
# ============================================================================
class BoreholeBase(BaseModel):
    name: str
    # 응답 시 GeoJSON Point 형태로 직렬화 — Phase 2 에서 변환 헬퍼 추가
    longitude: float
    latitude: float
    elevation: float | None = None
    source_crs: str | None = None
    source_file: str | None = None
    survey_name: str | None = None


class BoreholeCreate(BoreholeBase):
    project_id: int


class BoreholeRead(BoreholeBase, ORMModel):
    id: int
    project_id: int
    created_at: datetime


# ============================================================================
# Stratum
# ============================================================================
class StratumBase(BaseModel):
    depth_top: float
    depth_bottom: float
    soil_type: str
    raw_text: str | None = None
    n_value: float | None = None
    uscs_code: str | None = None
    source_file: str | None = None


class StratumCreate(StratumBase):
    borehole_id: int


class StratumRead(StratumBase, ORMModel):
    id: int
    borehole_id: int
    created_at: datetime


# ============================================================================
# PdfTemplate
# ============================================================================
class BoxDefinition(BaseModel):
    """박스 1개 정의."""

    label: str = Field(description="박스 라벨 (borehole_id, coordinate, elevation 등)")
    page: int = Field(ge=1, description="페이지 번호 (1-based)")
    rect: list[float] = Field(
        min_length=4,
        max_length=4,
        description="페이지 기준 정규화 좌표 [x0, y0, x1, y1] (0~1)",
    )


class BoxDefinitions(BaseModel):
    """템플릿의 박스 정의 묶음 (JSONB 저장 형식과 1:1 대응)."""

    boxes: list[BoxDefinition]


class PdfTemplateBase(BaseModel):
    name: str
    region: str | None = None
    box_definitions: BoxDefinitions
    match_keywords: list[str] | None = None
    sample_pdf: str | None = None


class PdfTemplateCreate(PdfTemplateBase):
    pass


class PdfTemplateRead(PdfTemplateBase, ORMModel):
    id: int
    owner_id: int
    created_at: datetime
    updated_at: datetime


# ============================================================================
# PdfExtractionJob
# ============================================================================
class PdfExtractionJobBase(BaseModel):
    project_id: int
    file_path: str
    template_id: int | None = None


class PdfExtractionJobCreate(PdfExtractionJobBase):
    pass


class PdfExtractionJobRead(PdfExtractionJobBase, ORMModel):
    id: int
    status: ExtractionJobStatus
    result: dict | None = None
    error: str | None = None
    celery_task_id: str | None = None
    created_at: datetime
    updated_at: datetime
