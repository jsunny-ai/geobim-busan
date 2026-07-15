"""PDF 박스 템플릿 라우터 — Phase 2 에서 구현.

예정 엔드포인트:
- GET    /            : 템플릿 목록 (region/owner 필터)
- POST   /            : 신규 템플릿 생성 (사용자가 그린 박스 정의 저장)
- GET    /{id}        : 템플릿 상세 (box_definitions 포함)
- PATCH  /{id}        : 박스 정의 수정
- DELETE /{id}        : 템플릿 soft delete
- POST   /{id}/clone  : 템플릿 복제 (신규 양식 베이스로)
"""

from fastapi import APIRouter

router = APIRouter()
