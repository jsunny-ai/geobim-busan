# 최하부 실측 지층 무한 연장(대안 2) 상세 구현 계획서

현재 시각화 중인 시추공 데이터셋에 경암(hard_rock)이 존재하지 않음에도 최하부에 대규모 경암층이 렌더링되는 기하학적 왜곡 문제를 해결하기 위해, 시추 데이터셋에 존재하는 **가장 깊은 실측 지층을 최하단 영역까지 동적으로 연장하여 렌더링하는 대안 ②**의 상세 구현 계획입니다.

---

## 1. 개요 (Overview)
* **목적**: 데이터셋에 경암층이 존재하지 않는 프로젝트의 경우, 최하부 영역을 강제로 경암으로 채우지 않고 시추공에서 실제로 도출된 가장 하위 지층(예: 연암)이 바닥까지 연장되도록 수정합니다.
* **배경**: 현재 `classifyByRBF` 함수는 연암 하부 경계 ($bndElev[2]$) 이하의 모든 공간을 무조건 `4 (hard_rock)`로 분류하고 있습니다. 이를 로직 상에서 동적으로 변경 가능한 파라미터(`maxLayerCode`)로 제어하여 왜곡을 해결합니다.

---

## 2. 사용자 검토 필요 사항 (User Review Required)

> [!IMPORTANT]
> **하위 호환성 및 다중 프로젝트 대응**
> * 본 구현은 경암이 존재하는 프로젝트와 존재하지 않는 프로젝트 모두에 동적으로 대응할 수 있도록 `classifyByRBF` 함수의 인자로 `maxLayerCode`를 전달하는 방식을 사용합니다. 
> * 따라서 기존 경암이 포함된 시추 프로젝트에서는 정상적으로 경암층이 렌더링되며, 경암이 없는 프로젝트에서는 연암 혹은 풍화암 등 최하단 실측 지층이 바닥을 채우게 됩니다.

---

## 3. 개방형 질문 (Open Questions)

> [!NOTE]
> 특별히 해결되지 않은 모호성은 없으며, 사용자가 승인한 **대안 ②**에 맞추어 명확하게 설계를 완료하였습니다.

---

## 4. 제안된 변경 사항 (Proposed Changes)

### [Component: 3D Geological Stratum Modeling Engine]

---

#### [MODIFY] [rbfSurface.ts](file:///c:\antigravity\GeoBIM\geobim-stratum\sites\viewer-3d\src\lib\rbfSurface.ts)

* `classifyByRBF` 함수의 시그니처에 `maxLayerCode = 4` (기본값) 파라미터를 추가하여 하위 호환성을 유지합니다.
* 함수 내부의 최하단 반환부를 고정값 `4` 대신 `maxLayerCode` 변수로 대체합니다.

**코드 변경 계획 (Line 218 ~ 255 부근)**:
```typescript
export function classifyByRBF(
  lng: number,
  lat: number,
  elevation: number,
  surfaceElev: number,
  bounds: RBFBoundaries,
  maxLayerCode = 4 // 🌟 동적 최하부 코드를 전달받을 인자 추가 (하위 호환성 유지)
): number {
  // ... (기존 RBF 평가 및 클램핑 로직 동일)

  // elevation 기준 지층 결정
  if (elevation >= bndElev[0]) return 1  // soil
  if (elevation >= bndElev[1]) return 2  // weathered_rock
  if (elevation >= bndElev[2]) return 3  // soft_rock
  return maxLayerCode                     // 🌟 4(hard_rock) 대신 동적 층 코드로 리턴
}
```

---

#### [MODIFY] [Viewer3DPage.tsx](file:///c:\antigravity\GeoBIM\geobim-stratum\sites\viewer-3d\src\pages\Viewer3DPage.tsx)

* `useEffect` 내부에서 RBF 3D 지층 분류를 가동하기 직전에, 현재 데이터셋(`boreholes`) 내부에 존재하는 실제 지층 그룹들을 분석합니다.
* `LAYER_STACK` 순서에 의거하여 현재 취득된 지층 중 가장 깊은 지층의 코드를 산출하여 `maxLayerCode`에 대입합니다.
* `classifyByRBF` 호출 시 산출된 `maxLayerCode`를 인자로 넘겨줍니다.

**코드 변경 계획 (Line 512 ~ 526 부근)**:
```typescript
        // 🌟 최하단 실측 지층 코드 동적 판별 (대안 ②)
        let maxLayerCode = 4 // 기본값: 경암(hard_rock)
        const activeGroups = new Set<string>()
        boreholes.forEach((b) => {
          b.strata?.forEach((s) => {
            if (s.strata_group) activeGroups.add(s.strata_group)
          })
        })
        if (activeGroups.size > 0) {
          if (activeGroups.has("hard_rock")) maxLayerCode = 4
          else if (activeGroups.has("soft_rock")) maxLayerCode = 3
          else if (activeGroups.has("weathered_rock")) maxLayerCode = 2
          else if (activeGroups.has("soil")) maxLayerCode = 1
        }

        setStatus("RBF 경계면 기반 3D 지층 분류 중...")
        const label = new Int8Array(NX * NX * MZ)
        for (let j = 0; j < NX; j++) {
          for (let i = 0; i < NX; i++) {
            const lng = minLng + (maxLng - minLng) * (i / (NX - 1))
            const lat = minLat + (maxLat - minLat) * (j / (NX - 1))
            const surfElev = elevGrid[j][i]

            for (let l = 0; l < MZ; l++) {
              const E = yBotM + dz * l
              // 🌟 classifyByRBF 호출 시 maxLayerCode 전달
              label[idx3(i, j, l)] = classifyByRBF(lng, lat, E, surfElev, rbfBounds, maxLayerCode)
            }
          }
        }
```

---

## 5. 검증 계획 (Verification Plan)

### 자동화 테스트 및 타입 체킹
* 수정이 완료되면 `npm run build` 명령어를 실행하여, 정적 분석 오류가 없는지 및 정상적으로 프로덕션 빌드가 수행되는지 확인합니다.

### 수동 검증 및 시각적 피드백
* 경암이 존재하지 않는 시추공 데이터셋 화면에서 뷰어를 새로고침하여 최하단에 회색의 경암 대신 초록색의 연암(soft_rock) 혹은 갈색의 풍화암 등 데이터셋 내 실제 존재하는 최하부 실측 지층이 빈틈없이 채워져 가시화되는지 확인합니다.
