"""PDF 박스 템플릿 서비스 — Phase 2 에서 구현.

책임:
- 템플릿 CRUD
- 자동 매칭: 새 PDF 의 첫 페이지 키워드에서 가장 잘 맞는 템플릿 탐색
- 템플릿 복제/병합
"""

from __future__ import annotations


class TemplateService:
    """박스 템플릿 비즈니스 로직.

    TODO(Phase 2):
        - 첫 페이지 텍스트에서 match_keywords 매칭 점수 계산
        - 점수 임계값 이상이면 자동 매칭 성공
    """

    async def auto_match(self, pdf_path: str) -> int | None:
        """PDF 첫 페이지 키워드로 가장 잘 맞는 템플릿 ID 반환.

        Returns:
            매칭된 템플릿 ID, 매칭 실패 시 None
        """
        raise NotImplementedError("Phase 2 에서 구현")
