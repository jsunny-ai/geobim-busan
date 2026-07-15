# GeoBIM Stratum Platform

토목·환경 분야 **시추공 데이터 기반 3D 지층 모델링 웹 플랫폼**.

PDF 시추주상도 자동 파싱 → 시추공 데이터 관리 → Cesium 지도 시각화 → Minecraft 스타일 3D 복셀 지층 뷰어.

---

## 사이트 구성 (Phase 2)

| 사이트 | 포트 | 폴더 | 역할 |
|--------|------|------|------|
| **auth** | 5170 | `sites/auth/` | 로그인 |
| **projects** | 5171 | `sites/projects/` | 프로젝트 목록 + 시추공 편집 |
| **map** | 5172 | `sites/map/` | Cesium 지도 + 영역 그리기 |
| **viewer-3d** | 5173 | `sites/viewer-3d/` | Minecraft 복셀 3D 지층 뷰어 |
| **upload** | 5174 | `sites/upload/` | PDF 업로드 UI |

### 사이트 간 이동 흐름

```
[auth :5170]  →  로그인 성공  →  [projects :5171]
[projects :5171]  →  "지도" 메뉴  →  [map :5172]
[map :5172]  →  영역 그리기 → "3D 보기"  →  [viewer-3d :5173]
[viewer-3d :5173]  →  "지도로 돌아가기"  →  [map :5172]
모든 사이트  →  "업로드" 메뉴  →  [upload :5174]
```

---

## 디렉토리 구조

```
geobim-stratum/
├── backend/                        # FastAPI 백엔드 (포트 8000)
│   ├── app/
│   │   ├── api/v1/                 # auth / projects / boreholes 라우터
│   │   ├── core/                   # config, security (JWT), DB
│   │   ├── models/                 # SQLAlchemy ORM (User/Project/Borehole/Stratum 등)
│   │   └── schemas/                # Pydantic v2 스키마
│   ├── seeds/
│   │   ├── dev_seed.py             # 개발용 시드 사용자 생성
│   │   └── suwon_import.py         # 수원시 CSV 임포트 스크립트
│   └── alembic/                    # DB 마이그레이션
├── sites/
│   ├── auth/                       # 로그인 사이트 (:5170)
│   ├── projects/                   # 프로젝트 관리 (:5171)
│   ├── map/                        # 지도 뷰 (:5172)
│   ├── viewer-3d/                  # 3D 복셀 뷰어 (:5173)
│   └── upload/                     # PDF 업로드 (:5174)
├── shared/                         # 공유 타입/색상 (각 사이트가 alias로 참조)
│   ├── strataColor.ts
│   └── types.ts
├── frontend.phase1-backup/         # Phase 1 모놀리식 SPA 백업 (참조용)
├── docker-compose.yml              # PostgreSQL + PostGIS
├── start-all.bat                   # 5개 사이트 일괄 실행 (Windows)
└── README.md
```

---

## 로컬 실행 방법

### 사전 요구사항

- Windows 10/11
- Node.js 20+, pnpm 9+
- Python 3.11+, uv
- `subst G: "C:\antigravity\#1_4_GeoBIM"` 실행 필요
  (경로의 `#` 문자가 Vite/esbuild에서 URL fragment로 해석되는 문제 우회)

### G: 드라이브 마운트 (필수)

```powershell
subst G: "C:\antigravity\#1_4_GeoBIM"
```

> 재부팅 시 초기화됨. `start-all.bat`에 포함되어 있음.

### 의존성 설치 (최초 1회)

```powershell
cd G:\geobim-stratum\sites\auth      && pnpm install
cd G:\geobim-stratum\sites\projects  && pnpm install
cd G:\geobim-stratum\sites\map       && pnpm install
cd G:\geobim-stratum\sites\viewer-3d && pnpm install
cd G:\geobim-stratum\sites\upload    && pnpm install
```

### 5개 사이트 일괄 실행

```powershell
G:\geobim-stratum\start-all.bat
```

또는 각 사이트 개별 실행:

```powershell
# 각자 별도 터미널에서
cd G:\geobim-stratum\sites\auth      && pnpm dev   # :5170
cd G:\geobim-stratum\sites\projects  && pnpm dev   # :5171
cd G:\geobim-stratum\sites\map       && pnpm dev   # :5172
cd G:\geobim-stratum\sites\viewer-3d && pnpm dev   # :5173
cd G:\geobim-stratum\sites\upload    && pnpm dev   # :5174
```

---

## 백엔드 실행 (DB 연동 시)

### 1. PostgreSQL + PostGIS 기동

Docker Desktop 설치 후:

```powershell
docker compose up -d db
```

또는 로컬 PostgreSQL에 PostGIS 확장 설치 후 `.env` 수정.

### 2. DB 마이그레이션

```powershell
cd G:\geobim-stratum\backend
uv run alembic upgrade head
```

### 3. 시드 데이터

```powershell
# 개발용 사용자 생성 (dev@geobim.local / dev)
uv run python -m seeds.dev_seed

# 수원시 CSV 임포트
uv run python -m seeds.suwon_import "C:\antigravity\#2_ver11_stop\#2\data\수원시_통합_결과.csv"
```

### 4. 백엔드 서버 실행

```powershell
uv run uvicorn app.main:app --reload --port 8000
```

---

## 개발 계정

| 이메일 | 비밀번호 |
|--------|----------|
| `dev@geobim.local` | `dev` |

---

## Mock 데이터 (백엔드 없이 동작)

모든 사이트는 백엔드 연결 실패 시 자동으로 mock 데이터로 전환됨.
백엔드 없이도 UI 전체를 확인할 수 있음.

---

## viewer-3d URL 파라미터

map 사이트에서 영역 그리기 완료 후 "3D 보기" 클릭 시 자동 생성:

```
http://localhost:5173/?polygon={base64-GeoJSON}&boreholes={id,id,...}
```

- `polygon`: GeoJSON Polygon을 base64 인코딩한 값
- `boreholes`: 시추공 ID 콤마 구분

직접 접근 시 mock 폴리곤 + mock 시추공 데이터로 표시됨.

---

## 공통 코드 동기화 주의사항

`shared/` 폴더의 파일(strataColor.ts, types.ts)을 수정할 경우,
각 사이트는 `@shared` alias로 직접 참조하므로 자동 반영됨.

shadcn/ui 컴포넌트(`src/components/ui/`)는 각 사이트별로 복사본이 있음.
한 사이트에서 수정하면 필요한 다른 사이트에도 수동으로 반영해야 함.

---

## 기술 스택

| 영역 | 스택 |
|------|------|
| 백엔드 | Python 3.11, FastAPI, SQLAlchemy 2.x (async), Alembic |
| DB | PostgreSQL 16 + PostGIS 3.4 |
| 프론트엔드 | React 19 + TypeScript + Vite + pnpm |
| 스타일 | TailwindCSS + shadcn/ui (커스텀 다크 테마) |
| 상태 관리 | TanStack Query (React Query v5) + Axios |
| 3D 렌더링 | CesiumJS (Primitive API — 고성능 박스/실린더 렌더링) |
| 패키지 매니저 | 백엔드 uv, 프론트엔드 pnpm |

---

## Phase 로드맵

- [x] **Phase 1** — UI 스켈레톤 (모놀리식 SPA)
- [x] **Phase 2** — 5개 독립 사이트 분리 + 백엔드 연동 + 3D 복셀 지층 뷰어
- [ ] **Phase 3** — PDF 자동 파싱 연동 + 박스 그리기 UI + Kriging 보간
