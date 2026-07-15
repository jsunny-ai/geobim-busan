> **[STALE 사본]** 이 파일의 정본(최신본)은 `C:/antigravity/GeoBIM/wiki/04_조사자료/04_시스템_UI_좌표/시추공관리_UI_구현계획서.md` 이다. 이 사본은 2026-05~06월 시점 스냅샷이며 갱신되지 않는다. (2026-07-13 표기)

# 시추공 관리 UI 개선 — 구현 상세 계획서

작성일: 2026-06-26
대상 화면: `sites/projects/src/pages/AdminBoreholeManagementPage.tsx`

## 0. 설계 원칙

관리자 시추공 화면의 역할은 **탐색이 아니라 데이터 거버넌스**다. 지도·주상도 탐색은
이미 `sites/map`(Cesium 지도 + 클릭 시 주상도 패널)에 존재하므로 **재구현하지 않는다.**
이 화면은 전체 DB의 정합성 유지(품질 트리아지) · 중복 정리 · 일괄 작업에 집중한다.
공간 확인이 필요한 순간엔 기존 지도 사이트로 **딥링크**한다.

## 1. 백엔드 가용성 점검 결과 (`backend/app/api/v1/boreholes.py`)

| 기능 | 엔드포인트 | 상태 |
|---|---|---|
| 전체 목록(+strata) | `GET /boreholes?limit&include_strata=true` | 있음 |
| 단건 조회 | `GET /boreholes/{id}` | 있음 |
| 삭제(soft) | `DELETE /boreholes/{id}` | 있음 |
| 중복 그룹 | `GET /boreholes/admin/duplicates` | 있음 (exact/conflict/coordinate_conflict) |
| 완전중복 자동정리 | `POST /boreholes/admin/duplicates/merge-exact` | 있음 |
| 좌표·표고 수정 | `PATCH /boreholes/{id}` | 있음 (latitude/longitude/elevation만) |
| **프로젝트 이동** | `PATCH`에 `project_id` 없음 | **없음 → Phase 2** |
| **임의선택 병합(keep_id 지정)** | 내부헬퍼 `_merge_duplicate_boreholes` 존재, 노출 엔드포인트 없음 | **없음 → Phase 2** |

결론: 품질 플래그·필터·정렬·다중선택·일괄삭제·중복비교(유지+나머지삭제)·지도딥링크는
**기존 엔드포인트만으로 프론트에서 전부 구현 가능**하다. 프로젝트 이동과 링크 이관형
진짜 병합만 백엔드 신규 작업이 필요하다.

## 2. 품질 플래그 도출 규칙 (Phase 1, 클라이언트 도출)

서버 권위 검사가 없으므로 기존 `Borehole` 데이터에서 휴리스틱으로 도출한다.
(추후 서버 API가 생기면 교체. 규칙은 한 곳 `deriveFlags(b, dupIndex)`에 모은다.)

- **중복(duplicate)**: `GET /admin/duplicates` 응답의 `groups[].items[].id`에 포함되면 플래그.
  타입(exact/conflict/coordinate_conflict)도 함께 보관.
- **심도 이상(depth_anomaly)**: strata 정렬 후 다음 중 하나면 플래그 —
  ① `depth_bottom <= depth_top`인 층 존재 ② 인접 층 불연속(겹침/공백, `bottom_i != top_{i+1}`)
  ③ 시작이 0이 아님 ④ 최대심도 ≤ 0. (백엔드 strata 검증과 동일 기준)
- **미검수(unreviewed)**: `data_status`에 `pending_review` 포함 **또는** `strata.length === 0`.
- **좌표 이탈(coord_outlier)**: 경도 ∉ [124,132] 또는 위도 ∉ [33,43] 또는 좌표 null/0
  (대한민국 영역 밖). 추후 프로젝트 bbox 대비 검사로 고도화.

각 플래그는 카운트 카드로 노출하고, 카드 클릭 시 해당 플래그만 필터한다.

## 3. Phase 1 — 프론트엔드 구현 범위

파일: `AdminBoreholeManagementPage.tsx` 1개 수정 (+ 필요 시 작은 모달 컴포넌트 동일 파일 내).

1. **데이터 품질 스트립**: 중복·심도이상·미검수·좌표이탈 4개 카드(+정상/검토필요 요약).
   클릭 = 필터 토글.
2. **테이블 강화**:
   - 행 좌측 체크박스 + 헤더 전체선택.
   - 상태 컬럼에 플래그 배지.
   - 굴착심도 컬럼 정렬 토글(오름/내림). (기본 정렬은 ID)
   - 작업 컬럼: "지도에서 보기" 아이콘(딥링크) + 삭제.
3. **일괄 작업 바**(선택 ≥1 시 노출): 삭제(일괄 DELETE 루프). 병합·프로젝트이동 버튼은
   배치하되 Phase 2 전까지 `disabled` + 툴팁("백엔드 준비 중").
4. **지도 딥링크**: `window.open(\`${MAP_URL}/?project_id=${b.project_id}\`, "_blank")`.
   (단건 포커스 파라미터는 map 사이트에 없으므로 프로젝트 단위로 이동.)
5. **중복 비교 모달**: 중복 그룹 행의 "비교" 버튼 → 그룹 `items`를 좌우(2개 초과 시 가로 스크롤)
   주상도 + 메타 차이로 표시. 버튼 라벨 **"이 항목 유지"**. 동작 = 선택 id를 대표로 두고
   나머지 id를 DELETE. (링크 이관형 병합은 Phase 2)
   - 주상도는 기존 로직 재사용(인라인 미니 컬럼). soil_type 색은 `@shared/strataColor` 사용.

### 라벨 규칙
중복 비교의 유지 버튼은 **"이 항목 유지"**로 한다. (대표 지정 의미, 하단 "나머지 N건 삭제"와 역할 분리)

## 4. Phase 2 — 백엔드 동반 작업 (이번 범위 외, 후속)

- `PATCH /boreholes/{id}`에 `project_id` 허용 → 프론트 "프로젝트 이동" 활성화.
- `POST /boreholes/admin/merge` (body: `keep_id`, `duplicate_ids`) → 내부 `_merge_duplicate_boreholes`
  노출, 링크/override/bbox 이관 포함. 프론트 "병합" 및 비교모달 "유지"를 삭제 대신 병합으로 승격.
- (선택) 서버 권위 품질검사 API → 클라이언트 휴리스틱 대체.

## 5. 검증

- `pnpm --filter projects build` 또는 `tsc -b`로 타입/빌드 통과 확인.
- 수동 시나리오: 플래그 카드 클릭 필터 / 정렬 / 다중선택 삭제 / 비교모달 유지·삭제 / 지도 딥링크.

## 6. 영향 범위 / 리스크

- 단일 파일 수정, 기존 라우팅·API 변경 없음 → 회귀 위험 낮음.
- 대량(5만건) 로드는 현행 유지(별도 과제). 플래그 도출은 O(n)으로 기존 로드 루프에 통합.
- 휴리스틱 좌표/심도 플래그는 오탐 가능 → "검토 대상 표시"일 뿐 자동 삭제하지 않음(안전).
