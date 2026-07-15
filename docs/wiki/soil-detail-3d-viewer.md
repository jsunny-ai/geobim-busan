---
type: method
status: implemented
last_updated: 2026-07-13
doc_mode: reference
authority: derived
domain: [strata, csv, viewer]
summary: 토사 세분류(soil_detail)를 CSV/DB에서 보존하고 3D 뷰어의 컬럼·세분류 솔리드·단면 해치로 렌더링하는 데이터 흐름과 구현 상태를 정리한 문서다.
tags: [method, strata, viewer, geobim, active]
---

# 토사 세분류 3D 뷰어 (soil_detail)

> Graph parent: [[방법론]]

토사 대분류(`strata_group=soil`) 내부를 매립토/퇴적토/풍화토 등 세분류로 구분해
3D 뷰어에 표시하는 기능. 핵심 원칙: **모델 계산·보간·hard constraint는 계속
대분류 기준, 세분류는 표시 레이어**. 설계기준은 06_토사세분류_해치표현기준,
07_토사층_구분_설계기준(01_설계기준) 참조.

## 데이터 흐름

```
CSV/PDF 원본 (매립층, 퇴적점토, 풍화토 …)
  → 인제스트 정규화: normalize_soil_detail() — 세분류명 보존 (backend/app/services/normalization.py)
      · "매립층"→"매립토", "퇴적점토"→"퇴적점토" (토사로 병합 금지)
      · normalize_strata_group(세분류명) = "soil" (모델용 대분류 별도 계산)
  → DB strata.soil_type = 세분류명, raw_text = 원문 보존
  → API GET /api/v1/projects/{id}/boreholes/effective — soil_type + strata_group 응답
  → 뷰어 normalizeSoilDetailName() 별칭 정규화 → 13종 세분류
  → 렌더링: 시추공 컬럼 패턴 / soil_detail:<name> 솔리드 / 단면 cap 해치 / 범례 토글
```

## 핵심 코드

### 뷰어 (sites/viewer-3d/src)

- `lib/soilDetail.ts` — 단일 진실 소스.
  - `SOIL_DETAIL_TYPES` 13종: 토사, 매립토, 붕적토, 퇴적토, 충적토, 풍화토,
    퇴적점토, 퇴적모래, 퇴적자갈, 점토, 실트, 모래, 자갈
  - `SOIL_DETAIL_ALIASES`: 매립층→매립토, 잔류토→풍화토, 사질토→모래, 점성토→점토 등
  - `normalizeSoilDetailName()`, `layerGroupForSoilType()`, `uniqueSoilDetails()`,
    `soilDetailSwatchStyle()`(CSS gradient 스와치)
- `workers/geoWorker.ts` — 세분류 솔리드 생성.
  - L30 `SOIL_DETAIL_ORDER`(적층 순서), L46 워커 내 `normalizeSoilDetailName` 사본
  - L656-669 시추공별 `soilDetailThick` 두께 수집
  - L1508-1557 세분류별 두께장을 보간해 전체 토사 두께 내 비율 배분 →
    `soil_detail:<세분류명>` 레이어 pair 생성
  - `buildBoundaryTargets()`: hard constraint 타깃은 세분류 경계가 아닌
    **대분류 누적 하단면**으로 병합 생성. 동일 격자노드 중복 타깃은 평균 병합,
    잔차 초과 시 throw 대신 `console.warn` 진단(로드 중단 방지)
  - 모델 바닥 `yBotM`: 최심 관측 접촉면보다 최소 2m 아래로 자동 확장
    (기본 50m + 58.6m 시추공에서 clamp로 인한 constraint 위반 재발 방지)
- `hooks/useGeoModel.ts` — 렌더링 적용.
  - L54-183 세분류별 `CanvasTexture` 캐시(`SOIL_DETAIL_TEXTURES`)
  - L246 `attachVerticalHatchOverlay()`: 수직면 전용 해치 오버레이
    (수평 상·하면에는 해치 미적용 — 07-12 계획 표시 기준)
  - L715-768 `soil_detail:*` 메쉬에 해치 map·`sectionCapMap`·userData 부여,
    세분류 솔리드 존재 시 기본 `soil` 솔리드 숨김(`hasSoilDetailSolids`)
  - L883-896 시추공 컬럼 세그먼트에 `userData.soilDetail` 부여
  - L979-995 `applyHatchToggle()`: 해치 스위치는 패턴만 on/off, 솔리드는 유지
- `hooks/useSectionPlane.ts` — 단면 cap 생성 시 원본 메쉬 `material.map`을
  전달해 절단면에 세분류 해치 표시
- `pages/Viewer3DPage.tsx` — L99 `showSoilDetailPatterns`(해치 스위치, 기본 켬),
  L100 `soilDetailVisibility`(세분류 개별 토글), L153 실데이터 기반 `soilDetailLegend`
- `components/ViewerControls.tsx` — L368-420 `토사 세분류 해치` 스위치(켬/끔 표시) +
  세분류별 개별 토글 범례
- `components/BoreholeTable.tsx` L323, `BoreholeEditPanel.tsx`,
  `VirtualBoreholeManager.tsx` — 테이블 스와치·편집 선택지에 세분류 반영

### 백엔드/파이프라인 (geobim-stratum/backend)

- `app/services/normalization.py` — `normalize_soil_detail()`,
  `normalize_strata_group()`(세분류명→soil 안정 매핑)
- `scripts/reextract_csv_soil_detail.py` — 기존 CSV 업로드 job 재파싱.
  기본 dry-run, execute 모드는 `PdfService.persist_rows` same-source upsert로
  전체 삭제 없이 해당 보어홀 지층만 교체. `infer_is_supplementary()`로 기존
  `is_supplementary`/`project_role='new'` 상태 보존(부산 134공 existing 오표기 재발 방지)
- `tests/test_soil_detail_preservation.py` — 정규화·PDF 파서·table_merger가
  세분류를 `토사`로 붕괴시키지 않음을 검증(USCS: CL→점토, SW→모래 포함)

## 제약

- 세분류 해치는 지층 평면/외부 수평 표면에 표시하지 않는다(수직면·단면 cap 전용).
- `strata_group !== "soil"` 지층에는 세분류 로직을 적용하지 않는다.
- hard constraint(`CONTACT_TOLERANCE_M=1e-4`)는 대분류 하단면 기준 —
  세분류 내부 경계를 constraint 타깃으로 쓰면 단일 토사 하단면이 여러 깊이를
  동시에 만족해야 해 위반이 재발한다(07-10 계획서 18절 이력).
- 별칭 사전은 `lib/soilDetail.ts`와 `geoWorker.ts` L46에 **중복 정의**되어 있어
  세분류 추가 시 양쪽 동기화 필요(워커는 모듈 import 제약).
- `토사 세분류 해치` 스위치는 해치 패턴만 제어, 세분류 솔리드/컬럼 표시는
  `soilDetailVisibility` 개별 토글이 제어.

## 구현 상태 (2026-07-13 기준)

완료:

- 인제스트/재추출 세분류 보존 + 단위 테스트
- 부산역 PJT(9718) CSV 재반영 — active 259공, 세분류 segment 312개 보존
- 시추공 컬럼 세분류 패턴, 실데이터 기반 범례, 개별 토글, 해치 스위치
- `soil_detail:<name>` 세분류 솔리드(두께 비율 배분) + 수직면 해치 오버레이
- 단면 cap 해치 map 전달, hard constraint 대분류 병합, 모델 바닥 자동 확장

미구현(계획):

- `strata.soil_type_raw` / `classification_basis` 스키마 확장(07-10 계획서 5.2절)
- 프로젝트별 원본 범례 매핑 테이블(`project_soil_pattern_mappings`) 및
  original_legend 우선순위
- 유기질토/혼합토(사질점토 등) 패턴 — 현재 13종 목록에 없음

<!-- 확인 필요: 단면 cap 해치와 세분류 솔리드의 실제 브라우저 표시 품질,
constraint 잔차 진단([진단] 시추공경계오차) 값은 코드/계획서 기록만으로 판단했고
실행 화면으로 재검증하지 않았다. 07-12 계획(docs/soil_detail_3d_viewer_plan_20260712.md)의
"CAD/DWG 스타일 투명 선 해치(색상 배경 없음)" 요건이 현재 CanvasTexture 구현에서
완전히 충족되는지도 텍스처 생성 코드 정밀 검토가 필요하다. -->

## 관련 문서

- 계획서(원본): `C:\antigravity\GeoBIM\output\토사세분류_3D지질뷰어_구현계획서_20260710.md`
  (구조·단계·부산 파일럿 실행 이력 13-20절 포함)
- 계획서(표시 기준 확정): `C:\antigravity\GeoBIM\geobim-stratum\docs\soil_detail_3d_viewer_plan_20260712.md`
- 설계기준: 06_토사세분류_해치표현기준, 07_토사층_구분_설계기준 (wiki/01_설계기준)
- 추출규칙: csv-ingest-v1 (wiki/03_기술문서/03_추출규칙)
