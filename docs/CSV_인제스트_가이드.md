# CSV/XLSX 시추공 인제스트 (옵션 B) — 최종 구현 가이드

PDF·수동입력에 이어 **CSV/엑셀**을 세 번째 시추공 데이터 인입 경로로 추가했다.
파일 내부 형식에 의존하지 않고 컬럼 역할을 자동 추론한 뒤, 사용자가 확정하면
기존 적재 파이프라인으로 DB에 저장한다.

## 구성 요소

| 영역 | 파일 | 역할 |
|---|---|---|
| 파서 엔진 | `backend/app/services/csv_ingest.py` | 인코딩/구분자 자동감지, 포맷 판별, 컬럼 역할 추론, 두께→심도, 토사 병합, 좌표 변환 |
| API | `backend/app/api/v1/csv_ingestion.py` | `preview`(추론·미저장) / `commit`(적재) |
| 라우터 등록 | `backend/app/main.py` | `PREFIX + "/csv-ingestion"` |
| 마법사 UI | `sites/upload/src/components/CsvParseTab.tsx` | "CSV/엑셀" 탭 |
| 단위 테스트 | `backend/tests/test_csv_ingest.py` | 파서 7케이스 |
| 라우트 스모크 | `backend/tests/test_csv_ingestion_api.py` | 배선 확인 |

## 처리 흐름

1. 프로젝트 관리에서 프로젝트 생성 → 그 안에서 업로드 진입(`project_id` 컨텍스트 주입).
2. **preview** — 파일 업로드 → 컬럼 역할/포맷/CRS 자동추론 + 미리보기 반환. **DB 미저장.**
3. 마법사에서 컬럼 역할·좌표계(CRS)를 확정(평면좌표 X/Y면 CRS 필수).
4. **commit** — 확정 매핑으로 재파싱 → `PdfService.persist_rows` 로 적재.
   중복 검사·프로젝트 링크·`data_origin` 이 PDF 경로와 일원화된다.

## 지원 형식 (형식 무관)

- **wide**: 1행=시추공, 지층 컬럼=두께 (예: 국토지반정보DB 양식). 두께를 누적해
  상/하심도로 변환, `-`/빈값은 없는 지층으로 제외.
- **long**: 1행=지층, 상/하심도+지층명 직접 명시.
- 인코딩 utf-8-sig/cp949/euc-kr, 구분자 `, ; \t |` 자동감지, XLSX 직접 파싱.

## 데이터 정합 규칙

### 현재 유효 규칙 — 토사 세분류 보존

- 지층의 모델링용 대분류는 `normalize_strata_group` 으로 계산한다.
- DB의 `soil_type` 에는 가능한 한 원본 지층명 또는 화면 표시용 세분류명을 보존한다.
- 매립층·퇴적층·붕적층·풍화토·퇴적점토·퇴적모래·퇴적자갈 등 토사 세분류는 "토사" 로 덮어쓰지 않는다.
- 같은 대분류라도 세분류명이 다르면 인접 병합하지 않는다.
- 좌표는 WGS84로 변환해 저장하고, 원본 좌표계는 `meta_crs` 로 기록한다.

### 이전 정합 규칙 — 보존 이력

초기 CSV 인제스트는 PDF 데이터와 구조를 맞추기 위해 지층명을 한글 5대 분류
토사/풍화암/연암/보통암/경암으로 저장했다. 이때 매립층·퇴적층·풍화토 등
세분류는 "토사" 로 통합하고, 인접 동일분류 층을 병합했다.

2026-07-10 토사 세분류 해치 표현 기준 도입 이후에는 이 병합 규칙을 신규 적재와
재추출의 기본 정책으로 사용하지 않는다. 기존 적재 데이터의 이력 이해를 위해서만
남긴다.

## API

```
POST /api/v1/csv-ingestion/projects/{project_id}/preview
  multipart: file, source_crs?(EPSG:xxxx), mapping?(JSON: {헤더명: 역할})
  → { mapping, summary, preview[], issues }   # DB 미저장

POST /api/v1/csv-ingestion/projects/{project_id}/commit
  multipart: file, source_crs?, mapping?, is_supplementary(bool)
  → { job_id, status, result(적재 카운트), issues }
```

역할 값: name, lon, lat, x, y, elevation, depth_top, depth_bottom, soil_type,
stratum(두께), total_depth, water_gl, water_el, ignore.

## 좌표계 주의

같은 X/Y가 좌표계에 따라 위도 100km까지 갈린다(EPSG:5186 vs 5174 등). 한국 좌표계
여러 개가 전부 한반도에 떨어져 자동추론만으론 단정 불가하므로, **CRS는 마법사에서
사용자가 확정**한다. 자동값은 추정값으로만 제시한다.

## 보류 항목 — 지하수위

`수위(GL.-m)`, `수위(EL.m)` 는 파서가 추출해 **preview·job.result 에는 노출**하지만
**DB 적재는 보류**한다. 이유: 기존 공공데이터에서도 지하수위가 추출되지 않아 정합을
위해 우선 제외. 추후 지하수위 작업 시 `Borehole` 에 컬럼/테이블을 추가하고
`csv_ingest.to_persist_rows` 에서 연결하면 된다. (참고: `groundwater_observation_hard_constraint.md`)

## 검증 절차 (Windows 사용자 환경)

```bash
# 1) 파서 단위 테스트 + 라우트 스모크
cd backend
pytest tests/test_csv_ingest.py tests/test_csv_ingestion_api.py -q

# 2) 프런트 타입체크/빌드
cd ../sites/upload
npm run build

# 3) end-to-end (수동): 백엔드·DB 기동 후 업로드 → CSV/엑셀 탭에서
#    파일 업로드 → 분석 → CRS 확정 → DB 저장 → 시추 관리에서 반영 확인
```

> 단위 테스트(파서 7케이스)와 Test.xlsx 변환(시추공 8·지층 21)은 검증 완료.
> 라이브 DB 연동 e2e 는 사용자 환경에서 1회 확인 권장.
