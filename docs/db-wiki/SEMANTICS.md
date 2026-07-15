# GeoBIM DB 업무 의미

이 문서는 스키마만으로 알 수 없는 단위, 기준면, 데이터 계보와 선택 규칙을 설명합니다.

## 좌표

- `boreholes.location`은 항상 WGS84 경도·위도이며 SRID는 4326이다.
- `source_crs`는 원본 평면좌표를 해석한 좌표계다.
- CSV의 일반적인 `X`는 Easting, `Y`는 Northing으로 해석한다.
- 일부 과거 변환 자료는 X=Northing, Y=Easting 표기를 사용했으므로 원본 좌표 순서를 별도 검증해야 한다.
- 좌표 변환 결과는 대한민국 유효 영역과 프로젝트 공간 분포를 검사해야 한다.

## 표고와 심도

- `boreholes.elevation`은 해수면 기준 표고(m)다.
- `strata.depth_top`, `strata.depth_bottom`은 지표면(GL) 아래 방향을 양수로 하는 심도(m)다.
- 지층 구간은 `depth_bottom > depth_top`이어야 한다.
- 수두 표고는 `시추공 표고 - GL 기준 지하수위 깊이`로 계산한다.

## 프로젝트와 시추공

- 시추공명은 전역 고유값이 아니다.
- 프로젝트 안에서도 조사명과 위치가 다른 자료가 같은 시추공명을 사용할 수 있다.
- 프로젝트 소속과 역할은 `project_borehole_links`가 결정한다.
- `project_role=new`은 해당 프로젝트에서 신규 등록한 자료를 의미한다.
- `registered_from_job_id`는 업로드 단위 그룹화와 데이터 계보 추적 기준이다.

## 원본 보존과 편집

- 공공 원본 시추공은 직접 덮어쓰지 않는다.
- 프로젝트별 수정은 `project_borehole_overrides` 또는 개정 이력으로 관리한다.
- `deleted_at`은 soft-delete이며 NULL인 행만 활성 데이터다.
- `raw_text`는 원본 추출 행 보존용이며 정식 필드를 대신하는 장기 저장소로 사용하지 않는다.

## 추출 작업

- `pdf_extraction_jobs`는 PDF뿐 아니라 CSV 저장 작업의 계보에도 사용된다.
- 동일 미리보기 저장 재시도는 하나의 작업으로 처리되어야 한다.
- 사용자 확인 전 자동 추출값은 확정 데이터와 구분해야 한다.

## 지하수위

- 정식 관측값은 `groundwater_observations`에 저장한다.
- `depth_bgl_m`은 GL 아래 방향 양수, `head_elevation_m`은 EL 기준 표고다.
- GL 원본이면 `head_elevation_m = borehole.elevation - depth_bgl_m`으로 계산한다.
- EL 원본이면 `depth_bgl_m = borehole.elevation - head_elevation_m`으로 계산한다.
- GL·EL 값의 계산 차이가 0.25m를 넘으면 `needs_review`로 저장한다.
- 동일 업로드 작업과 시추공의 재저장은 `observation_key`로 중복을 방지한다.
- 과거 `strata.raw_text` 값은 `legacy_raw_text`, `auto`, 신뢰도 0.6으로 이관한다.
- 3D 지하수 모델은 사용자 확인값을 우선하고, 없을 때만 신뢰도 높은 자동 추출값을 사용한다.
