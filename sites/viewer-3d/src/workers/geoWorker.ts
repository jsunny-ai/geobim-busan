// =============================================================================
// geoWorker.ts — 옵션 A: 두께 기반 2.5D 구조층서 모델 (2026-06-10 전면 개편)
//
// Leapfrog의 층서(deposit) 모델과 동등한 결과를 내기 위한 3원칙:
//   ① 정확보간: TPS RBF λ≈0 → 시추공 위치에서 실측 두께를 그대로 통과
//      지표면은 DEM 스무딩 후 Wendland 커널 '잔차 재스냅'(Snap to data 동등)
//   ② 층서 순서의 구조적 보장: 경계면 = 지표면 − Σ두께 (두께 ≥ 0)
//      → Math.max 클램프 체인 불필요, 역전·수직 절벽 원천 차단
//   ③ 부재 데이터의 적극 활용 — Leapfrog Vein 'Pinch out' 등가 구현:
//      Leapfrog는 층이 없는 시추공에 'outside' 구간을 만들고 벽면을 반전시켜
//      HW/FW가 교차(두께<0)하도록 강제한 뒤 교차 영역을 제거한다.
//      여기서는 부재공에 음수 더미 두께(−0.75×최근접 보유공 두께)를 부여해
//      두께장이 부재공에서 확실히 음수가 되도록 하고, max(T,0) 클램프로
//      보유공 주변 물방울(렌즈) 형성 후 부재공 '앞'에서 소멸시킨다.
// =============================================================================
import { buildElevationGrid, idwGrid } from "@/lib/terrain"
import { buildLayerSolidGeometryData, type VoxelCell } from "../lib/geoGeometry"
import { createLocalProjection } from "@/lib/projection"
import { effectiveSoilThickness, soilAbsenceRadii, soilPresenceWeightFromSigned } from "../lib/soilPinchout"
import { buildCoastalLandMask } from "../lib/coastalLandMask"
import { coastalDisplayTerrainElevation } from "../lib/coastalDisplayTerrain"
import { analyzeConstraintStability, applyConstraintsAtGridNodes } from "../lib/constraintStability"
import { orderSoilDetailOccurrences, unclassifiedSoilBottom } from "../lib/soilDetailOrdering"

const LAYER_STACK = ["soil", "weathered_rock", "soft_rock", "normal_rock", "hard_rock", "unknown"] as const
const STRATA_KEYS = ["soil", "weathered_rock", "soft_rock", "normal_rock", "hard_rock"] as const
type StrataKey = (typeof STRATA_KEYS)[number]

type GridPoint = { x: number; y: number; z: number }
type GridAxes = { gx: number[]; gy: number[] }
type ModelStabilityDiagnostics = {
  rbfIdwFallbacks: number
  snapNodeFallbacks: number
  coefficientFallbacks: number
}
const CONTACT_TOLERANCE_M = 1e-4
const SOIL_DETAIL_ORDER = [
  "토사",
  "매립토",
  "매립 점토",
  "매립 사질토",
  "매립 자갈",
  "퇴적토",
  "퇴적점토",
  "퇴적 사질토",
  "퇴적자갈",
  "충적토",
  "붕적토",
  "풍화토",
  "점토",
  "실트",
  "모래",
  "자갈",
] as const

function normalizeSoilDetailName(raw: string | null | undefined): string | null {
  const key = String(raw ?? "").trim()
  if (!key) return null
  const compactKey = key.replace(/\s+/g, "")
  const aliases: Record<string, string> = {
    토사: "토사",
    토층: "토사",
    표토: "토사",
    매립층: "매립토",
    매립토: "매립토",
    매립점토: "매립 점토",
    매립사질토: "매립 사질토",
    매립모래: "매립토",
    매립자갈: "매립 자갈",
    되메움: "매립토",
    붕적층: "붕적토",
    붕적토: "붕적토",
    퇴적층: "퇴적토",
    퇴적토: "퇴적토",
    퇴적점성토: "퇴적점토",
    퇴적점토: "퇴적점토",
    퇴적사질토: "퇴적 사질토",
    퇴적모래: "퇴적 사질토",
    퇴적역질토: "퇴적자갈",
    퇴적자갈: "퇴적자갈",
    충적층: "충적토",
    충적토: "충적토",
    풍화토: "풍화토",
    잔류토: "풍화토",
    점성토: "점토",
    점토: "점토",
    실트: "실트",
    사질토: "모래",
    모래: "모래",
    역질토: "자갈",
    자갈: "자갈",
  }
  return aliases[key] ?? aliases[compactKey] ?? null
}

const M_PER_DEG_LAT = 110540
const mPerDegLng = (cosLat: number) => 111320 * cosLat

// ── Thin Plate Spline 커널 ───────────────────────────────────────────────────
function thinPlateKernel(r: number) {
  if (r <= 1e-9) return 0
  return r * r * Math.log(r)
}

// ── Wendland C2 컴팩트 서포트 커널 (잔차 재스냅용) ──────────────────────────
function wendlandC2(r: number, R: number) {
  if (r >= R) return 0
  const q = r / R
  const t = 1 - q
  return t * t * t * t * (4 * q + 1)
}

function solveLinearSystem(matrix: number[][], rhs: number[]) {
  const n = rhs.length
  const a = matrix.map((row, i) => [...row, rhs[i]])

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null
    if (pivot !== col) {
      const tmp = a[col]
      a[col] = a[pivot]
      a[pivot] = tmp
    }

    const div = a[col][col]
    for (let c = col; c <= n; c++) a[col][c] /= div

    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col]
      if (Math.abs(factor) < 1e-14) continue
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c]
    }
  }

  return a.map((row) => row[n])
}

// ── TPS RBF 격자 보간 ───────────────────────────────────────────────────────
// lambda=1e-8: 수치 안정용 미세 릿지(사실상 정확보간).
// 기존 λ=0.02(평활 스플라인)는 시추공 값 이탈의 원인이므로 사용하지 않는다.
function rbfGrid(
  points: GridPoint[],
  gx: number[],
  gy: number[],
  powerFallback = 1,
  lambda = 1e-8,
  stability?: ModelStabilityDiagnostics,
): number[][] {
  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
  if (valid.length < 3) return idwGrid(valid, gx, gy, powerFallback)
  const assessment = analyzeConstraintStability(valid)
  if (assessment.conflictingExactPairCount > 0) {
    throw new Error(`동일 좌표에 서로 다른 지층 제약값이 ${assessment.conflictingExactPairCount}쌍 있습니다.`)
  }
  const stableFallback = (coefficientFailure = false) => {
    if (stability) {
      stability.rbfIdwFallbacks++
      if (coefficientFailure) stability.coefficientFallbacks++
    }
    return applyConstraintsAtGridNodes(idwGrid(valid, gx, gy, powerFallback), gx, gy, valid)
  }
  if (assessment.requiresStableFallback) return stableFallback()

  const midLat = valid.reduce((sum, p) => sum + p.y, 0) / valid.length
  const cosLat = Math.cos((midLat * Math.PI) / 180)
  const mx = valid.reduce((sum, p) => sum + p.x * mPerDegLng(cosLat), 0) / valid.length
  const my = valid.reduce((sum, p) => sum + p.y * M_PER_DEG_LAT, 0) / valid.length
  const xy = valid.map((p) => ({
    x: p.x * mPerDegLng(cosLat) - mx,
    y: p.y * M_PER_DEG_LAT - my,
    z: p.z,
  }))

  let meanDist = 0
  let pairCount = 0
  for (let i = 0; i < xy.length; i++) {
    for (let j = i + 1; j < xy.length; j++) {
      meanDist += Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y)
      pairCount++
    }
  }
  const scale = pairCount > 0 ? Math.max(meanDist / pairCount, 1) : 1
  const normalized = xy.map((p) => ({ x: p.x / scale, y: p.y / scale, z: p.z }))

  const n = normalized.length
  const size = n + 3
  const matrix = Array.from({ length: size }, () => Array(size).fill(0))
  const rhs = Array(size).fill(0)

  for (let i = 0; i < n; i++) {
    rhs[i] = normalized[i].z
    for (let j = 0; j < n; j++) {
      const r = Math.hypot(normalized[i].x - normalized[j].x, normalized[i].y - normalized[j].y)
      matrix[i][j] = thinPlateKernel(r)
    }
    matrix[i][i] += lambda
    matrix[i][n] = 1
    matrix[i][n + 1] = normalized[i].x
    matrix[i][n + 2] = normalized[i].y
    matrix[n][i] = 1
    matrix[n + 1][i] = normalized[i].x
    matrix[n + 2][i] = normalized[i].y
  }

  const solution = solveLinearSystem(matrix, rhs)
  if (!solution) return stableFallback(true)
  const zMin = valid.reduce((minimum, point) => Math.min(minimum, point.z), Number.POSITIVE_INFINITY)
  const zMax = valid.reduce((maximum, point) => Math.max(maximum, point.z), Number.NEGATIVE_INFINITY)
  const zSpan = Math.max(zMax - zMin, 1)
  const maxKernelCoefficient = solution.slice(0, n).reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0)
  if (!Number.isFinite(maxKernelCoefficient) || maxKernelCoefficient > zSpan * 1e5) return stableFallback(true)

  const out: number[][] = []
  let unstableOutput = false
  const safeMin = zMin - zSpan * 4
  const safeMax = zMax + zSpan * 4
  for (let j = 0; j < gy.length; j++) {
    const row: number[] = []
    for (let i = 0; i < gx.length; i++) {
      const x = (gx[i] * mPerDegLng(cosLat) - mx) / scale
      const y = (gy[j] * M_PER_DEG_LAT - my) / scale
      let value = solution[n] + solution[n + 1] * x + solution[n + 2] * y
      for (let p = 0; p < n; p++) {
        value += solution[p] * thinPlateKernel(Math.hypot(x - normalized[p].x, y - normalized[p].y))
      }
      if (!Number.isFinite(value) || value < safeMin || value > safeMax) unstableOutput = true
      row.push(value)
    }
    out.push(row)
  }
  if (unstableOutput) return stableFallback(true)
  return applyConstraintsAtGridNodes(out, gx, gy, valid)
}

// ── 격자 쌍선형 샘플링 ──────────────────────────────────────────────────────
function sampleGridBilinear(grid: number[][], gx: number[], gy: number[], x: number, y: number) {
  const nx = gx.length, ny = gy.length
  const sx = axisSegment(gx, x)
  const sy = axisSegment(gy, y)
  const i0 = Math.max(0, Math.min(nx - 2, sx.i0))
  const j0 = Math.max(0, Math.min(ny - 2, sy.i0))
  const tx = sx.t
  const ty = sy.t
  const v00 = grid[j0][i0], v10 = grid[j0][i0 + 1]
  const v01 = grid[j0 + 1][i0], v11 = grid[j0 + 1][i0 + 1]
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
}

function axisSegment(axis: number[], value: number) {
  const n = axis.length
  if (n < 2) return { i0: 0, t: 0 }
  if (value <= axis[0]) return { i0: 0, t: 0 }
  if (value >= axis[n - 1]) return { i0: n - 2, t: 1 }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (axis[mid] <= value) lo = mid
    else hi = mid
  }
  const denom = axis[lo + 1] - axis[lo]
  return { i0: lo, t: denom === 0 ? 0 : Math.max(0, Math.min(1, (value - axis[lo]) / denom)) }
}

function createBoreholeConstrainedAxes(
  bbox: [number, number, number, number],
  baseN: number,
  boreholes: any[],
): GridAxes {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const baseLng = Array.from({ length: baseN }, (_, i) => minLng + ((maxLng - minLng) * i) / (baseN - 1))
  const baseLat = Array.from({ length: baseN }, (_, j) => minLat + ((maxLat - minLat) * j) / (baseN - 1))
  const lngAnchors = boreholes
    .map((b) => b.longitude)
    .filter((v) => Number.isFinite(v) && v >= minLng && v <= maxLng)
  const latAnchors = boreholes
    .map((b) => b.latitude)
    .filter((v) => Number.isFinite(v) && v >= minLat && v <= maxLat)

  let gx = mergeAxis(baseLng, lngAnchors)
  let gy = mergeAxis(baseLat, latAnchors)
  const target = Math.max(gx.length, gy.length)
  gx = padAxis(gx, minLng, maxLng, target)
  gy = padAxis(gy, minLat, maxLat, target)
  return { gx, gy }
}

function mergeAxis(base: number[], anchors: number[]) {
  const values = [...base, ...anchors].filter(Number.isFinite).sort((a, b) => a - b)
  const out: number[] = []
  const eps = Math.max(Math.abs(values[values.length - 1] - values[0]) * 1e-12, 1e-14)
  for (const v of values) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > eps) out.push(v)
  }
  return out
}

function padAxis(axis: number[], min: number, max: number, targetLength: number) {
  const out = mergeAxis(axis, [min, max])
  while (out.length < targetLength) {
    let bestIndex = 0
    let bestGap = -Infinity
    for (let i = 0; i + 1 < out.length; i++) {
      const gap = out[i + 1] - out[i]
      if (gap > bestGap) {
        bestGap = gap
        bestIndex = i
      }
    }
    out.splice(bestIndex + 1, 0, (out[bestIndex] + out[bestIndex + 1]) / 2)
  }
  return out
}

function findAxisIndex(axis: number[], value: number) {
  const span = Math.max(Math.abs(axis[axis.length - 1] - axis[0]), 1)
  const eps = span * 1e-10
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i] - value)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return bestD <= eps ? best : -1
}

function enforceBoundaryTargetsAtGridNodes(
  bottomGrids: Record<StrataKey, number[][]>,
  gx: number[],
  gy: number[],
  boundaryTargets: Record<StrataKey, GridPoint[]>,
) {
  for (const key of STRATA_KEYS) {
    for (const target of boundaryTargets[key]) {
      const i = findAxisIndex(gx, target.x)
      const j = findAxisIndex(gy, target.y)
      if (i >= 0 && j >= 0) bottomGrids[key][j][i] = target.z
    }
  }
}

// ── 잔차 재스냅 (Leapfrog 'Snap to data' 동등) ──────────────────────────────
// 스무딩으로 이탈한 격자를 제어점 목표값에 정확히 통과하도록 국소 보정.
// Wendland 커널은 radiusM 밖에서 0이므로 DEM의 전체 형상은 보존된다.
function snapGridToPoints(
  grid: number[][],
  gx: number[],
  gy: number[],
  targets: GridPoint[],
  radiusM: number,
  stability?: ModelStabilityDiagnostics,
): number[][] {
  const n = targets.length
  if (n === 0) return grid
  const assessment = analyzeConstraintStability(targets)
  if (assessment.conflictingExactPairCount > 0) {
    throw new Error(`동일 좌표에 서로 다른 스냅 목표값이 ${assessment.conflictingExactPairCount}쌍 있습니다.`)
  }
  const nodeOnlyFallback = (coefficientFailure = false) => {
    if (stability) {
      stability.snapNodeFallbacks++
      if (coefficientFailure) stability.coefficientFallbacks++
    }
    return applyConstraintsAtGridNodes(grid, gx, gy, targets)
  }
  if (assessment.requiresStableFallback) return nodeOnlyFallback()

  const midLat = (gy[0] + gy[gy.length - 1]) / 2
  const cosLat = Math.cos((midLat * Math.PI) / 180)
  const toMX = (lng: number) => lng * mPerDegLng(cosLat)
  const toMY = (lat: number) => lat * M_PER_DEG_LAT

  // 목표값 − 현재 격자값 = 잔차
  const residuals = targets.map((t) => t.z - sampleGridBilinear(grid, gx, gy, t.x, t.y))

  // Wendland 커널 행렬(SPD) 해 → 정확 통과 보장 (서포트 중첩도 자동 처리)
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const d = Math.hypot(toMX(targets[i].x) - toMX(targets[j].x), toMY(targets[i].y) - toMY(targets[j].y))
      return wendlandC2(d, radiusM) + (i === j ? 1e-9 : 0)
    }),
  )
  const w = solveLinearSystem(A, residuals)
  if (!w) return nodeOnlyFallback(true)
  const residualScale = Math.max(1e-6, ...residuals.map((value) => Math.abs(value)))
  const maxWeight = w.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0)
  if (!Number.isFinite(maxWeight) || maxWeight > residualScale * 1e5) return nodeOnlyFallback(true)

  let unstableCorrection = false
  const snapped = grid.map((row, j) =>
    row.map((v, i) => {
      let s = v
      for (let p = 0; p < n; p++) {
        const d = Math.hypot(toMX(gx[i]) - toMX(targets[p].x), toMY(gy[j]) - toMY(targets[p].y))
        if (d < radiusM) s += w[p] * wendlandC2(d, radiusM)
      }
      if (!Number.isFinite(s) || Math.abs(s - v) > residualScale * 25 + 1) unstableCorrection = true
      return s
    }),
  )
  if (unstableCorrection) return nodeOnlyFallback(true)
  return applyConstraintsAtGridNodes(snapped, gx, gy, targets)
}

function clampLayerBoundaries(
  elevGrid: number[][],
  bottomGrids: Record<StrataKey, number[][]>,
  yBotM: number,
) {
  const rows = elevGrid.length
  const cols = elevGrid[0]?.length ?? 0
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let upper = elevGrid[j][i]
      for (const key of STRATA_KEYS) {
        const clamped = Math.max(yBotM, Math.min(bottomGrids[key][j][i], upper))
        bottomGrids[key][j][i] = clamped
        upper = clamped
      }
    }
  }
}

function buildBoundaryTargets(
  profiles: Array<{
    x: number
    y: number
    elev: number
    thick: Record<StrataKey, number>
    deepestRank: number
    segs: Array<{ from: number; to: number; type: string }>
  }>,
  elevGrid: number[][],
  gx: number[],
  gy: number[],
) {
  const targets: Record<StrataKey, GridPoint[]> = {
    soil: [], weathered_rock: [], soft_rock: [], normal_rock: [], hard_rock: [],
  }

  for (const p of profiles) {
    // [기둥↔솔리드 정합] 기둥(useGeoModel)이 지층을 (보간 지표면 surfElev − 실측심도)에
    // 놓으므로, 경계 스냅 타깃도 동일하게 '보간 지표면'을 기준으로 한다. 원공 표고
    // (p.elev) 대신 시추공 위치의 elevGrid 쌍선형 샘플을 써야 솔리드 상부면이 기둥의
    // 지층 높이와 정확히 일치한다(표면 스냅에서 제외된 시추공에서도 자동 정합).
    const surfElev = sampleGridBilinear(elevGrid, gx, gy, p.x, p.y)
    // 솔리드 모델은 토사 세분류 내부 접촉면을 별도 표면으로 갖지 않고,
    // 토사/풍화암/연암/보통암/경암의 5개 주요 지층군 누적 두께를 보간한다.
    // 따라서 hard constraint도 원시 segment 경계가 아니라 주요 지층군별
    // 누적 하단면에만 걸어야 한다. 매립토→퇴적토→모래처럼 같은 soil 군이
    // 여러 segment로 나뉜 경우 하나의 soil 하단면으로 병합한다.
    let cumulativeDepth = 0
    for (const key of STRATA_KEYS) {
      const thickness = p.thick[key]
      if (!Number.isFinite(thickness) || thickness <= 1e-6) continue
      cumulativeDepth += thickness
      targets[key].push({ x: p.x, y: p.y, z: surfElev - cumulativeDepth })
    }
  }

  // 동일 좌표 또는 같은 constrained grid node에 여러 시추공이 겹치면 하나의
  // 표면이 서로 다른 hard target을 동시에 만족할 수 없다. 부산역처럼 기존+신규
  // 데이터가 함께 들어오는 프로젝트에서 발생할 수 있으므로, 솔리드 보간용
  // constraint는 같은 지층군/격자노드별 평균 target으로 병합한다.
  for (const key of STRATA_KEYS) {
    const grouped = new Map<string, { x: number; y: number; sumZ: number; count: number; minZ: number; maxZ: number }>()
    for (const target of targets[key]) {
      const i = findAxisIndex(gx, target.x)
      const j = findAxisIndex(gy, target.y)
      const groupKey = i >= 0 && j >= 0 ? `${i}:${j}` : `${target.x.toFixed(12)}:${target.y.toFixed(12)}`
      const existing = grouped.get(groupKey)
      if (existing) {
        existing.sumZ += target.z
        existing.count += 1
        existing.minZ = Math.min(existing.minZ, target.z)
        existing.maxZ = Math.max(existing.maxZ, target.z)
      } else {
        grouped.set(groupKey, {
          x: target.x,
          y: target.y,
          sumZ: target.z,
          count: 1,
          minZ: target.z,
          maxZ: target.z,
        })
      }
    }
    targets[key] = [...grouped.values()].map((group) => ({
      x: group.x,
      y: group.y,
      z: group.sumZ / group.count,
    }))
  }

  return targets
}

function snapBoundariesToBoreholes(
  bottomGrids: Record<StrataKey, number[][]>,
  elevGrid: number[][],
  gx: number[],
  gy: number[],
  boundaryTargets: Record<StrataKey, GridPoint[]>,
  radiusM: number,
  yBotM: number,
  stability?: ModelStabilityDiagnostics,
) {
  for (const key of STRATA_KEYS) {
    const targets = boundaryTargets[key]
    if (targets.length === 0) continue
    const snapped = snapGridToPoints(bottomGrids[key], gx, gy, targets, radiusM, stability)
    for (let j = 0; j < bottomGrids[key].length; j++) {
      for (let i = 0; i < bottomGrids[key][j].length; i++) {
        bottomGrids[key][j][i] = snapped[j][i]
      }
    }
  }
  clampLayerBoundaries(elevGrid, bottomGrids, yBotM)
  enforceBoundaryTargetsAtGridNodes(bottomGrids, gx, gy, boundaryTargets)
  return bottomGrids
}

function boundarySnapDiagnostics(
  bottomGrids: Record<StrataKey, number[][]>,
  gx: number[],
  gy: number[],
  boundaryTargets: Record<StrataKey, GridPoint[]>,
) {
  let count = 0
  let maxAbsError = 0
  let sumAbsError = 0
  let maxLayer = -1

  for (let k = 0; k < STRATA_KEYS.length; k++) {
    const key = STRATA_KEYS[k]
    for (const target of boundaryTargets[key]) {
      const sampled = sampleGridBilinear(bottomGrids[key], gx, gy, target.x, target.y)
      const absError = Math.abs(sampled - target.z)
      count++
      sumAbsError += absError
      if (absError > maxAbsError) {
        maxAbsError = absError
        maxLayer = k
      }
    }
  }

  return {
    count,
    maxAbsErrorRaw: maxAbsError,
    meanAbsErrorRaw: count > 0 ? sumAbsError / count : 0,
    maxAbsError: Math.round(maxAbsError * 1000) / 1000,
    meanAbsError: count > 0 ? Math.round((sumAbsError / count) * 1000) / 1000 : 0,
    maxLayer,
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { boreholes, bbox, N, depthBelowMSL, mScale, boxW, boxD, renderMode, includeSoilDetails = true, coastalPolygons, coastalStatus } = e.data as {
    boreholes: any[]
    bbox: [number, number, number, number]
    N: number
    depthBelowMSL: number
    mScale: number
    boxW: number
    boxD: number
    renderMode: "smooth" | "voxel"
    includeSoilDetails?: boolean
    coastalPolygons?: any[] | null
    coastalStatus?: string
  }

  try {
    const stabilityStats: ModelStabilityDiagnostics = {
      rbfIdwFallbacks: 0,
      snapNodeFallbacks: 0,
      coefficientFallbacks: 0,
    }
    // ── 0. 공통 파라미터 ─────────────────────────────────────────────────
    const [minLng, minLat, maxLng, maxLat] = bbox
    const projection = createLocalProjection(bbox, boxW)
    const midLat = (minLat + maxLat) / 2
    const cosLat = Math.cos((midLat * Math.PI) / 180)
    const lngWidthM = projection.widthM
    const latWidthM = projection.heightM
    const confRadiusM = Math.max(150, Math.min(400, Math.min(lngWidthM, latWidthM) * 0.5))

    // ── 1. 지표면 고도 격자 ───────────────────────────────────────────────
    ;(self as any).postMessage({ type: "progress", step: "지표면(AWS Terrain) 계산 중..." })
    const constrainedAxes = createBoreholeConstrainedAxes(bbox, N, boreholes)
    const terr = await buildElevationGrid(bbox, N, constrainedAxes)
    const NX = terr.gx.length

    const coastalLandMask = buildCoastalLandMask(
      coastalPolygons ? [{ geometry: { type: "MultiPolygon", coordinates: coastalPolygons } }] : [],
      { status: coastalStatus ?? "not_configured" },
    )
    if (coastalPolygons) coastalLandMask.polygons = coastalPolygons

    for (let j = 0; j < terr.elevGrid.length; j++) {
      for (let i = 0; i < terr.elevGrid[j].length; i++) {
        terr.elevGrid[j][i] = coastalDisplayTerrainElevation(terr.gx[i], terr.gy[j], terr.elevGrid[j][i], coastalLandMask)
      }
    }
    const origTerrainElevAt = terr.terrainElevAt
    terr.terrainElevAt = (lng: number, lat: number) =>
      coastalDisplayTerrainElevation(lng, lat, origTerrainElevAt(lng, lat), coastalLandMask)

    let elevGrid = terr.elevGrid
    const pts = boreholes
      .map((b) => ({ x: b.longitude, y: b.latitude, z: b.elevation }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && p.z < 2000 && p.z > -200)
    const inputConstraintStability = analyzeConstraintStability(pts, 0.5, 0.01)

    // 시추공 평균 간격 (제어 반경 산출용)
    const avgSpacing = pts.length > 1
      ? Math.sqrt((lngWidthM * latWidthM) / pts.length)
      : Math.max(lngWidthM, latWidthM) * 0.5

    let snapTargets: GridPoint[] = []
    if (pts.length >= 1) {
      // ── 지표면 표고 보정: 잔차 IDW(power=1) + Gaussian 스무딩 + 잔차 재스냅 ──
      // V-World DEM의 자연 경사·형상은 보존하면서 시추공 실측 표고를 '정확히' 통과
      //
      //   1) 잔차 = 시추공 표고 − DEM 표고 → IDW 보간 + 스무딩 (광역 오프셋 보정)
      //   2) 스무딩으로 생긴 시추공 위치 이탈을 Wendland 재스냅으로 제거
      //      → 부드러움(②요구)과 실측 일치(①요구)를 동시에 만족

      // 표고 오류 시추공 필터링: 잔차 중앙값 기준 ±15m 초과 시 제외
      const rawResiduals = pts.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z - terr.terrainElevAt(p.x, p.y),
      }))
      const sortedRes = rawResiduals.map((r) => r.z).sort((a, b) => a - b)
      const medianRes = sortedRes[Math.floor(sortedRes.length / 2)]
      const inlierIdx = rawResiduals.map((r, i) => (Math.abs(r.z - medianRes) < 15 ? i : -1)).filter((i) => i >= 0)
      const residuals = inlierIdx.map((i) => rawResiduals[i])
      snapTargets = inlierIdx.map((i) => pts[i]) // 재스냅 목표 = 필터 통과 시추공의 실측 표고

      // IDW power=1 (부드러운 감쇄)
      let resGrid = idwGrid(residuals, terr.gx, terr.gy, 1)

      // Gaussian 스무딩 4패스 (X→Y 교대, 경계 클램프)
      const Ny = resGrid.length, Nx = resGrid[0].length
      for (let pass = 0; pass < 4; pass++) {
        resGrid = resGrid.map((row, j) =>
          row.map((_, i) => {
            const l = i > 0 ? resGrid[j][i - 1] : resGrid[j][i]
            const r = i < Nx - 1 ? resGrid[j][i + 1] : resGrid[j][i]
            return (l + resGrid[j][i] + r) / 3
          })
        )
        resGrid = resGrid.map((_, j) =>
          Array.from({ length: Nx }, (__: unknown, i: number) => {
            const u = j > 0 ? resGrid[j - 1][i] : resGrid[j][i]
            const d = j < Ny - 1 ? resGrid[j + 1][i] : resGrid[j][i]
            return (u + resGrid[j][i] + d) / 3
          })
        )
      }

      elevGrid = terr.elevGrid.map((row: number[], j: number) =>
        row.map((v: number, i: number) => v + resGrid[j][i])
      )

      // [핵심] 잔차 재스냅: 스무딩 후에도 시추공 표고를 정확히 통과
      // 스냅 반경 = 평균 시추공 간격 × 1.5: 좁은 반경이 만들던 국소 혹(둔덕) 완화
      const snapRadiusM = Math.max(80, Math.min(avgSpacing * 1.5, confRadiusM))
      elevGrid = snapGridToPoints(elevGrid, terr.gx, terr.gy, snapTargets, snapRadiusM, stabilityStats)
    }

    // ── 2. 수직 복셀 파라미터 ─────────────────────────────────────────────
    let gTop = -Infinity
    for (const row of elevGrid) for (const v of row) if (v > gTop) gTop = v
    let minObservedContactElev = Infinity
    for (const b of boreholes) {
      if (!Number.isFinite(b.longitude) || !Number.isFinite(b.latitude)) continue
      const surfElev = sampleGridBilinear(elevGrid, terr.gx, terr.gy, b.longitude, b.latitude)
      if (!Number.isFinite(surfElev)) continue
      for (const seg of b.strata || []) {
        if (!Number.isFinite(seg.depth_bottom)) continue
        minObservedContactElev = Math.min(minObservedContactElev, surfElev - seg.depth_bottom)
      }
    }
    // Keep observed contacts inside the vertical domain; otherwise yBot clamping
    // can violate the borehole hard-constraint check.
    const yBotM = Math.min(
      -depthBelowMSL,
      Number.isFinite(minObservedContactElev) ? minObservedContactElev - 2 : -depthBelowMSL,
    )
    const vRange = Math.max(gTop - yBotM, 1)
    const MZ = Math.max(16, Math.min(96, Math.round(vRange / 1.2)))
    const dz = vRange / (MZ - 1)
    const idx3 = (i: number, j: number, l: number) => (l * NX + j) * NX + i
    const label = new Int8Array(NX * NX * MZ)    // 미분류 유지 모드
    const labelExt = new Int8Array(NX * NX * MZ) // 연장 모드 (v4)

    // ── 3. 층별 '두께' 제어점 구성 (핀치아웃 처리 핵심) ──────────────────
    ;(self as any).postMessage({ type: "progress", step: "지층 두께 분석 및 2D 보간 중..." })

    const rank: Record<string, number> = {
      soil: 0, weathered_rock: 1, soft_rock: 2, normal_rock: 3, hard_rock: 4, unknown: 5,
    }
    const profiles = boreholes
      .filter((b) => Number.isFinite(b.longitude) && Number.isFinite(b.latitude) && Number.isFinite(b.elevation))
      .map((b) => {
        const segs = (b.strata || [])
          .filter((s: any) => Number.isFinite(s.depth_top) && Number.isFinite(s.depth_bottom) && s.depth_bottom > s.depth_top)
          .map((s: any) => ({
            from: s.depth_top,
            to: s.depth_bottom,
            soilType: s.soil_type,
            type: rank[s.strata_group] !== undefined ? s.strata_group : "unknown",
          }))
          .sort((a: any, b: any) => a.from - b.from)

        // 층별 실측 두께 합산 (협재층도 두께로 병합)
        const thick: Record<StrataKey, number> = {
          soil: 0, weathered_rock: 0, soft_rock: 0, normal_rock: 0, hard_rock: 0,
        }
        const soilDetailThick: Record<string, number> = {}
        let deepestRank = -1
        for (const seg of segs) {
          if (seg.type === "unknown") continue
          thick[seg.type as StrataKey] += seg.to - seg.from
          if (seg.type === "soil") {
            const detail = normalizeSoilDetailName(seg.soilType) ?? "토사"
            soilDetailThick[detail] = (soilDetailThick[detail] ?? 0) + (seg.to - seg.from)
          }
          deepestRank = Math.max(deepestRank, rank[seg.type])
        }
        const drilledDepth = segs.reduce((max: number, seg: any) => Math.max(max, seg.to), 0)
        return {
          x: b.longitude, y: b.latitude, elev: b.elevation, thick, soilDetailThick, deepestRank, segs, drilledDepth,
          warn: Boolean(b.depth_warning), // [v4.2] 이상 심도 의심 (클라이언트 판정)
        }
      })
      .filter((p) => p.segs.length > 0 && p.deepestRank >= 0)

    // [v4.2] 이상 심도 시추공은 두께·연장 제어점에서 제외 (검토 전 안전장치).
    // 표고(지표면 보정)에는 계속 사용한다. PDF 대조로 수정·저장되면 자동 복귀.
    const okProfiles = profiles.filter((p) => !p.warn)
    const skippedDeep = profiles.length - okProfiles.length
    const EXT_EPS = 0.001
    const hasLayerThickness = (p: any, key: StrataKey) => p.thick[key] > EXT_EPS
    const hasExplicitSoilAbsence = (p: any) => {
      if (hasLayerThickness(p, "soil")) return false
      const firstKnown = p.segs.find((seg: any) => seg.type !== "unknown" && seg.to > EXT_EPS)
      return Boolean(firstKnown && firstKnown.from <= EXT_EPS && firstKnown.type !== "soil")
    }
    const layerTopDepth = (p: any, key: StrataKey) => {
      let top = Infinity
      for (const seg of p.segs) {
        if (seg.type === key && seg.from < top) top = seg.from
      }
      return top
    }
    const estimateLayerTopDepth = (p: any, key: StrataKey, present: any[]) => {
      const ownTop = layerTopDepth(p, key)
      if (Number.isFinite(ownTop)) return ownTop
      const nearest = present
        .map((q) => ({
          top: layerTopDepth(q, key),
          d: projection.distanceMeters({ lng: p.x, lat: p.y }, { lng: q.x, lat: q.y }),
        }))
        .filter((q) => Number.isFinite(q.top))
        .sort((a, b) => a.d - b.d)
        .slice(0, 4)
      if (nearest.length === 0) return Infinity
      let sumW = 0
      let sum = 0
      for (const q of nearest) {
        const w = 1 / Math.max(q.d, 0.25)
        sumW += w
        sum += q.top * w
      }
      return sumW > 0 ? sum / sumW : Infinity
    }
    const ABSENCE_DEPTH_MARGIN_M = 0.25
    const isConfirmedAbsent = (p: any, key: StrataKey, present: any[]) => {
      if (hasLayerThickness(p, key)) return false
      if (key === "soil") return hasExplicitSoilAbsence(p)
      const expectedTop = estimateLayerTopDepth(p, key, present)
      if (!Number.isFinite(expectedTop)) return false
      return p.drilledDepth >= expectedTop + ABSENCE_DEPTH_MARGIN_M
    }
    const layerPresentProfiles: Record<StrataKey, any[]> = {
      soil: okProfiles.filter((p) => hasLayerThickness(p, "soil")),
      weathered_rock: okProfiles.filter((p) => hasLayerThickness(p, "weathered_rock")),
      soft_rock: okProfiles.filter((p) => hasLayerThickness(p, "soft_rock")),
      normal_rock: okProfiles.filter((p) => hasLayerThickness(p, "normal_rock")),
      hard_rock: okProfiles.filter((p) => hasLayerThickness(p, "hard_rock")),
    }
    const absenceStats: Record<StrataKey, { confirmed: number; notReached: number }> = {
      soil: { confirmed: 0, notReached: 0 },
      weathered_rock: { confirmed: 0, notReached: 0 },
      soft_rock: { confirmed: 0, notReached: 0 },
      normal_rock: { confirmed: 0, notReached: 0 },
      hard_rock: { confirmed: 0, notReached: 0 },
    }
    for (const key of STRATA_KEYS) {
      for (const p of okProfiles) {
        if (hasLayerThickness(p, key)) continue
        if (isConfirmedAbsent(p, key, layerPresentProfiles[key])) absenceStats[key].confirmed++
        else absenceStats[key].notReached++
      }
    }
    const continuousLayers: Record<StrataKey, boolean> = {
      soil:
        okProfiles.length > 0 &&
        okProfiles.some((p) => hasLayerThickness(p, "soil")) &&
        okProfiles.every((p) => hasLayerThickness(p, "soil") || !hasExplicitSoilAbsence(p)),
      weathered_rock:
        layerPresentProfiles.weathered_rock.length > 0 &&
        okProfiles.every((p) =>
          hasLayerThickness(p, "weathered_rock") ||
          !isConfirmedAbsent(p, "weathered_rock", layerPresentProfiles.weathered_rock),
        ),
      soft_rock:
        layerPresentProfiles.soft_rock.length > 0 &&
        okProfiles.every((p) =>
          hasLayerThickness(p, "soft_rock") ||
          !isConfirmedAbsent(p, "soft_rock", layerPresentProfiles.soft_rock),
        ),
      normal_rock:
        layerPresentProfiles.normal_rock.length > 0 &&
        okProfiles.every((p) =>
          hasLayerThickness(p, "normal_rock") ||
          !isConfirmedAbsent(p, "normal_rock", layerPresentProfiles.normal_rock),
        ),
      hard_rock:
        layerPresentProfiles.hard_rock.length > 0 &&
        okProfiles.every((p) =>
          hasLayerThickness(p, "hard_rock") ||
          !isConfirmedAbsent(p, "hard_rock", layerPresentProfiles.hard_rock),
        ),
    }
    const isContinuousLayer = (key: StrataKey) => continuousLayers[key]

    // 제어점 규칙 — Leapfrog Vein 'Pinch out' 방식 (outside interval 등가):
    //   Leapfrog: 층이 없는 시추공에 'outside' 구간 생성 → 벽면 반전(flip)
    //   → HW/FW 교차(두께<0) → 교차 영역 불리언 제거 = 핀치아웃
    //   (help.seequent.com > Geo > Veins > Pinch Outs)
    //   2.5D 두께장 등가:
    //    · 층 보유 시추공 → 실측 두께 +t (정확보간 → 주상도와 일치)
    //    · 층 부재 시추공 → 음수 더미 −PINCH_STRENGTH × (최근접 보유공 두께)
    //      → 0-등고선(소멸 경계)이 보유공·부재공 '사이'에 형성되어
    //        물방울(렌즈) 경계 보장 + 부재공 너머 리바운드 차단
    //    · max(T,0) 클램프 = Leapfrog의 벽면 교차 영역 제거와 등가
    const PINCH_STRENGTH = 0.75
    const thickPts: Record<StrataKey, GridPoint[]> = {
      soil: [], weathered_rock: [], soft_rock: [], normal_rock: [], hard_rock: [],
    }
    for (const key of STRATA_KEYS) {
      const present = layerPresentProfiles[key]
      if (present.length === 0) continue // 어떤 시추공에도 없는 층 → 두께장 생성 안 함
      for (const p of okProfiles) {
        const t = p.thick[key]
        if (t > EXT_EPS) {
          thickPts[key].push({ x: p.x, y: p.y, z: t })
        } else if (
          key === "soil" ||
          isContinuousLayer(key) ||
          !isConfirmedAbsent(p, key, present)
        ) {
          // 토사는 부재공의 음수 더미를 두께 TPS에 직접 넣지 않는다.
          // 양의 실측 두께만 보간하고, 부재 여부는 아래 로컬 존재 마스크에서
          // 별도로 판정한다. 소수 무토사공이 전역 TPS를 뒤집는 현상을 방지한다.
          continue
        } else {
          // 벽면 반전 등가: 최근접 보유공 두께 기준 음수 더미
          let bestD2 = Infinity
          let refT = 0
          for (const q of present) {
            const d = projection.distanceMeters({ lng: p.x, lat: p.y }, { lng: q.x, lat: q.y })
            const d2 = d * d
            if (d2 < bestD2) { bestD2 = d2; refT = q.thick[key] }
          }
          thickPts[key].push({ x: p.x, y: p.y, z: -PINCH_STRENGTH * refT })
        }
      }
    }

    const gx = terr.gx
    const gy = terr.gy
    const xGrid = Array.from({ length: NX }, (_, j) =>
      Array.from({ length: NX }, (__, i) => projection.lngLatToModel(gx[i], gy[j]).x),
    )
    const zGrid = Array.from({ length: NX }, (_, j) =>
      Array.from({ length: NX }, (__, i) => projection.lngLatToModel(gx[i], gy[j]).z),
    )

    // ── 두께 격자 보간: TPS 정확보간 → [0, 관측최대×2] 클램프 ──────────────
    //  · 음수 클램프  = 핀치아웃 (보유공 주변 물방울 형태 → 부재공 부근 소멸)
    //  · 상한 클램프  = 외삽 폭주 방지 (시추공 영역 밖 TPS 발산 가드)
    //  · 후처리 스무딩 없음: TPS 자체가 C¹ 연속(최소 굽힘 에너지)이라 불필요.
    //    기존 Gaussian 4패스가 시추공 값 이탈의 주범이었음
    // raw(클램프 전, 외곽 음수) 함께 반환: 메쉬 경계의 서브셀 등고선 보간용
    const buildThicknessGrid = (points: GridPoint[], continuous = false): { grid: number[][]; raw: number[][] } => {
      if (points.length === 0 || points.every((p) => p.z <= 0)) {
        return {
          grid: Array.from({ length: NX }, () => Array(NX).fill(0)),
          raw: Array.from({ length: NX }, () => Array(NX).fill(-1)),
        }
      }
      const raw = rbfGrid(points, gx, gy, 1, 1e-8, stabilityStats)
      const floorGrid = continuous ? idwGrid(points.filter((p) => p.z > 0), gx, gy, 1) : null
      const tMax = points.reduce((m, p) => Math.max(m, p.z), 0)
      const minPositive = points.reduce((m, p) => p.z > 0 ? Math.min(m, p.z) : m, Infinity)
      const minContinuousThickness = continuous
        ? Math.max(EXT_EPS * 10, Number.isFinite(minPositive) ? minPositive * 0.1 : EXT_EPS * 10)
        : 0
      const cap = tMax * 2
      return {
        grid: raw.map((row, j) => row.map((v, i) => {
          const interpolatedFloor = floorGrid ? floorGrid[j][i] * 0.1 : minContinuousThickness
          const lower = Math.max(minContinuousThickness, interpolatedFloor)
          return Math.max(continuous ? lower : 0, Math.min(v, cap))
        })),
        raw,
      }
    }

    const thickRes = {
      // 토사 두께장은 항상 양의 실측점 기반 연속장으로 만든 뒤 존재 마스크로
      // 잘라낸다. 두께 보간 자체의 음수 외삽이 토사 부재로 오인되지 않게 한다.
      soil: buildThicknessGrid(thickPts.soil, true),
      weathered_rock: buildThicknessGrid(thickPts.weathered_rock, isContinuousLayer("weathered_rock")),
      soft_rock: buildThicknessGrid(thickPts.soft_rock, isContinuousLayer("soft_rock")),
      normal_rock: buildThicknessGrid(thickPts.normal_rock, isContinuousLayer("normal_rock")),
      hard_rock: buildThicknessGrid(thickPts.hard_rock, isContinuousLayer("hard_rock")),
    }
    const thickGrids: Record<StrataKey, number[][]> = {
      soil: thickRes.soil.grid, weathered_rock: thickRes.weathered_rock.grid,
      soft_rock: thickRes.soft_rock.grid, normal_rock: thickRes.normal_rock.grid,
      hard_rock: thickRes.hard_rock.grid,
    }
    const rawThick: Record<StrataKey, number[][]> = {
      soil: thickRes.soil.raw, weathered_rock: thickRes.weathered_rock.raw,
      soft_rock: thickRes.soft_rock.raw, normal_rock: thickRes.normal_rock.raw,
      hard_rock: thickRes.hard_rock.raw,
    }

    // ── 3b. [v4] 연장 두께장 E_k — 기존 기법의 재귀 적용 (구현계획서 §2.2) ──
    // 최심부 연장: 각 시추공의 최하단 관측 지층이 모델 바닥까지 채우는 것으로
    // 해석한다. 이를 시추공 지점 단위 제어점으로 표현:
    //   · 최심 관측층이 k인 시추공 → E_k = max(0, 층 k 하단 고도 − 모델 바닥)
    //   · 그 외 시추공            → 음수 더미 −EXT_PINCH × 최근접 양수 E_k
    //     (더 깊은 층이 관측된 영역으로 연장이 침범하지 않도록 차단 — 핀치아웃과 동일)
    // 보간·클램프는 관측 두께와 완전히 동일 (TPS λ≈0 + buildThicknessGrid)
    //
    // EXT_PINCH = 0.3 (관측 두께의 0.75보다 약하게): 연장 깊이(G, 수십 m)는
    // 관측 두께(수 m)보다 한 자릿수 크므로, 같은 강도의 음수 더미는 전이폭을
    // 과도하게 좁혀 급경사(≈18 m/m)를 만든다. 0.3으로 완화 시 E장들이 넓게
    // 겹치며 비례 분배가 점진 전환 → 최대 경사 2.8 m/m (수치 실험 tune.mjs)
    const buildLocalPresenceSignedGrid = (key: StrataKey) => {
      const base = rawThick[key]
      const presenceRadiusM = Math.max(80, Math.min(avgSpacing * 1.5, 250))
      const nearestK = 4
      const isSoil = key === "soil"
      const protectRatio = isSoil ? 0.65 : 0.7
      const pinchRatio = isSoil ? 0.35 : 0.5
      const minSigned = 0.1
      const profilesForLayer = okProfiles.map((p) => ({
        x: p.x,
        y: p.y,
        thickness: p.thick[key] || 0,
        confirmedAbsent: isConfirmedAbsent(p, key, layerPresentProfiles[key]),
      }))
      const positiveThicknesses = profilesForLayer
        .map((p) => p.thickness)
        .filter((t) => t > EXT_EPS)
        .sort((a, b) => a - b)
      const fallbackThickness = positiveThicknesses.length
        ? positiveThicknesses[Math.floor(positiveThicknesses.length / 2)]
        : minSigned
      const gridCellM = Math.max(
        1,
        Math.min(lngWidthM / Math.max(NX - 1, 1), latWidthM / Math.max(NX - 1, 1)),
      )
      const soilPresentProfiles = profilesForLayer.filter((p) => p.thickness > EXT_EPS)
      const soilAbsenceZones = isSoil
        ? profilesForLayer
            .filter((p) => p.confirmedAbsent)
            .map((absent) => {
              const nearestPresentM = soilPresentProfiles
                .map((present) => projection.distanceMeters(
                  { lng: absent.x, lat: absent.y },
                  { lng: present.x, lat: present.y },
                ))
                .sort((a, b) => a - b)[0]
              const absenceRadii = soilAbsenceRadii(nearestPresentM, avgSpacing, gridCellM)
              // BH 중심 주변 최소 무토사 영역은 최근접 토사공 거리의 30%.
              // 격자 평활화로 사라지지 않도록 최소 두 셀을 확보하되,
              // 최근접 토사공 거리의 45%를 넘지 않는다.
              const coreRadiusM = absenceRadii.coreRadiusM
              // 토사 복귀 전이구간은 최근접 토사공까지 거리의 절반을 기본으로 한다.
              const transitionRadiusM = absenceRadii.transitionRadiusM
              return { ...absent, coreRadiusM, transitionRadiusM }
            })
        : []
      const stats = {
        radiusM: Math.round(presenceRadiusM),
        absenceZones: soilAbsenceZones.length,
        maxCoreRadiusM: Math.round(
          soilAbsenceZones.reduce((maximum, zone) => Math.max(maximum, zone.coreRadiusM), 0),
        ),
        protected: 0,
        pinched: 0,
        rawNegative: 0,
        finalNegative: 0,
        confirmedAbsent: profilesForLayer.filter((p) => p.confirmedAbsent).length,
        notReachedNeutral: profilesForLayer.filter((p) => p.thickness <= EXT_EPS && !p.confirmedAbsent).length,
      }
      const grid = Array.from({ length: NX }, (_, j) =>
        Array.from({ length: NX }, (__, i) => {
          let signed = base[j][i]
          if (signed <= 0) stats.rawNegative++

          const x = gx[i]
          const y = gy[j]
          const local = profilesForLayer
            .map((p) => ({
              ...p,
              d: projection.distanceMeters({ lng: x, lat: y }, { lng: p.x, lat: p.y }),
            }))
            .sort((a, b) => a.d - b.d)
          const within = local.filter((p) => p.d <= presenceRadiusM)
          const scope = within.length >= 3 ? within : local.slice(0, Math.min(nearestK, local.length))
          const present = scope.filter((p) => p.thickness > EXT_EPS)
          const informative = scope.filter((p) => p.thickness > EXT_EPS || p.confirmedAbsent)
          const presentRatio = informative.length ? present.length / informative.length : 0
          // 토사는 개수 비율보다 거리 가중 존재도를 우선한다. 고립된 무토사공
          // 하나가 멀리 떨어진 다수 토사공보다 넓은 영역을 지배하지 못하게 한다.
          let weightedPresent = 0
          let weightedTotal = 0
          for (const p of informative) {
            const w = 1 / Math.max(p.d * p.d, 1)
            weightedTotal += w
            if (p.thickness > EXT_EPS) weightedPresent += w
          }
          const weightedPresence = weightedTotal > 0 ? weightedPresent / weightedTotal : 1
          const nearest = local.slice(0, Math.min(nearestK, local.length))
          const nearestInformative = nearest.filter((p) => p.thickness > EXT_EPS || p.confirmedAbsent)
          const nearestPresentCount = nearestInformative.filter((p) => p.thickness > EXT_EPS).length
          const nearestPresent = local.find((p) => p.thickness > EXT_EPS)
          const nearestAbsent = local.find((p) => p.confirmedAbsent)
          const localThicknesses = present.map((p) => p.thickness).sort((a, b) => a - b)
          const localThickness = localThicknesses.length
            ? localThicknesses[Math.floor(localThicknesses.length / 2)]
            : fallbackThickness

          if (isSoil) {
            const nearestZone = soilAbsenceZones
              .map((zone) => ({
                ...zone,
                d: projection.distanceMeters({ lng: x, lat: y }, { lng: zone.x, lat: zone.y }),
              }))
              .sort((a, b) => a.d - b.d)[0]
            const onObservedSoil =
              nearestPresent !== undefined && nearestPresent.d <= Math.max(0.1, gridCellM * 0.2)

            if (onObservedSoil) {
              // 실측 토사공은 평활화 전 존재장에서도 확실한 양수 앵커로 유지한다.
              signed = 1
              stats.protected++
            } else if (nearestZone && nearestZone.d <= nearestZone.coreRadiusM) {
              // 무토사공 중심을 포함하는 대칭 -1 코어. 두께 크기와 분리한다.
              signed = -1
              stats.pinched++
            } else if (nearestZone && nearestZone.d <= nearestZone.transitionRadiusM) {
              const width = Math.max(nearestZone.transitionRadiusM - nearestZone.coreRadiusM, 1)
              const t = (nearestZone.d - nearestZone.coreRadiusM) / width
              signed = -1 + 2 * Math.max(0, Math.min(1, t))
              if (signed <= 0) stats.pinched++
              else stats.protected++
            } else {
              // 반경 밖에서는 거리 가중 존재도를 사용하되 고립 부재공의 광역
              // 음수 꼬리는 허용하지 않는다.
              signed = Math.max(2 * weightedPresence - 1, minSigned)
              stats.protected++
            }

            if (signed <= 0) stats.finalNegative++
            return signed
          }

          const presentDominates =
            (informative.length >= 3 && (isSoil ? weightedPresence : presentRatio) >= protectRatio) ||
            (nearestInformative.length >= nearestK && nearestPresentCount === nearestInformative.length) ||
            (nearestPresent !== undefined &&
              nearestPresent.d <= presenceRadiusM * 0.75 &&
              (nearestAbsent === undefined || nearestPresent.d < nearestAbsent.d * 0.75) &&
              nearestPresentCount >= Math.min(3, nearestInformative.length))

          const absentDominates =
            nearestAbsent !== undefined &&
            nearestAbsent.d <= presenceRadiusM &&
            informative.length > 0 &&
            (isSoil ? weightedPresence < pinchRatio : presentRatio < pinchRatio) &&
            (nearestPresent === undefined || nearestAbsent.d < nearestPresent.d * 0.8)

          if (presentDominates) {
            const protectedSigned = Math.max(localThickness * 0.25, minSigned)
            if (signed <= minSigned) stats.protected++
            signed = Math.max(signed, protectedSigned)
          } else if (absentDominates) {
            const pinchedSigned = -Math.max(localThickness * 0.1, minSigned)
            if (signed > pinchedSigned) stats.pinched++
            signed = Math.min(signed, pinchedSigned)
          }

          if (signed <= 0) stats.finalNegative++
          return signed
        }),
      )

      const hardNegativeGrid = Array.from({ length: NX }, (_, j) =>
        Array.from({ length: NX }, (__, i) => {
          if (!isSoil) return 0
          const x = gx[i]
          const y = gy[j]
          return soilAbsenceZones.some((zone) =>
            projection.distanceMeters({ lng: x, lat: y }, { lng: zone.x, lat: zone.y }) <= zone.coreRadiusM
          ) ? 1 : 0
        }),
      )

      return { grid, stats, hardNegativeGrid }
    }

    const soilPresenceSigned = buildLocalPresenceSignedGrid("soil")
    const weatheredPresenceSigned = buildLocalPresenceSignedGrid("weathered_rock")
    // 토사 부재는 렌더링 마스크만으로 처리할 수 없다. 토사 하단은 풍화암
    // 상단과 같은 공유 경계이므로 존재장을 실제 토사 두께에 반영한다.
    // signed <= 0인 영역에서는 두께가 정확히 0이고 공유 경계가 지표와 만난다.
    const soilPresenceWeightGrid = soilPresenceSigned.grid.map((row) =>
      row.map(soilPresenceWeightFromSigned),
    )
    const effectiveSoilThicknessGrid = thickGrids.soil.map((row, j) =>
      row.map((thickness, i) =>
        effectiveSoilThickness(thickness, soilPresenceSigned.grid[j][i]),
      ),
    )
    const cleanDomainSignedGrid = (key: StrataKey, grid: number[][]) => {
      const positive = grid.map((row) => row.map((v) => v > EXT_EPS))
      const outside = Array.from({ length: NX }, () => Array(NX).fill(false))
      const protectedAbsence = Array.from({ length: NX }, () => Array(NX).fill(false))
      const queue: Array<[number, number]> = []
      const pushOutside = (j: number, i: number) => {
        if (j < 0 || i < 0 || j >= NX || i >= NX || outside[j][i] || positive[j][i]) return
        outside[j][i] = true
        queue.push([j, i])
      }

      for (let i = 0; i < NX; i++) {
        pushOutside(0, i)
        pushOutside(NX - 1, i)
      }
      for (let j = 0; j < NX; j++) {
        pushOutside(j, 0)
        pushOutside(j, NX - 1)
      }
      for (let q = 0; q < queue.length; q++) {
        const [j, i] = queue[q]
        pushOutside(j - 1, i)
        pushOutside(j + 1, i)
        pushOutside(j, i - 1)
        pushOutside(j, i + 1)
      }

      for (const p of okProfiles) {
        if (p.thick[key] > EXT_EPS) continue
        if (!isConfirmedAbsent(p, key, layerPresentProfiles[key])) continue
        const i = findAxisIndex(gx, p.x)
        const j = findAxisIndex(gy, p.y)
        if (i >= 0 && j >= 0) protectedAbsence[j][i] = true
      }

      const cleaned = grid.map((row) => row.slice())
      const seen = Array.from({ length: NX }, () => Array(NX).fill(false))
      const stats = { filledHoleCells: 0, protectedHoleCells: 0 }
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]]
      for (let sj = 0; sj < NX; sj++) {
        for (let si = 0; si < NX; si++) {
          if (seen[sj][si] || positive[sj][si] || outside[sj][si]) continue
          const cells: Array<[number, number]> = []
          let hasProtectedAbsence = false
          seen[sj][si] = true
          queue.length = 0
          queue.push([sj, si])
          for (let q = 0; q < queue.length; q++) {
            const [j, i] = queue[q]
            cells.push([j, i])
            if (protectedAbsence[j][i]) hasProtectedAbsence = true
            for (const [dj, di] of dirs) {
              const nj = j + dj
              const ni = i + di
              if (nj < 0 || ni < 0 || nj >= NX || ni >= NX) continue
              if (seen[nj][ni] || positive[nj][ni] || outside[nj][ni]) continue
              seen[nj][ni] = true
              queue.push([nj, ni])
            }
          }
          if (hasProtectedAbsence) {
            stats.protectedHoleCells += cells.length
            continue
          }
          for (const [j, i] of cells) {
            cleaned[j][i] = Math.max(cleaned[j][i], EXT_EPS * 10)
          }
          stats.filledHoleCells += cells.length
        }
      }
      return { grid: cleaned, stats }
    }

    const cleanedDomainSigned = {
      soil: cleanDomainSignedGrid("soil", soilPresenceSigned.grid),
      weathered_rock: cleanDomainSignedGrid("weathered_rock", weatheredPresenceSigned.grid),
      soft_rock: cleanDomainSignedGrid("soft_rock", rawThick.soft_rock),
      normal_rock: cleanDomainSignedGrid("normal_rock", rawThick.normal_rock),
      hard_rock: cleanDomainSignedGrid("hard_rock", rawThick.hard_rock),
    }
    const soilAbsenceCenterChecks = okProfiles
      .filter((p) => isConfirmedAbsent(p, "soil", layerPresentProfiles.soil))
      .map((p) => {
        const i = findAxisIndex(gx, p.x)
        const j = findAxisIndex(gy, p.y)
        const signed = i >= 0 && j >= 0 ? soilPresenceSigned.grid[j][i] : Number.NaN
        return { x: p.x, y: p.y, signed, inside: Number.isFinite(signed) && signed < 0 }
      })

    const EXT_PINCH = 0.3
    const extAnchors = okProfiles
      .map((pr) => {
        const deepestSeg = pr.segs
          .filter((seg: { from: number; to: number; type: string }) => STRATA_KEYS.includes(seg.type as StrataKey))
          .sort((a: { to: number }, b: { to: number }) => b.to - a.to)[0]
        if (!deepestSeg) return null
        const deepest = STRATA_KEYS.indexOf(deepestSeg.type as StrataKey)
        const surfElev = sampleGridBilinear(elevGrid, gx, gy, pr.x, pr.y)
        const remaining = Math.max(0, surfElev - deepestSeg.to - yBotM)
        return { x: pr.x, y: pr.y, deepest, e: remaining }
      })
      .filter((q): q is { x: number; y: number; deepest: number; e: number } => Boolean(q))
    const diagBhByDeepest = [0, 0, 0, 0, 0]
    for (const q of extAnchors) if (q.deepest >= 0 && q.deepest < 5) diagBhByDeepest[q.deepest]++
    const diagExtExcluded = 0
    const extPts: Record<StrataKey, GridPoint[]> = {
      soil: [], weathered_rock: [], soft_rock: [], normal_rock: [], hard_rock: [],
    }
    for (let k = 0; k < STRATA_KEYS.length; k++) {
      const key = STRATA_KEYS[k]
      const present = extAnchors.filter((q) => q.deepest === k && q.e > EXT_EPS)
      if (present.length === 0) continue
      for (const q of extAnchors) {
        if (q.deepest === k && q.e > EXT_EPS) {
          extPts[key].push({ x: q.x, y: q.y, z: q.e })
        } else {
          let bestD2 = Infinity
          let refE = 0
          for (const r of present) {
            const d = projection.distanceMeters({ lng: q.x, lat: q.y }, { lng: r.x, lat: r.y })
            const d2 = d * d
            if (d2 < bestD2) { bestD2 = d2; refE = r.e }
          }
          extPts[key].push({ x: q.x, y: q.y, z: -EXT_PINCH * refE })
        }
      }
    }
    const extRes = {
      soil: buildThicknessGrid(extPts.soil),
      weathered_rock: buildThicknessGrid(extPts.weathered_rock),
      soft_rock: buildThicknessGrid(extPts.soft_rock),
      normal_rock: buildThicknessGrid(extPts.normal_rock),
      hard_rock: buildThicknessGrid(extPts.hard_rock),
    }
    const positiveExtAnchors = extAnchors.filter((q) => q.e > EXT_EPS)
    const extensionWeightCounts = [0, 0, 0, 0, 0]
    let extensionFallbackCount = 0
    const extWeightGrids: Record<StrataKey, number[][]> = {
      soil: Array.from({ length: NX }, () => Array(NX).fill(0)),
      weathered_rock: Array.from({ length: NX }, () => Array(NX).fill(0)),
      soft_rock: Array.from({ length: NX }, () => Array(NX).fill(0)),
      normal_rock: Array.from({ length: NX }, () => Array(NX).fill(0)),
      hard_rock: Array.from({ length: NX }, () => Array(NX).fill(0)),
    }
    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        const weights = STRATA_KEYS.map((key) => Math.max(0, extRes[key].raw[j][i]))
        let sumW = weights.reduce((sum, w) => sum + w, 0)
        if (sumW <= EXT_EPS) {
          weights.fill(0)
          if (positiveExtAnchors.length > 0) {
            for (const q of positiveExtAnchors) {
              const d = projection.distanceMeters({ lng: gx[i], lat: gy[j] }, { lng: q.x, lat: q.y })
              weights[q.deepest] += q.e / Math.max(d * d, 1)
            }
          } else {
            weights[4] = 1
          }
          sumW = weights.reduce((sum, w) => sum + w, 0)
          extensionFallbackCount++
        }
        if (sumW <= EXT_EPS) {
          weights.fill(0)
          weights[4] = 1
          sumW = 1
        }
        let dominant = 0
        let dominantWeight = -Infinity
        for (let k = 0; k < STRATA_KEYS.length; k++) {
          const normalized = weights[k] / sumW
          extWeightGrids[STRATA_KEYS[k]][j][i] = normalized
          if (normalized > dominantWeight) {
            dominantWeight = normalized
            dominant = k
          }
        }
        extensionWeightCounts[dominant]++
      }
    }
    // 연장 모드 메쉬의 경계 보간용 signed장: 관측 + 연장 원시장의 합
    // (τ = t + fill 의 소멸 경계와 부호 전환 위치가 일치)
    // ── 4. 격자별 지층 경계 절대 고도 — 두 모드 동시 계산 (v4) ──────────
    // 두께 ≥ 0이 구조적으로 보장되므로 층 역전·수직 절벽이 발생할 수 없음
    //   · 미분류 유지 모드: 경계면 = 지표면 − Σt, 시추 한계선 아래 = unknown
    //   · 연장 모드: 유효 두께 τ = t + fill. fill = 잔여 깊이 G(시추 한계면 −
    //     모델 바닥)를 연장 가중치 E_k 비례 분배 → Σfill = G 로 최하 경계가
    //     정확히 모델 바닥(워터타이트). 모든 장이 연속 함수라 절벽 불가,
    //     최심층 전이부는 교차 테이퍼(인터핑거링)로 이어짐 (구현계획서 §2.3)
    ;(self as any).postMessage({ type: "progress", step: "지층 경계면 고도 격자 계산 중..." })

    const mkGrid = () => Array.from({ length: NX }, () => Array(NX).fill(0))
    const soilBottomGrid = mkGrid(), weatheredBottomGrid = mkGrid(), softBottomGrid = mkGrid()
    const normalBottomGrid = mkGrid(), hardBottomGrid = mkGrid(), boreholeBottomGrid = mkGrid()
    const soilBottomExt = mkGrid(), weatheredBottomExt = mkGrid(), softBottomExt = mkGrid()
    const normalBottomExt = mkGrid(), hardBottomExt = mkGrid()
    const rawGGrid = mkGrid() // 미분류 두께(클램프 전) — wedge 경계 보간용

    // [진단] 연장 모드 거동 추적용 누적기
    let diagSumWZero = 0                       // sumW≈0(폴백 발동) 셀 수
    const diagBottomFill = [0, 0, 0, 0, 0]     // 모델 바닥을 점유한 지층 분포(τ>0 최하층)

    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        const surfElev = elevGrid[j][i]
        const tArr = STRATA_KEYS.map((key) =>
          key === "soil" ? effectiveSoilThicknessGrid[j][i] : thickGrids[key][j][i],
        )

        // ── 미분류 유지 모드 경계면 ──
        // [v4.2] 모델 바닥(yBot) 클램프: 두께 합이 슬리브 깊이를 초과해도
        // 경계면이 바닥을 관통하지 못하게 차단. max()는 단조 비증가 순서를
        // 보존하므로 층 역전이 생기지 않고, 잘린 단면은 바닥 평면과 일치한다.
        const soilB      = Math.max(surfElev - tArr[0], yBotM)
        const weatheredB = Math.max(soilB - tArr[1], yBotM)
        const softB      = Math.max(weatheredB - tArr[2], yBotM)
        const normalB    = Math.max(softB - tArr[3], yBotM)
        const hardB      = Math.max(normalB - tArr[4], yBotM)
        const boreholeB  = hardB
        soilBottomGrid[j][i] = soilB
        weatheredBottomGrid[j][i] = weatheredB
        softBottomGrid[j][i] = softB
        normalBottomGrid[j][i] = normalB
        hardBottomGrid[j][i] = hardB
        boreholeBottomGrid[j][i] = boreholeB

        // ── 연장 모드 ──
        // 각 시추공의 최하단 관측 지층을 모델 바닥까지 연장한다.
        // 관측 접촉면은 유지하고, 최하단 아래의 미시추 구간만 해석 연장분으로 더한다.
        rawGGrid[j][i] = boreholeB - yBotM
        const soilExtB = soilB
        const weatheredExtB = weatheredB
        const softExtB = softB
        const normalExtB = normalB
        const hardExtB = hardB
        const bExt: number[] = [soilExtB, weatheredExtB, softExtB, normalExtB, hardExtB]
        soilBottomExt[j][i] = bExt[0]
        weatheredBottomExt[j][i] = bExt[1]
        softBottomExt[j][i] = bExt[2]
        normalBottomExt[j][i] = bExt[3]
        hardBottomExt[j][i] = bExt[4]

        // 연장 모드에서 τ>0인 최하층 (모델 바닥 복셀 귀속용)
        let deepTau = 0
        let prevB = surfElev
        for (let k = 0; k < 5; k++) {
          if (prevB - bExt[k] > 1e-9) deepTau = k
          prevB = bExt[k]
        }
        diagBottomFill[deepTau]++ // [진단] 모델 바닥 점유 지층 분포

        // 복셀 라벨 (두 모드)
        for (let l = 0; l < MZ; l++) {
          const elev = yBotM + dz * l
          const index = idx3(i, j, l)
          if      (elev > surfElev)   label[index] = 0 // air
          else if (elev > soilB)      label[index] = 1
          else if (elev > weatheredB) label[index] = 2
          else if (elev > softB)      label[index] = 3
          else if (elev > normalB)    label[index] = 4
          else if (elev > hardB)      label[index] = 5
          else                        label[index] = 6 // unknown

          if (elev > surfElev) {
            labelExt[index] = 0
          } else {
            let codeE = deepTau + 1
            for (let k = 0; k < 5; k++) {
              if (elev > bExt[k]) { codeE = k + 1; break }
            }
            labelExt[index] = codeE
          }
        }
      }
    }

    // ── 5. 스무드 모드: 수밀 솔리드 지층 메쉬 빌드 ────────────────────────
    // 두께 0 영역은 top==bottom 퇴화 → buildLayerSolidGeometryData가
    // 두께 임계(0.001m) 미만 셀의 인덱스를 생략하므로 렌즈 가장자리가 자연 소멸
    const observedBottomGrids: Record<StrataKey, number[][]> = {
      soil: soilBottomGrid,
      weathered_rock: weatheredBottomGrid,
      soft_rock: softBottomGrid,
      normal_rock: normalBottomGrid,
      hard_rock: hardBottomGrid,
    }
    const boundaryTargets = buildBoundaryTargets(okProfiles, elevGrid, gx, gy)
    const boundarySnapRadiusM = Math.max(60, Math.min(avgSpacing * 1.2, confRadiusM))
    snapBoundariesToBoreholes(
      observedBottomGrids,
      elevGrid,
      gx,
      gy,
      boundaryTargets,
      boundarySnapRadiusM,
      yBotM,
      stabilityStats,
    )

    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        boreholeBottomGrid[j][i] = hardBottomGrid[j][i]
        rawGGrid[j][i] = boreholeBottomGrid[j][i] - yBotM

        const surfElev = elevGrid[j][i]
        const observedThickness = [
          Math.max(0, surfElev - soilBottomGrid[j][i]),
          Math.max(0, soilBottomGrid[j][i] - weatheredBottomGrid[j][i]),
          Math.max(0, weatheredBottomGrid[j][i] - softBottomGrid[j][i]),
          Math.max(0, softBottomGrid[j][i] - normalBottomGrid[j][i]),
          Math.max(0, normalBottomGrid[j][i] - hardBottomGrid[j][i]),
        ]
        const remainingDepth = Math.max(0, hardBottomGrid[j][i] - yBotM)
        const extendedThickness = STRATA_KEYS.map((key, k) =>
          observedThickness[k] + remainingDepth * extWeightGrids[key][j][i],
        )
        const soilExtB = Math.max(surfElev - extendedThickness[0], yBotM)
        const weatheredExtB = Math.max(soilExtB - extendedThickness[1], yBotM)
        const softExtB = Math.max(weatheredExtB - extendedThickness[2], yBotM)
        const normalExtB = Math.max(softExtB - extendedThickness[3], yBotM)
        const hardExtB = yBotM
        soilBottomExt[j][i] = soilExtB
        weatheredBottomExt[j][i] = weatheredExtB
        softBottomExt[j][i] = softExtB
        normalBottomExt[j][i] = normalExtB
        hardBottomExt[j][i] = hardExtB
      }
    }

    label.fill(0)
    labelExt.fill(0)
    diagBottomFill.fill(0)

    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        const surfElev = elevGrid[j][i]
        const soilB = soilBottomGrid[j][i]
        const weatheredB = weatheredBottomGrid[j][i]
        const softB = softBottomGrid[j][i]
        const normalB = normalBottomGrid[j][i]
        const hardB = hardBottomGrid[j][i]
        const soilExtB = soilBottomExt[j][i]
        const weatheredExtB = weatheredBottomExt[j][i]
        const softExtB = softBottomExt[j][i]
        const normalExtB = normalBottomExt[j][i]
        const hardExtB = hardBottomExt[j][i]
        for (let l = 0; l < MZ; l++) {
          const elev = yBotM + dz * l
          const index = idx3(i, j, l)
          if      (elev > surfElev)   label[index] = 0
          else if (elev > soilB)      label[index] = 1
          else if (elev > weatheredB) label[index] = 2
          else if (elev > softB)      label[index] = 3
          else if (elev > normalB)    label[index] = 4
          else if (elev > hardB)      label[index] = 5
          else                        label[index] = 6

          if      (elev > surfElev)       labelExt[index] = 0
          else if (elev > soilExtB)       labelExt[index] = 1
          else if (elev > weatheredExtB)  labelExt[index] = 2
          else if (elev > softExtB)       labelExt[index] = 3
          else if (elev > normalExtB)     labelExt[index] = 4
          else if (elev >= hardExtB)      labelExt[index] = 5
          else                            labelExt[index] = 0
        }
      }
    }

    const boundarySnapDiag = boundarySnapDiagnostics(observedBottomGrids, gx, gy, boundaryTargets)
    if (boundarySnapDiag.maxAbsErrorRaw > CONTACT_TOLERANCE_M) {
      console.warn(
        `[geoWorker] borehole contact hard constraint residual retained: max=${boundarySnapDiag.maxAbsErrorRaw.toFixed(6)}m`,
        boundarySnapDiag,
      )
    }

    ;(self as any).postMessage({ type: "progress", step: "수밀 지층 메쉬 생성 중..." })
    const shouldBuildSmooth = renderMode === "smooth"
    const shouldBuildVoxel = renderMode === "voxel"
    const smoothMeshData: Record<string, { positions: Float32Array; indices: Uint32Array }> = {}
    const putMeshData = (name: string, mesh: { positions: number[]; indices: number[] }) => {
      const existing = smoothMeshData[name]
      if (!existing) {
        smoothMeshData[name] = {
          positions: new Float32Array(mesh.positions),
          indices: new Uint32Array(mesh.indices),
        }
        return
      }
      const vertexOffset = existing.positions.length / 3
      const positions = new Float32Array(existing.positions.length + mesh.positions.length)
      positions.set(existing.positions, 0)
      positions.set(mesh.positions, existing.positions.length)
      const indices = new Uint32Array(existing.indices.length + mesh.indices.length)
      indices.set(existing.indices, 0)
      for (let n = 0; n < mesh.indices.length; n++) {
        indices[existing.indices.length + n] = mesh.indices[n] + vertexOffset
      }
      smoothMeshData[name] = { positions, indices }
    }

    const flatBottomGrid = Array.from({ length: NX }, () => Array(NX).fill(yBotM))
    let minRemainingDepth = Infinity
    let maxRemainingDepth = 0
    diagBottomFill.fill(0)
    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        const remainingDepth = Math.max(0, boreholeBottomGrid[j][i] - yBotM)
        minRemainingDepth = Math.min(minRemainingDepth, remainingDepth)
        maxRemainingDepth = Math.max(maxRemainingDepth, remainingDepth)
        let dominant = 0
        let dominantWeight = -Infinity
        for (let k = 0; k < STRATA_KEYS.length; k++) {
          const w = extWeightGrids[STRATA_KEYS[k]][j][i]
          if (w > dominantWeight) {
            dominantWeight = w
            dominant = k
          }
        }
        diagBottomFill[dominant]++
      }
    }
    const observedSignedFor = (key: StrataKey) =>
      isContinuousLayer(key) ? null : cleanedDomainSigned[key].grid
    // 연장 모드는 미시추 하부를 각 시추공 최하단 지층으로 채우는 해석 모드다.
    // 지층별 signed carving을 적용하면 최하단 연장 영역의 도메인 경계가 수직 벽처럼 드러나므로,
    // 연장 메쉬는 누적 경계면(top/bottom)만으로 생성한다.
    const extSignedFor = (_key: StrataKey) => null

    const presentSoilDetails = includeSoilDetails
      ? SOIL_DETAIL_ORDER.filter((detail) =>
          detail !== "토사" &&
          okProfiles.some((p: any) => (p.soilDetailThick?.[detail] ?? 0) > EXT_EPS),
        )
      : []
    const shouldBuildSoilDetailLayers = includeSoilDetails && okProfiles.some((p: any) => p.thick.soil > EXT_EPS)
    type SoilDetailSurfaceInputs = {
      detail: string
      orderSum: number
      orderCount: number
      bottomPoints: GridPoint[]
      thicknessPoints: GridPoint[]
      snapBottomByNode: Map<string, { i: number; j: number; sum: number; count: number }>
    }
    const SOIL_DETAIL_MIN_THICKNESS_M = 0.05
    const buildSoilDetailSurfaceInputs = () => {
      const inputs: Record<string, SoilDetailSurfaceInputs> = {}
      const ensure = (key: string, detail: string) => {
        if (!inputs[key]) inputs[key] = { detail, orderSum: 0, orderCount: 0, bottomPoints: [], thicknessPoints: [], snapBottomByNode: new Map() }
        return inputs[key]
      }
      const addSnapBottom = (occurrenceKey: string, detail: string, p: any, z: number) => {
        const i = findAxisIndex(gx, p.x)
        const j = findAxisIndex(gy, p.y)
        if (i < 0 || j < 0) return
        const nodeKey = `${i}:${j}`
        const input = ensure(occurrenceKey, detail)
        const existing = input.snapBottomByNode.get(nodeKey)
        if (existing) {
          existing.sum += z
          existing.count += 1
        } else {
          input.snapBottomByNode.set(nodeKey, { i, j, sum: z, count: 1 })
        }
      }
      const profilesWithSoil = okProfiles.filter((p: any) => p.thick.soil > EXT_EPS)
      const profileOccurrenceThicknesses: { p: any; thickness: Record<string, number> }[] = []
      for (const p of profilesWithSoil) {
        const surfElev = sampleGridBilinear(elevGrid, gx, gy, p.x, p.y)
        const occurrenceThickness: Record<string, number> = {}
        const occurrenceCount: Record<string, number> = {}
        let soilSegmentIndex = 0
        for (const seg of p.segs) {
          if (seg.type !== "soil") continue
          const detail = normalizeSoilDetailName(seg.soilType) ?? "토사"
          if (detail === "토사") continue
          const thickness = Math.max(0, seg.to - seg.from)
          if (thickness <= EXT_EPS) continue
          const occurrence = (occurrenceCount[detail] ?? 0) + 1
          occurrenceCount[detail] = occurrence
          const key = `${detail}#${occurrence}`
          const input = ensure(key, detail)
          input.orderSum += soilSegmentIndex
          input.orderCount += 1
          occurrenceThickness[key] = (occurrenceThickness[key] ?? 0) + thickness
          input.bottomPoints.push({
            x: p.x,
            y: p.y,
            z: surfElev - seg.to,
          })
          addSnapBottom(key, detail, p, surfElev - seg.to)
          soilSegmentIndex += 1
        }
        profileOccurrenceThicknesses.push({ p, thickness: occurrenceThickness })
      }
      for (const { p, thickness } of profileOccurrenceThicknesses) {
        for (const [key, input] of Object.entries(inputs)) {
          input.thicknessPoints.push({
            x: p.x,
            y: p.y,
            z: Math.max(0, thickness[key] ?? 0),
          })
        }
      }
      return inputs
    }

    const soilDetailSurfaceInputs = buildSoilDetailSurfaceInputs()
    const observedOccurrenceSequences: string[][] = []
    for (const p of okProfiles) {
      const occurrenceCount: Record<string, number> = {}
      const sequence: string[] = []
      for (const seg of p.segs) {
        if (seg.type !== "soil") continue
        const detail = normalizeSoilDetailName(seg.soilType) ?? SOIL_DETAIL_ORDER[0]
        if (detail === SOIL_DETAIL_ORDER[0]) continue
        const occurrence = (occurrenceCount[detail] ?? 0) + 1
        occurrenceCount[detail] = occurrence
        sequence.push(`${detail}#${occurrence}`)
      }
      if (sequence.length > 0) observedOccurrenceSequences.push(sequence)
    }
    const soilDetailOccurrenceKeys = orderSoilDetailOccurrences(
      Object.entries(soilDetailSurfaceInputs).map(([key, input]) => ({
        key,
        detail: input.detail,
        observedMeanOrder: input.orderSum / Math.max(1, input.orderCount),
      })),
      observedOccurrenceSequences,
      SOIL_DETAIL_ORDER,
    )
    const sequenceCounts = new Map<string, number>()
    for (const p of okProfiles) {
      const sequence: string[] = []
      for (const seg of p.segs) {
        if (seg.type !== "soil") continue
        const detail = normalizeSoilDetailName(seg.soilType) ?? "토사"
        if (sequence[sequence.length - 1] !== detail) sequence.push(detail)
      }
      if (sequence.length === 0) continue
      const key = sequence.join(">")
      sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1)
    }
    if (sequenceCounts.size > 1) {
      const topSequences = [...sequenceCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sequence, count]) => `${sequence} (${count})`)
      console.info("[geoWorker] soil detail sequence variants", topSequences)
    }
    const buildSoilDetailLayerPairs = (
      topSurfaceGrid: number[][],
      soilBottom: number[][],
      suffix = "",
    ): [string, number[][], number[][], number[][] | null][] => {
      if (!shouldBuildSoilDetailLayers) return []
      const pairs: [string, number[][], number[][], number[][] | null][] = []
      let currentTop = topSurfaceGrid.map((row) => row.slice())
      const activeInputs = soilDetailOccurrenceKeys
        .map((key) => [key, soilDetailSurfaceInputs[key]] as const)
        .filter(([, input]) => input && input.bottomPoints.length > 0 && input.thicknessPoints.length > 0)
      const rawThicknessByKey: Record<string, number[][]> = {}
      for (const [occurrenceKey, input] of activeInputs) {
        rawThicknessByKey[occurrenceKey] = idwGrid(input.thicknessPoints, gx, gy, 2)
      }
      const rawThicknessTotal = topSurfaceGrid.map((row, j) =>
        row.map((_, i) =>
          activeInputs.reduce((sum, [occurrenceKey]) => sum + Math.max(0, rawThicknessByKey[occurrenceKey][j][i]), 0),
        ),
      )
      for (let layerIndex = 0; layerIndex < activeInputs.length; layerIndex += 1) {
        const [occurrenceKey, input] = activeInputs[layerIndex]
        const rawBottom = idwGrid(input.bottomPoints, gx, gy, 2)
        const rawThickness = rawThicknessByKey[occurrenceKey]
        const bottom = currentTop.map((row, j) =>
          row.map((top, i) => {
            const soilBase = soilBottom[j][i]
            if (top - soilBase <= SOIL_DETAIL_MIN_THICKNESS_M) return top
            const totalRawThickness = rawThicknessTotal[j][i]
            const availableThickness = Math.max(0, topSurfaceGrid[j][i] - soilBase)
            const thickness = totalRawThickness > SOIL_DETAIL_MIN_THICKNESS_M
              ? Math.max(0, rawThickness[j][i]) / totalRawThickness * availableThickness
              : Math.max(0, rawThickness[j][i])
            if (thickness < SOIL_DETAIL_MIN_THICKNESS_M) return top
            const thicknessLimitedBottom = top - thickness
            const contactBottom = rawBottom[j][i]
            const candidate = Math.max(contactBottom, thicknessLimitedBottom)
            return Math.max(soilBase, Math.min(top - SOIL_DETAIL_MIN_THICKNESS_M, candidate))
          }),
        )
        for (const snap of input.snapBottomByNode.values()) {
          const top = currentTop[snap.j]?.[snap.i]
          const soilBase = soilBottom[snap.j]?.[snap.i]
          if (!Number.isFinite(top) || !Number.isFinite(soilBase)) continue
          const snapped = snap.sum / Math.max(1, snap.count)
          bottom[snap.j][snap.i] = Math.max(
            soilBase,
            Math.min(top - SOIL_DETAIL_MIN_THICKNESS_M, snapped),
          )
        }
        const hasThickness = bottom.some((row, j) =>
          row.some((bot, i) => currentTop[j][i] - bot >= SOIL_DETAIL_MIN_THICKNESS_M),
        )
        if (!hasThickness) continue
        pairs.push([`soil_detail:${occurrenceKey}${suffix}`, currentTop, bottom, null])
        currentTop = bottom
      }
      const fallbackBottom = unclassifiedSoilBottom(currentTop, soilBottom, SOIL_DETAIL_MIN_THICKNESS_M)
      const hasFallbackThickness = fallbackBottom.some((row, j) =>
        row.some((bottom, i) => currentTop[j][i] - bottom >= SOIL_DETAIL_MIN_THICKNESS_M),
      )
      if (hasFallbackThickness) {
        pairs.push([`soil_detail:${SOIL_DETAIL_ORDER[0]}${suffix}`, currentTop, fallbackBottom, null])
      }
      return pairs
    }

    const observedSoilDetailPairs = buildSoilDetailLayerPairs(elevGrid, soilBottomGrid)
    const extendedSoilDetailPairs = buildSoilDetailLayerPairs(elevGrid, soilBottomExt, "@ext")

    const layerPairs: [string, number[][], number[][], number[][] | null][] = [
      ["soil",           elevGrid,            soilBottomGrid,      observedSignedFor("soil")],
      ["weathered_rock", soilBottomGrid,      weatheredBottomGrid, observedSignedFor("weathered_rock")],
      ["soft_rock",      weatheredBottomGrid, softBottomGrid,      observedSignedFor("soft_rock")],
      ["normal_rock",    softBottomGrid,      normalBottomGrid,    observedSignedFor("normal_rock")],
      ["hard_rock",      normalBottomGrid,    hardBottomGrid,      observedSignedFor("hard_rock")],
      ["unknown",        boreholeBottomGrid,  flatBottomGrid,      rawGGrid],
    ]
    if (shouldBuildSmooth) {
      for (const [name, topGrid, bottomGrid, signed] of layerPairs) {
        const hardNegativeGrid = name === "soil" ? soilPresenceSigned.hardNegativeGrid : null
        const mesh = buildLayerSolidGeometryData(
          topGrid,
          bottomGrid,
          boxW,
          boxD,
          mScale,
          signed,
          xGrid,
          zGrid,
          hardNegativeGrid,
        )
        putMeshData(name, mesh)
      }
      for (const [name, topGrid, bottomGrid, signed] of observedSoilDetailPairs) {
        const mesh = buildLayerSolidGeometryData(topGrid, bottomGrid, boxW, boxD, mScale, signed, xGrid, zGrid)
        putMeshData(name, mesh)
      }
    }

    // ── 5b. [v4] 연장 모드 메쉬 — 동일 지층 단일 솔리드 (키: "<layer>@ext") ──
    // 연장분이 유효 두께 τ에 흡수되어 있으므로 관측+연장이 한 덩어리이며,
    // 색·재질도 관측 메쉬와 동일하게 렌더링된다 (뷰어에서 "@ext" → 원본 색 매핑)
    const layerPairsExt: [string, number[][], number[][], number[][] | null][] = [
      ["soil@ext",           elevGrid,            soilBottomExt,      extSignedFor("soil")],
      ["weathered_rock@ext", soilBottomExt,       weatheredBottomExt, extSignedFor("weathered_rock")],
      ["soft_rock@ext",      weatheredBottomExt,  softBottomExt,      extSignedFor("soft_rock")],
      ["normal_rock@ext",    softBottomExt,       normalBottomExt,    extSignedFor("normal_rock")],
      ["hard_rock@ext",      normalBottomExt,     hardBottomExt,      extSignedFor("hard_rock")],
    ]
    if (shouldBuildSmooth) {
      for (const [name, topGrid, bottomGrid, signed] of layerPairsExt) {
        const mesh = buildLayerSolidGeometryData(topGrid, bottomGrid, boxW, boxD, mScale, signed, xGrid, zGrid)
        putMeshData(name, mesh)
      }
      for (const [name, topGrid, bottomGrid, signed] of extendedSoilDetailPairs) {
        const mesh = buildLayerSolidGeometryData(topGrid, bottomGrid, boxW, boxD, mScale, signed, xGrid, zGrid)
        putMeshData(name, mesh)
      }
    }
    // ── 6. 복셀 셀 (voxel 모드 — RLE 압축) ───────────────────────────────
    const cellW = boxW / (NX - 1)
    const cellD = boxD / (NX - 1)
    const voxelCells: Record<string, VoxelCell[]> = {
      soil: [], weathered_rock: [], soft_rock: [], normal_rock: [], hard_rock: [], unknown: [],
    }
    if (shouldBuildVoxel) {
      for (let j = 0; j < NX; j++) {
        for (let i = 0; i < NX; i++) {
          const cx = -boxW / 2 + (boxW * i) / (NX - 1)
          const cz = boxD / 2 - (boxD * j) / (NX - 1)
          let l = 0
          while (l < MZ) {
            const code = label[idx3(i, j, l)]
            if (code === 0) { l++; continue }
            let l2 = l
            while (l2 < MZ && label[idx3(i, j, l2)] === code) l2++
            voxelCells[LAYER_STACK[code - 1]].push({
              x0: cx - cellW / 2, x1: cx + cellW / 2,
              z0: cz - cellD / 2, z1: cz + cellD / 2,
              yBot: (yBotM + dz * (l - 0.5)) * mScale,
              yTop: (yBotM + dz * (l2 - 0.5)) * mScale,
            })
            l = l2
          }
        }
      }
    }

    const pushDetailVoxelCells = (pairs: [string, number[][], number[][], number[][] | null][]) => {
      for (const [name, topGrid, bottomGrid] of pairs) {
        if (!voxelCells[name]) voxelCells[name] = []
        for (let j = 0; j < NX; j++) {
          for (let i = 0; i < NX; i++) {
            const yTop = topGrid[j][i] * mScale
            const yBot = bottomGrid[j][i] * mScale
            if (yTop - yBot < 1e-5) continue
            const cx = -boxW / 2 + (boxW * i) / (NX - 1)
            const cz = boxD / 2 - (boxD * j) / (NX - 1)
            voxelCells[name].push({
              x0: cx - cellW / 2, x1: cx + cellW / 2,
              z0: cz - cellD / 2, z1: cz + cellD / 2,
              yBot,
              yTop,
            })
          }
        }
      }
    }
    if (shouldBuildVoxel) {
      pushDetailVoxelCells(observedSoilDetailPairs)
      pushDetailVoxelCells(extendedSoilDetailPairs)
    }

    // [v4] 연장 모드 복셀 (labelExt RLE → "<layer>@ext" 키)
    if (shouldBuildVoxel) {
      for (let j = 0; j < NX; j++) {
        for (let i = 0; i < NX; i++) {
          const cx = -boxW / 2 + (boxW * i) / (NX - 1)
          const cz = boxD / 2 - (boxD * j) / (NX - 1)
          let l = 0
          while (l < MZ) {
            const code = labelExt[idx3(i, j, l)]
            if (code === 0) { l++; continue }
            let l2 = l
            while (l2 < MZ && labelExt[idx3(i, j, l2)] === code) l2++
            const extKey = `${LAYER_STACK[code - 1]}@ext`
            if (!voxelCells[extKey]) voxelCells[extKey] = []
            voxelCells[extKey].push({
              x0: cx - cellW / 2, x1: cx + cellW / 2,
              z0: cz - cellD / 2, z1: cz + cellD / 2,
              yBot: (yBotM + dz * (l - 0.5)) * mScale,
              yTop: (yBotM + dz * (l2 - 0.5)) * mScale,
            })
            l = l2
          }
        }
      }
    }

    const transferBuffers: ArrayBuffer[] = []
    for (const type of Object.keys(smoothMeshData)) {
      transferBuffers.push(smoothMeshData[type].positions.buffer as ArrayBuffer)
      transferBuffers.push(smoothMeshData[type].indices.buffer as ArrayBuffer)
    }

    // [진단] 연장 경계면 최대 인접-셀 경사(m/m)와 발생 지층
    const dxM = lngWidthM / (NX - 1), dyM = latWidthM / (NX - 1)
    const extBottoms = [soilBottomExt, weatheredBottomExt, softBottomExt, normalBottomExt, hardBottomExt]
    let diagMaxSlope = 0, diagMaxSlopeLayer = -1
    for (let k = 0; k < 5; k++) {
      const g = extBottoms[k]
      for (let j = 0; j < NX; j++) for (let i = 0; i < NX; i++) {
        if (i + 1 < NX) { const s = Math.abs(g[j][i + 1] - g[j][i]) / dxM; if (s > diagMaxSlope) { diagMaxSlope = s; diagMaxSlopeLayer = k } }
        if (j + 1 < NX) { const s = Math.abs(g[j + 1][i] - g[j][i]) / dyM; if (s > diagMaxSlope) { diagMaxSlope = s; diagMaxSlopeLayer = k } }
      }
    }
    const nCells = NX * NX
    const signedStats = (grid: number[][]) => {
      let min = Infinity
      let max = -Infinity
      let negative = 0
      for (const row of grid) {
        for (const v of row) {
          if (v < min) min = v
          if (v > max) max = v
          if (v <= EXT_EPS) negative++
        }
      }
      return { min, max, negative }
    }
    const diag = {
      bhByDeepest: diagBhByDeepest,          // [soil,weath,soft,normal,hard] 최심관측층 공 수
      extExcluded: diagExtExcluded,
      bottomFill: diagBottomFill,            // 모델 바닥 점유 지층 분포(셀 수)
      extensionMode: "continuous-weighted-stack",
      extensionDominant: extensionWeightCounts,
      extensionFallback: extensionFallbackCount,
      remainingDepth: {
        min: Math.round(minRemainingDepth * 1000) / 1000,
        max: Math.round(maxRemainingDepth * 1000) / 1000,
      },
      maxSlope: Math.round(diagMaxSlope * 10) / 10,
      maxSlopeLayer: diagMaxSlopeLayer,      // 0=soil..4=hard
      boundarySnap: boundarySnapDiag,
      continuousLayers,
      absenceClassification: absenceStats,
      soilSigned: signedStats(rawThick.soil),
      soilPresenceWeight: signedStats(soilPresenceWeightGrid),
      effectiveSoilThickness: signedStats(effectiveSoilThicknessGrid),
      domainClean: {
        soil: cleanedDomainSigned.soil.stats,
        weathered_rock: cleanedDomainSigned.weathered_rock.stats,
        soft_rock: cleanedDomainSigned.soft_rock.stats,
        normal_rock: cleanedDomainSigned.normal_rock.stats,
        hard_rock: cleanedDomainSigned.hard_rock.stats,
      },
      weatheredPresence: weatheredPresenceSigned.stats,
      soilPresence: soilPresenceSigned.stats,
      soilAbsenceCenters: soilAbsenceCenterChecks,
      interpolationStability: {
        input: {
          ...inputConstraintStability,
          minSeparationM: inputConstraintStability.minSeparationM === null
            ? null
            : Math.round(inputConstraintStability.minSeparationM * 1000) / 1000,
        },
        ...stabilityStats,
        mode: stabilityStats.rbfIdwFallbacks > 0 || stabilityStats.snapNodeFallbacks > 0
          ? "stable-fallback"
          : "rbf",
      },
    }
    try { console.warn("[geoWorker diag]", JSON.stringify(diag)) } catch {}

    ;(self as any).postMessage(
      {
        type: "done",
        elevGrid,
        gx,
        gy,
        smoothMeshData,
        voxelCells,
        dz, yBotM, gTop, MZ, confRadiusM, lngWidthM, latWidthM,
        skippedDeep, // [v4.2] 이상 심도로 제어점에서 제외된 시추공 수
        diag,        // [진단] 연장 모드 거동 지표
      },
      transferBuffers,
    )
  } catch (err: any) {
    ;(self as any).postMessage({ type: "error", error: err?.message || String(err) })
  }
}
