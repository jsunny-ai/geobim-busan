> **[STALE 사본]** 이 파일의 정본(최신본)은 `C:/antigravity/GeoBIM/wiki/04_조사자료/03_지층_모델링/3d_vertical_section_implementation_plan_20260630.md` 이다. 이 사본은 2026-05~06월 시점 스냅샷이며 갱신되지 않는다. (2026-07-13 표기)

# 3D 지질 뷰어 수직 단면 기능 상세 구현계획

- 문서 버전: v1.0
- 작성일: 2026-06-30
- 적용 대상: `sites/viewer-3d`
- 구현 방식: Three.js 렌더링 클리핑 기반 비파괴 수직 단면

---

## 1. 목적

3D 뷰에 표시된 지층 모델을 사용자가 지정한 수직 평면으로 절단하여 내부 지층 구조를 확인할 수 있도록 한다.

초기 기능은 원본 지층 메시를 실제로 분할하거나 저장 데이터를 변경하지 않는다. GPU 렌더링 단계에서 절단할 영역을 숨기는 비파괴 방식으로 구현한다. 이후 절단면 채움, 정면 단면 보기, 측정 및 내보내기를 단계적으로 추가한다.

### 1.1 핵심 사용자 시나리오

1. 사용자가 `수직 단면` 도구를 활성화한다.
2. 3D 지표면 또는 모델 영역에서 시작점과 끝점을 차례로 선택한다.
3. 두 점을 잇는 선을 수직으로 연장한 절단 평면이 생성된다.
4. 평면 한쪽의 지층이 숨겨지고 내부 지층이 드러난다.
5. 사용자는 절단 방향을 반전하거나 평면을 앞뒤로 이동한다.
6. `단면 정면 보기`를 눌러 절단면에 수직인 카메라로 전환한다.
7. 작업이 끝나면 단면 기능을 끄거나 초기화한다.

### 1.2 구현 원칙

- 지층 보간 결과와 원본 메시를 변경하지 않는다.
- Smooth와 Voxel 렌더 모드에 동일한 절단 평면을 적용한다.
- 기존 지층 가시성, 수직과장, 미분류 처리 모드와 독립적으로 동작한다.
- 실제 표고 및 거리는 수직과장 적용 전 좌표를 기준으로 표시한다.
- 시추공 접촉점과 지층 경계의 하드 제약에는 영향을 주지 않는다.
- 단면 작성 중에는 기존 시추공 선택 동작과 입력 충돌이 없어야 한다.

---

## 2. 구현 범위

### 2.1 1차 배포 범위

- 수직 단면 도구 켜기/끄기
- 두 점으로 임의 방향 수직 절단면 생성
- X축 및 Z축 기준 빠른 절단
- 절단할 방향 반전
- 절단면 평행 이동
- 절단선 및 반투명 평면 표시
- Smooth/Voxel 지층 공통 절단
- 지표면 절단 여부 선택
- 시추공 절단 여부 선택
- 절단면 정면 카메라 보기
- 단면 초기화
- 키보드 취소 및 기본 접근성 처리

### 2.2 2차 배포 범위

- 절단면 지층별 색상 채움
- 절단 경계 강조선
- 수평거리 및 EL 표고 눈금
- 단면에 인접 시추공 투영
- 단면 정보 표시: 방위각, 길이, 오프셋, 수직과장
- 단면 상태 저장 및 복원

### 2.3 제외 범위

- 원본 메시를 두 개의 새로운 폐합 솔리드로 분할
- Boolean 결과의 서버 저장
- 여러 절단 평면의 동시 조합
- 절단 결과 DXF/PDF/GeoJSON 내보내기
- 경사 단면 및 곡선 단면

제외 기능은 1·2차 기능이 안정화된 후 별도 프로젝트로 추진한다.

---

## 3. 현재 구조와 변경 영향

현재 `useGeoModel`은 Smooth와 Voxel 지층 메시를 각각 참조로 보관하고, 모든 지층 객체를 `stratumGroup`에 추가한다.

```text
useThreeScene
 ├─ scene
 ├─ renderer
 ├─ camera
 └─ OrbitControls

useGeoModel
 └─ stratumGroup
     ├─ drape
     ├─ smoothMeshRef[type]
     ├─ voxelMeshRef[type]
     └─ bhGroupRef
```

수직과장은 다음과 같이 그룹 Y축 스케일로 적용된다.

```ts
stratumGroup.scale.set(1, verticalExag, 1)
```

지층 메시 형상 생성 Worker와 `geoGeometry.ts`는 수정하지 않는다. 절단 기능은 렌더러, 재질 및 UI 입력 계층에서 처리한다.

### 3.1 변경 대상 파일

| 파일 | 작업 |
|---|---|
| `src/lib/sectionPlane.ts` | 절단 평면 계산, 좌표 변환, 방위각 계산 유틸리티 신규 작성 |
| `src/hooks/useSectionPlane.ts` | 절단 상태를 Three.js 장면과 연결하는 훅 신규 작성 |
| `src/components/SectionControls.tsx` | 절단 전용 조작 패널 신규 작성 |
| `src/components/ViewerControls.tsx` | 수직 단면 진입 버튼 또는 섹션 추가 |
| `src/pages/Viewer3DPage.tsx` | 상태 관리, 훅 연결 및 컴포넌트 배치 |
| `src/hooks/useThreeScene.ts` | 로컬 클리핑 및 필요 시 stencil 버퍼 활성화 |
| `src/hooks/useGeoModel.ts` | 절단 대상 메시·재질 노출, 재생성 후 절단 재적용 |
| `src/lib/types.ts` | 단면 상태 및 좌표 타입 추가 |
| `tests/sectionPlane.test.ts` | 평면 계산과 변환 단위 테스트 신규 작성 |

### 3.2 변경하지 않을 파일

- `src/workers/geoWorker.ts`
- `src/lib/geoGeometry.ts`
- 백엔드 API 및 데이터베이스 모델

절단 기능은 시각화 기능이므로 지층 생성 알고리즘과 시추공 접촉점 제약을 건드리지 않는다.

---

## 4. 상태 및 데이터 모델

### 4.1 단면 상태

`src/lib/types.ts`에 다음 타입을 추가한다.

```ts
export type SectionInteractionMode =
  | "idle"
  | "placing-start"
  | "placing-end"
  | "editing"

export interface SectionPoint {
  x: number
  z: number
}

export interface VerticalSectionState {
  enabled: boolean
  interactionMode: SectionInteractionMode
  start: SectionPoint | null
  end: SectionPoint | null
  offsetM: number
  flipped: boolean
  showHelper: boolean
  showCap: boolean
  clipDrape: boolean
  clipBoreholes: boolean
}
```

평면 정의점에는 Y값을 저장하지 않는다. 수직 단면은 수평면의 두 점과 Y축으로 완전히 정의되기 때문이다.

### 4.2 초기 상태

```ts
export const DEFAULT_SECTION_STATE: VerticalSectionState = {
  enabled: false,
  interactionMode: "idle",
  start: null,
  end: null,
  offsetM: 0,
  flipped: false,
  showHelper: true,
  showCap: false,
  clipDrape: true,
  clipBoreholes: false,
}
```

### 4.3 상태 전이

```text
idle
  └─ 도구 활성화 → placing-start

placing-start
  ├─ 첫 점 클릭 → placing-end
  └─ Esc/끄기 → idle

placing-end
  ├─ 두 번째 점 클릭 → editing
  ├─ 첫 점과 너무 가까움 → placing-end 유지
  └─ Esc → placing-start

editing
  ├─ 다시 그리기 → placing-start
  ├─ 방향 반전/이동/보기 변경 → editing
  └─ 초기화/끄기 → idle
```

---

## 5. 수직 절단면 계산

### 5.1 모델 좌표 기준

Three.js 모델 좌표는 다음 기준을 사용한다.

- X: 동서 방향 모델 좌표
- Y: 표고
- Z: 남북 방향 모델 좌표

시작점 `P1 = (x1, 0, z1)`, 끝점 `P2 = (x2, 0, z2)`일 때:

```ts
const direction = new THREE.Vector3(
  end.x - start.x,
  0,
  end.z - start.z,
).normalize()

const up = new THREE.Vector3(0, 1, 0)
const normal = new THREE.Vector3().crossVectors(direction, up).normalize()
```

평면 중심점에 오프셋을 적용한다.

```ts
const point = new THREE.Vector3(start.x, 0, start.z)
point.addScaledVector(normal, offsetModel)

if (flipped) normal.negate()

const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point)
```

### 5.2 유효성 조건

- 시작점과 끝점의 모델 거리가 0.01 미만이면 생성하지 않는다.
- 실제 거리 기준 기본 최소 절단선 길이는 1m로 한다.
- 두 번째 점이 유효하지 않으면 안내 메시지를 표시한다.
- 동일 위치 연속 클릭으로 NaN 법선이 만들어지지 않도록 방지한다.

### 5.3 방위각

절단선 방위각은 북쪽을 0°, 시계방향 양수로 표시한다. 프로젝트의 Z축 방향을 확인한 후 다음 식의 부호를 검증한다.

```ts
const azimuth = (Math.atan2(dx, dzNorth) * 180 / Math.PI + 360) % 360
```

좌표계 부호 검증은 동-서, 남-북 기준 테스트 케이스로 고정한다.

### 5.4 수직과장

수직 단면 법선은 Y 성분이 0이기 때문에 Y축 수직과장과 무관하게 동일한 수평 위치를 자른다.

단, 다음 표시값은 과장 전 실제 좌표로 환산한다.

```text
실제 높이(m) = sceneY / verticalExag / metersToModel
실제 수평거리(m) = modelDistance / metersToModel
```

향후 경사 단면을 구현할 때는 비균일 Y 스케일을 반영한 평면 역변환이 별도로 필요하다.

---

## 6. Three.js 렌더링 구현

### 6.1 렌더러 설정

`useThreeScene.ts`에서 로컬 클리핑을 활성화한다.

```ts
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  stencil: true,
})

renderer.localClippingEnabled = true
```

`stencil: true`는 2차 절단면 채움 기능을 고려한 설정이다. 1차 배포에서 성능 또는 호환성 문제가 확인되면 cap 기능 활성화 시점에만 적용하는 대안을 검토한다.

### 6.2 재질별 클리핑

전역 `renderer.clippingPlanes`는 그리드, 마커 등 불필요한 객체까지 자를 수 있으므로 사용하지 않는다.

Smooth와 Voxel 지층 재질에 동일한 `THREE.Plane` 인스턴스를 지정한다.

```ts
material.clippingPlanes = section.enabled ? [sectionPlane] : null
material.clipIntersection = false
material.needsUpdate = true
```

적용 대상:

- Smooth 지층 메시
- Voxel 지층 메시
- 지표면 drape: `clipDrape`가 true일 때
- 시추공 및 접촉점 링: `clipBoreholes`가 true일 때

적용 제외:

- GridHelper
- 단면 Helper
- 선택 마커
- 2D HTML UI

### 6.3 메시 재생성 대응

지층 데이터, 바닥 깊이 또는 미분류 처리 모드 변경 시 메시가 재생성된다. 새 재질에는 기존 절단 상태가 자동으로 적용되어야 한다.

권장 방식:

1. `useGeoModel`이 절단 평면 또는 재질 등록 콜백을 전달받는다.
2. 메시 생성 직후 재질을 등록한다.
3. `useSectionPlane`은 등록된 재질 목록에 현재 평면을 적용한다.
4. 메시 폐기 시 재질도 등록 목록에서 제거한다.

단순 대안으로 `useGeoModel`에서 `smoothMeshRef`, `voxelMeshRef`, `drapeMatRef`, `bhGroupRef`를 반환하고 `useSectionPlane`이 순회할 수 있다. 초기 구현은 이 방식을 사용한다.

### 6.4 Helper 시각화

다음 객체를 전용 `THREE.Group`에 생성한다.

```text
sectionHelperGroup
 ├─ 절단선 Line
 ├─ 시작점 Handle
 ├─ 끝점 Handle
 ├─ 반투명 Plane Mesh
 └─ 방향 화살표
```

표현 규칙:

- 절단선: 청록색, 깊이 검사 유지
- 시작점: 원형 또는 구형 핸들
- 끝점: 화살표 또는 다른 색상 핸들
- 절단 평면: 불투명도 0.08~0.12
- 제거되는 방향: 법선 화살표로 표시
- Helper는 항상 클리핑 대상에서 제외

평면 높이는 현재 모델 bounding box의 Y 범위를 사용하고, 폭은 절단선 길이보다 모델 대각선 길이를 우선 사용한다.

### 6.5 절단면 채움

2차 배포에서는 Three.js stencil clipping 패턴을 적용한다.

지층 메시별 렌더 패스:

1. Back face를 stencil 증가로 렌더
2. Front face를 stencil 감소로 렌더
3. stencil 값이 0이 아닌 위치에 cap 평면 렌더
4. 원래 지층 메시 렌더

지층별 cap 재질은 기존 지층 색상을 사용하되 밝기를 약간 높여 외부 표면과 구분한다.

주의사항:

- 지층별 `renderOrder`를 고정한다.
- 투명 재질과 stencil 조합을 피한다.
- Smooth와 Voxel을 동시에 렌더하지 않는다.
- 여러 폐합 성분이 있는 메시에서도 cap 누락 여부를 시험한다.
- 열린 메시가 발견되면 cap 기능만 비활성화하고 클리핑은 유지한다.

---

## 7. 입력 및 피킹

### 7.1 절단점 선택

절단 작성 모드에서는 Raycaster의 대상 우선순위를 다음과 같이 둔다.

1. 지표면 drape
2. 현재 표시 중인 지층 메시
3. 수평 기준 보조 평면

지표면이 숨겨져 있거나 교차하지 않으면 Y=0인 수평 보조 평면과의 교점을 사용한다.

선택된 교점에서는 X와 Z만 저장한다.

### 7.2 기존 시추공 선택과 충돌 방지

`pickMode`를 확장하거나 별도의 입력 모드를 통합한다.

```ts
type ViewerPickMode =
  | "normal"
  | "virtual-borehole"
  | "section"
```

`section` 모드에서는 시추공 클릭, hover 색상 변경, 편집 패널 열기를 수행하지 않는다.

이벤트 처리 순서:

```text
pointerdown
 ├─ section 모드 → 절단점 처리 후 종료
 ├─ virtual-borehole 모드 → 가상 시추공 처리 후 종료
 └─ normal → 기존 시추공 선택 처리
```

### 7.3 카메라 조작과 클릭 구분

OrbitControls 회전 종료를 절단점 클릭으로 오인하지 않도록 다음 조건을 둔다.

- pointerdown과 pointerup의 화면 이동량이 5px 이하
- 누르고 있던 시간이 500ms 이하
- 좌클릭만 절단점으로 사용
- 모바일은 단일 탭만 사용

---

## 8. UI 상세 설계

### 8.1 진입 버튼

기존 `ViewerControls`에 `수직 단면` 버튼을 추가한다.

버튼 상태:

- 비활성: 기본 버튼
- 작성 중: 강조색 + `두 점을 선택하세요`
- 단면 활성: 강조색 + `단면 편집`

### 8.2 SectionControls

단면 도구가 활성화된 동안 별도의 작은 패널을 표시한다.

```text
수직 단면
상태: 시작점/끝점 선택 또는 편집 중

[다시 그리기] [방향 반전]

위치 이동
[-50m -------- 0m -------- +50m]
[ - ] [0.5m] [ + ]

방위각  127.4°
길이    342.8m

[단면 정면 보기]

☑ 지표면 함께 절단
☐ 시추공 함께 절단
☑ 절단 평면 표시
☐ 절단면 색상 채움

[초기화] [닫기]
```

### 8.3 이동 범위

- 기본 범위: 모델 수평 대각선 길이의 ±50%
- 기본 step: 실제 1m
- Shift + 이동: 10m
- 정밀 이동 옵션: 0.1m
- 값은 모델 좌표가 아니라 실제 m 단위로 UI에 표시

### 8.4 키보드

| 키 | 동작 |
|---|---|
| `Esc` | 현재 점 선택 취소 또는 단면 작성 종료 |
| `F` | 절단 방향 반전 |
| `[` / `]` | 절단면 1m 이동 |
| `Shift` + `[` / `]` | 절단면 10m 이동 |
| `C` | 절단면 정면 보기 |

텍스트 입력에 포커스가 있을 때는 단축키를 처리하지 않는다.

### 8.5 안내 메시지

- `절단선의 시작점을 선택하세요.`
- `절단선의 끝점을 선택하세요.`
- `두 점이 너무 가깝습니다. 다른 위치를 선택하세요.`
- `수직 단면이 생성되었습니다.`
- `절단면이 모델 범위를 벗어났습니다.`

---

## 9. 단면 정면 카메라

### 9.1 카메라 배치

단면 평면 중심과 모델 bounding box를 기준으로 카메라를 배치한다.

```ts
const sectionCenter = getSectionCenter(...)
const distance = getFitDistance(sectionBounds, camera.fov)

camera.position.copy(sectionCenter)
camera.position.addScaledVector(plane.normal, distance)
controls.target.copy(sectionCenter)
```

### 9.2 카메라 up 벡터

정면 단면에서 화면 위쪽이 항상 표고 증가 방향이 되도록 한다.

```ts
camera.up.set(0, 1, 0)
```

카메라가 반대편으로 이동하더라도 좌우 방향이 갑자기 뒤집히지 않도록 `flipped`와 별개로 단면 시작→끝 방향을 화면 좌→우 기준으로 유지한다.

### 9.3 투영 방식

1차 구현은 현재 PerspectiveCamera를 유지한다.

2차 구현에서 단면 도면 성격을 강화하려면 OrthographicCamera 전환을 검토한다. 이 경우 원근 왜곡 없이 거리와 표고 눈금을 표현할 수 있다.

---

## 10. 파일별 상세 작업

### 10.1 `src/lib/sectionPlane.ts` 신규

구현 함수:

```ts
createVerticalPlane(start, end, offsetModel, flipped): THREE.Plane
getSectionDirection(start, end): THREE.Vector3
getSectionNormal(start, end, flipped): THREE.Vector3
getSectionLengthM(start, end, metersToModel): number
getSectionAzimuth(start, end): number
modelOffsetFromMeters(offsetM, metersToModel): number
isValidSectionLine(start, end, minModelLength): boolean
```

모든 순수 계산 함수는 Three.js 장면 없이 단위 테스트할 수 있게 한다.

### 10.2 `src/hooks/useSectionPlane.ts` 신규

책임:

- 절단 평면 인스턴스 유지
- 상태 변경 시 평면 업데이트
- 대상 재질에 클리핑 적용/해제
- Helper 생성, 갱신 및 폐기
- 절단점 pointer 이벤트 처리
- 단면 정면 카메라 이동
- 컴포넌트 unmount 시 이벤트 및 GPU 자원 해제

반환 API 예시:

```ts
return {
  sectionPlaneRef,
  sectionMetrics,
  redrawSection,
  resetSection,
  flipSection,
  moveSection,
  focusSection,
}
```

### 10.3 `src/hooks/useGeoModel.ts` 수정

- 지층 관련 객체 참조를 외부에 반환한다.
- Smooth/Voxel 메시 생성 후 현재 절단 평면을 재적용할 수 있게 한다.
- 지층 재생성 시 기존 Helper는 제거하지 않는다.
- borehole 객체의 절단 적용 대상을 명확히 구분한다.
- 선택 및 투명도 효과가 `material.clippingPlanes`를 덮어쓰지 않도록 한다.

권장 반환값:

```ts
return {
  ...existingApi,
  sectionTargets: {
    smoothMeshRef,
    voxelMeshRef,
    drapeRef,
    bhGroupRef,
    stratumGroupRef,
    dimsRef,
  },
}
```

### 10.4 `src/pages/Viewer3DPage.tsx` 수정

- `VerticalSectionState` 상태 추가
- 기존 `pickMode`와 section 입력 모드 조정
- `useSectionPlane` 호출
- `ViewerControls`에 진입 콜백 전달
- `SectionControls` 렌더
- 프로젝트 변경 시 단면 초기화
- 모델 bbox 변경 시 단면 범위 재평가

### 10.5 `src/components/SectionControls.tsx` 신규

- 단면 편집 UI만 담당
- Three.js 객체를 직접 참조하지 않음
- 실제 m 단위 값과 계산된 방위각 표시
- 조작은 모두 콜백으로 상위에 전달
- 모바일 화면에서는 하단 시트 형태 적용

### 10.6 `src/hooks/useThreeScene.ts` 수정

- `localClippingEnabled` 활성화
- stencil 필요 옵션 추가
- 렌더러 dispose 시 기존 정리 유지
- 개발 환경에서 WebGL capability 진단 정보 제공 여부 검토

---

## 11. 단계별 개발 순서

### 단계 0. 기준선 확보

작업:

- 현재 Smooth/Voxel 장면 스크린샷 확보
- 대표 프로젝트 3개 선정
- triangle 수, draw call, 평균 FPS 기록
- 기존 빌드 및 테스트 결과 기록

완료 조건:

- 변경 전 성능과 화면 비교 자료가 존재한다.
- 대표 데이터에 접촉점 오류가 없음을 기존 진단으로 확인한다.

### 단계 1. 평면 수학 및 상태 모델

작업:

- 타입 및 기본 상태 작성
- 평면 생성 유틸리티 구현
- 유효성, 반전, 오프셋, 방위각 테스트

완료 조건:

- 동서/남북/대각선 절단의 법선이 예상 방향과 일치한다.
- 반전 시 법선과 잘리는 쪽이 정확히 반대가 된다.
- 실제 m와 모델 좌표 변환 오차가 허용 범위 이내다.

### 단계 2. 고정 평면 클리핑 PoC

작업:

- 렌더러 로컬 클리핑 활성화
- 임시 고정 X 또는 Z 평면 적용
- Smooth/Voxel 및 지표면 동작 확인

완료 조건:

- 지층 메시만 절단된다.
- 모드 전환 후에도 절단 상태가 유지된다.
- 지층 가시성 변경과 충돌하지 않는다.

### 단계 3. 두 점 입력과 Helper

작업:

- section 입력 모드 구현
- 두 점 피킹
- 절단선, 평면, 방향 화살표 생성
- 클릭과 OrbitControls 드래그 구분
- Esc 취소 구현

완료 조건:

- 사용자가 임의 방향 수직 단면을 생성할 수 있다.
- 시추공 선택과 단면 입력이 동시에 실행되지 않는다.
- Helper 객체가 모델 재생성 후 중복되지 않는다.

### 단계 4. 편집 UI

작업:

- SectionControls 구현
- 방향 반전
- m 단위 평행 이동
- 다시 그리기 및 초기화
- 지표면/시추공 절단 옵션

완료 조건:

- 모든 조작이 메시 재생성 없이 즉시 반영된다.
- 단면을 껐을 때 모든 재질에서 클리핑이 해제된다.
- UI 표시값과 실제 절단 위치가 일치한다.

### 단계 5. 단면 정면 보기

작업:

- 단면 중심 및 fit 거리 계산
- 카메라 정렬
- 화면 좌우 방향 고정
- 기존 자유 3D 조작으로 복귀 지원

완료 조건:

- 단면 전체가 화면에 들어온다.
- 화면 위쪽은 항상 표고 증가 방향이다.
- 수직과장 변경 후 다시 보기에도 중심이 맞는다.

### 단계 6. Cap 및 경계 강조

작업:

- stencil cap PoC
- 지층별 cap 색상
- renderOrder 및 depth 설정
- Smooth/Voxel별 품질 확인
- 실패 시 cap 자동 비활성화 처리

완료 조건:

- Smooth 지층 절단면이 빈 공간 없이 지층 색으로 채워진다.
- 인접 지층 사이에 심한 깜빡임이나 색상 오염이 없다.
- cap을 껐을 때 기본 클리핑 경로가 정상 동작한다.

### 단계 7. 단면 정보 및 시추공 투영

작업:

- 거리·표고 눈금
- 방위각, 길이, 오프셋 표시
- 단면 허용거리 내 시추공 투영
- 실제 위치와 투영 위치를 구분하는 스타일 적용

완료 조건:

- 표시 수치는 수직과장과 무관하게 실제 단위를 사용한다.
- 단면에서 멀리 떨어진 시추공은 제외된다.
- 투영 허용거리 값이 사용자에게 명시된다.

### 단계 8. 회귀 검증 및 배포

작업:

- 자동 테스트
- 대표 데이터 수동 검증
- 성능 비교
- 모바일 및 주요 브라우저 확인
- 사용자 도움말 작성

완료 조건:

- 아래 인수 기준을 모두 충족한다.
- 기존 시추공 선택, 지층 토글, 수직과장, 내보내기 기능에 회귀가 없다.

---

## 12. 시험 계획

### 12.1 단위 테스트

`tests/sectionPlane.test.ts`

| 시험 | 기대 결과 |
|---|---|
| 동서 방향 선 | 남북 방향 법선 생성 |
| 남북 방향 선 | 동서 방향 법선 생성 |
| 대각선 선 | 정규화된 수평 법선 생성 |
| 시작점=끝점 | 유효하지 않은 선 |
| flip=false/true | 법선 부호 반전 |
| offset +10m | 법선 방향으로 정확히 10m 이동 |
| 방위각 북/동/남/서 | 0/90/180/270° |
| metersToModel 변환 | 왕복 오차 허용치 이내 |

### 12.2 통합 테스트

- 단면 생성 전후 Worker 결과가 동일한지 확인
- Smooth→Voxel→Smooth 전환 시 같은 위치 유지
- 지층 표시 토글 후 단면 유지
- 수직과장 1/5/10/20배에서 수평 절단 위치 유지
- 바닥 깊이 변경으로 메시 재생성 후 단면 재적용
- 미분류 `연장/유지` 전환 후 단면 재적용
- 지표면 숨김 상태에서도 단면점 선택 가능
- 단면 도구 종료 후 기존 시추공 선택 정상화

### 12.3 시각 검증

대표 데이터:

1. 지층이 모두 존재하는 프로젝트
2. 일부 지층이 핀치아웃되는 프로젝트
3. 지층이 하나 또는 두 개뿐인 프로젝트
4. 모델 영역이 긴 직사각형인 프로젝트
5. 시추공 수가 많고 지표 고도차가 큰 프로젝트

검사항목:

- 절단면과 Helper 일치
- 지층 경계 연속성
- cap 색상과 지층 범례 일치
- 경계부 z-fighting
- 모델 외부 이동 시 비정상 잔상
- 카메라 근접 시 클리핑 노이즈

### 12.4 성능 기준

- cap 비활성 상태 FPS 저하: 기준 대비 10% 이내
- cap 활성 상태 FPS 저하: 기준 대비 25% 이내
- 평면 슬라이더 조작 응답: 100ms 이내
- 단면 생성: Worker 재실행 없음
- GPU geometry 추가 메모리: Helper 제외 최소화

---

## 13. 인수 기준

### 기능

- 사용자가 두 점으로 수직 단면을 생성할 수 있다.
- 절단 방향을 명확히 확인하고 반전할 수 있다.
- 절단면을 실제 m 단위로 이동할 수 있다.
- Smooth와 Voxel에서 동일 위치가 절단된다.
- 단면을 끄면 모델이 원래 상태로 복구된다.
- 단면 정면 보기가 모델 범위를 적절히 화면에 맞춘다.

### 정확도

- 절단 평면의 수평 위치 오차는 모델 좌표 부동소수점 허용치 이내다.
- 단면 거리와 표고는 수직과장 전 실제 단위로 표시된다.
- 단면 기능 활성화 전후 지층 geometry buffer가 변경되지 않는다.
- 시추공 접촉점과 모델 경계의 기존 하드 제약 결과가 변하지 않는다.

### 안정성

- 연속 생성/초기화 50회 후 Helper와 이벤트 리스너가 중복되지 않는다.
- 프로젝트 전환 후 이전 단면 객체가 남지 않는다.
- 메시 재생성 후 폐기된 재질을 참조하지 않는다.
- WebGL context 오류 없이 renderer가 정리된다.

### 사용성

- 첫 사용자가 별도 설명 없이 `두 점 선택 → 단면 생성` 흐름을 이해할 수 있다.
- 현재 잘려 나가는 방향이 화살표로 표시된다.
- 작성 취소 및 초기화 동작이 명확하다.
- 마우스와 키보드 모두에서 조작할 수 있다.

---

## 14. 위험요소와 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| 열린 지층 메시에서 cap 누락 | 단면에 구멍 표시 | 클리핑과 cap을 분리하고 cap만 비활성화 |
| Stencil 렌더 순서 충돌 | 지층색 오염·깜빡임 | 지층별 renderOrder 고정 및 불투명 재질 사용 |
| 메시 재생성 후 clipping 소실 | UI와 화면 불일치 | 생성 직후 현재 평면 재적용 |
| Raycaster 입력 충돌 | 시추공 패널이 동시에 열림 | 단일 `pickMode` 상태 머신 적용 |
| 수직과장 좌표 혼동 | 표고·거리 오표시 | 실제 좌표 변환 함수를 단일화 |
| 모델 밖 평면 이동 | 화면 전체가 사라짐 | 이동 범위 제한 및 경고/0 위치 복귀 제공 |
| Voxel cap 부하 | 낮은 사양 FPS 저하 | Voxel cap 옵션 분리 또는 기본 비활성 |
| 투명도 효과와 depth 충돌 | 절단 경계 시각 오류 | cap 활성 중 지층 재질 불투명 유지 |

---

## 15. 개발 단위 및 예상 공수

| 작업 | 예상 공수 |
|---|---:|
| 상태·평면 유틸리티 및 테스트 | 1일 |
| 로컬 클리핑 PoC 및 메시 연결 | 1일 |
| 두 점 피킹 및 Helper | 2일 |
| 편집 UI와 이동·반전 | 1.5일 |
| 단면 정면 카메라 | 1일 |
| 회귀 테스트 및 안정화 | 1.5일 |
| 1차 배포 합계 | 약 8일 |
| Stencil cap | 2~3일 |
| 눈금·정보·시추공 투영 | 2~3일 |
| 2차 배포 추가 | 약 4~6일 |

공수는 대표 데이터와 현재 브라우저 환경에서 메시 폐합 상태가 양호하다는 전제다. cap 처리 중 열린 메시 또는 렌더 순서 문제가 발견되면 추가 안정화가 필요하다.

---

## 16. 권장 배포 전략

### Release A: 내부 검증

- 고정 X/Z 평면
- 반전 및 이동
- Smooth만 지원
- 개발자 플래그로 노출

### Release B: 사용자 MVP

- 두 점 임의 수직 단면
- Smooth/Voxel 지원
- Helper 및 편집 패널
- 정면 보기
- 지표면/시추공 옵션

### Release C: 완성형 단면

- 지층별 cap
- 거리 및 표고 눈금
- 시추공 투영
- 단면 상태 저장

기능 플래그 예:

```ts
const ENABLE_VERTICAL_SECTION = true
const ENABLE_SECTION_CAP = false
```

cap 기능은 기본 클리핑과 독립적으로 비활성화할 수 있게 유지한다.

---

## 17. 후속 확장

안정화 후 다음 순서로 확장한다.

1. 여러 단면 이름 지정 및 저장
2. 일정 간격 평행 단면 탐색
3. Orthographic 단면 도면 모드
4. 단면 PNG/PDF 출력
5. 지층 경계 폴리라인 추출
6. DXF/GeoJSON 내보내기
7. 경사 단면
8. 곡선 경로를 따른 전개 단면
9. 실제 솔리드 메시 분할 및 저장

실제 메시 분할은 렌더링 절단과 별도 도메인으로 유지한다. 해당 단계에서는 Boolean 연산 정확도, 폐합성, 지층 속성 보존 및 내보내기 형식을 별도로 설계해야 한다.

