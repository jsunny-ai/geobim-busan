> **[STALE 사본]** 이 파일의 정본(최신본)은 `C:/antigravity/GeoBIM/wiki/04_조사자료/04_시스템_UI_좌표/PDF_EXTRACTION_DESIGN.md` 이다. 이 사본은 2026-05~06월 시점 스냅샷이며 갱신되지 않는다. (2026-07-13 표기)

# PDF 박스 추출 UI 설계

## 개요

사용자가 PDF 위에서 마우스로 박스를 그려 정보 위치를 지정하고, 이를 템플릿으로 저장하여 동일 양식 PDF에 재사용하는 기능.

---

## 핵심 설계 6개 요점

### 1. PDF 렌더링
- **라이브러리**: `react-pdf` + `pdfjs-dist`
- 페이지 네비게이션 (이전/다음/페이지 직접 입력)
- 줌 인/아웃 (100% 기준 50%~200%)
- PDF.js worker 경로: `pdfjs-dist/build/pdf.worker.min.mjs`

### 2. 박스 그리기
- **방식**: SVG 또는 절대 위치 div 오버레이 (PDF 캔버스 위 투명 레이어)
- 마우스 `mousedown` → `mousemove` → `mouseup` 드래그로 rect 생성
- 그려진 박스는 라벨 선택 드롭다운을 표시

### 3. 라벨 종류

| 라벨 키 | 설명 |
|---------|------|
| `borehole_id` | 시추공 번호/이름 |
| `coordinate` | 좌표 (X, Y 또는 경위도) |
| `elevation` | 지표고 |
| `groundwater` | 지하수위 |
| `strata_table_depth` | 지층 테이블 — 심도 컬럼 |
| `strata_table_soil` | 지층 테이블 — 토질 컬럼 |
| `project_name` | 프로젝트명 |

### 4. 저장 형식
박스 좌표는 **페이지 기준 0~1 정규화 좌표**로 저장 (해상도·줌 독립적):

```json
{
  "boxes": [
    {
      "label": "borehole_id",
      "page": 1,
      "rect": [0.05, 0.10, 0.30, 0.15]
    }
  ]
}
```

`rect` 순서: `[x0, y0, x1, y1]` (좌상단 → 우하단, 0~1 범위)

### 5. 재사용 워크플로우

```
PDF 업로드
    │
    ▼
키워드 자동 매칭 (제목·양식 텍스트 기반)
    ├──[매칭 O]──▶ 자동 박스 적용 → 미리보기 → 승인/수정 → DB 저장
    └──[매칭 X]──▶ 템플릿 수동 선택
                        또는 신규 템플릿 작성 (박스 드래그)
                        → 저장 → 추출 → DB 저장
```

### 6. 추출 실행 (Phase 2 구현 예시)

```python
import fitz  # pymupdf

def extract_field(pdf_path: str, page: int, rect_norm: list[float]) -> str:
    doc = fitz.open(pdf_path)
    p = doc[page - 1]
    w, h = p.rect.width, p.rect.height
    clip = fitz.Rect(
        rect_norm[0] * w, rect_norm[1] * h,
        rect_norm[2] * w, rect_norm[3] * h,
    )
    return p.get_text("text", clip=clip).strip()
```

---

## OCR 폴백 (Phase 2)

스캔 PDF 등 텍스트 레이어 없는 경우:
- `pymupdf` 추출 결과가 빈 문자열이면 OCR 폴백 실행
- 후보: `pytesseract` (Tesseract), `easyocr`, 또는 클라우드 OCR API
- Phase 1에서는 미구현; `pdf_service.py`에 TODO 주석으로 표시
