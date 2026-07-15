> **[STALE 사본]** 이 파일의 정본(최신본)은 `C:/antigravity/GeoBIM/wiki/04_조사자료/04_시스템_UI_좌표/ARCHITECTURE.md` 이다. 이 사본은 2026-05~06월 시점 스냅샷이며 갱신되지 않는다. (2026-07-13 표기)

# 시스템 아키텍처

## 전체 구성

```
[브라우저]
    │  HTTP / WebSocket
    ▼
[Vite 프론트엔드 :5173]   (React 19 + TypeScript)
    │  /api/* proxy
    ▼
[FastAPI 백엔드 :8000]    (Python 3.11, uvicorn)
    ├──▶ [PostGIS :5432]  (postgresql+asyncpg, SQLAlchemy 2.x async)
    └──▶ [Celery Worker]
              ├──▶ [Redis :6379]           (브로커 / 결과 백엔드)
              └──▶ [PDF_Convert 라이브러리] (in-process import)
```

> PostGIS와 Redis만 Docker Compose로 실행. 백엔드·프론트엔드는 호스트 직접 실행
> (pyhwpx가 한컴오피스 COM 인터페이스에 의존하기 때문).

---

## 백엔드 레이어 책임

| 레이어 | 경로 | 책임 |
|--------|------|------|
| API | `app/api/v1/` | HTTP 요청 수신, 입력 검증, 응답 직렬화 |
| Core | `app/core/` | 설정(config), DB 세션(database), 보안(security) |
| Models | `app/models/` | SQLAlchemy ORM 클래스, PostGIS Geography 타입 |
| Schemas | `app/schemas/` | Pydantic 요청·응답 DTO |
| Services | `app/services/` | 비즈니스 로직 (Phase 2 구현 대상) |
| Workers | `app/workers/` | Celery 비동기 태스크 (PDF 추출, 좌표 변환 등) |

## 프론트엔드 features 책임

| Feature | 경로 | 책임 |
|---------|------|------|
| pdf-extraction | `features/pdf-extraction/` | PDF 렌더링, 박스 드래그, 템플릿 선택 |
| projects | `features/projects/` | 프로젝트 CRUD, 멤버 관리 |
| boreholes | `features/boreholes/` | 시추공 목록·상세, CSV 임포트 |
| viewer-3d | `features/viewer-3d/` | Cesium 기반 3D 지층 시각화 |

---

## PDF_Convert 통합 (Phase 2)

- **원본 경로**: `C:\antigravity\#1_2_PDF_CSV`
- **통합 방식**: 마이크로서비스 분리 없이 in-process import
- **작업**: 원본 레포의 `core/`, `parsers/` 폴더를 `backend/pdf_convert/`로 복사
- **자세한 내용**: [`backend/pdf_convert/README.md`](../backend/pdf_convert/README.md)
