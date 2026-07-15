export interface SpatialConstraint {
  x: number
  y: number
  z: number
}

export interface ConstraintStabilityAssessment {
  pointCount: number
  minSeparationM: number | null
  exactPairCount: number
  nearPairCount: number
  conflictingNearPairCount: number
  conflictingExactPairCount: number
  requiresStableFallback: boolean
}

const M_PER_DEG_LAT = 110540
const mPerDegLng = (cosLat: number) => 111320 * cosLat

export function analyzeConstraintStability(
  points: SpatialConstraint[],
  nearDistanceM = 0.5,
  valueTolerance = 1e-4,
): ConstraintStabilityAssessment {
  const valid = points.filter((point) =>
    Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
  )
  if (valid.length < 2) {
    return {
      pointCount: valid.length,
      minSeparationM: null,
      exactPairCount: 0,
      nearPairCount: 0,
      conflictingNearPairCount: 0,
      conflictingExactPairCount: 0,
      requiresStableFallback: false,
    }
  }

  const midLat = valid.reduce((sum, point) => sum + point.y, 0) / valid.length
  const cosLat = Math.cos((midLat * Math.PI) / 180)
  let minSeparationM = Number.POSITIVE_INFINITY
  let exactPairCount = 0
  let nearPairCount = 0
  let conflictingNearPairCount = 0
  let conflictingExactPairCount = 0

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const dxM = (valid[i].x - valid[j].x) * mPerDegLng(cosLat)
      const dyM = (valid[i].y - valid[j].y) * M_PER_DEG_LAT
      const distanceM = Math.hypot(dxM, dyM)
      minSeparationM = Math.min(minSeparationM, distanceM)
      const sameCoordinate = valid[i].x === valid[j].x && valid[i].y === valid[j].y
      const conflicting = Math.abs(valid[i].z - valid[j].z) > valueTolerance
      if (sameCoordinate) {
        exactPairCount++
        if (conflicting) conflictingExactPairCount++
      }
      if (distanceM <= nearDistanceM) {
        nearPairCount++
        if (conflicting) conflictingNearPairCount++
      }
    }
  }

  return {
    pointCount: valid.length,
    minSeparationM: Number.isFinite(minSeparationM) ? minSeparationM : null,
    exactPairCount,
    nearPairCount,
    conflictingNearPairCount,
    conflictingExactPairCount,
    requiresStableFallback: nearPairCount > 0,
  }
}

const findAxisIndex = (axis: number[], value: number) => {
  if (axis.length === 0) return -1
  const span = Math.max(Math.abs(axis[axis.length - 1] - axis[0]), 1)
  const epsilon = span * 1e-10
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < axis.length; index++) {
    const distance = Math.abs(axis[index] - value)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return bestDistance <= epsilon ? best : -1
}

export function applyConstraintsAtGridNodes(
  grid: number[][],
  gx: number[],
  gy: number[],
  targets: SpatialConstraint[],
) {
  const result = grid.map((row) => row.slice())
  for (const target of targets) {
    const i = findAxisIndex(gx, target.x)
    const j = findAxisIndex(gy, target.y)
    if (i >= 0 && j >= 0) result[j][i] = target.z
  }
  return result
}
