export interface GroundwaterAnchor {
  x: number
  y: number
  headElevationM: number
  observationId?: number | string
}

export interface GroundwaterConstraintDiagnostic {
  observationCount: number
  maxAbsObservationErrorM: number
  meanAbsObservationErrorM: number
  constraintPassed: boolean
  toleranceM: number
}

export interface GroundwaterSurface {
  readonly anchors: readonly GroundwaterAnchor[]
  evaluate(x: number, y: number): number
  diagnose(toleranceM?: number): GroundwaterConstraintDiagnostic
}

const DEFAULT_TOLERANCE_M = 1e-6
const XY_TOLERANCE = 1e-12
const HEAD_TOLERANCE_M = 1e-9

export function groundwaterHeadElevation(
  boreholeElevationM: number,
  depthBelowGroundM: number,
): number {
  if (!Number.isFinite(boreholeElevationM) || !Number.isFinite(depthBelowGroundM)) {
    throw new Error("Groundwater elevation requires finite collar elevation and depth.")
  }
  return boreholeElevationM - depthBelowGroundM
}

function sameXY(a: GroundwaterAnchor, b: GroundwaterAnchor) {
  return Math.abs(a.x - b.x) <= XY_TOLERANCE && Math.abs(a.y - b.y) <= XY_TOLERANCE
}

function validateAndDeduplicateAnchors(input: readonly GroundwaterAnchor[]) {
  const anchors: GroundwaterAnchor[] = []
  for (const anchor of input) {
    if (![anchor.x, anchor.y, anchor.headElevationM].every(Number.isFinite)) {
      throw new Error("Groundwater anchors require finite X, Y and head elevation.")
    }
    const existing = anchors.find((candidate) => sameXY(candidate, anchor))
    if (!existing) {
      anchors.push({ ...anchor })
      continue
    }
    if (Math.abs(existing.headElevationM - anchor.headElevationM) > HEAD_TOLERANCE_M) {
      throw new Error(
        `Conflicting groundwater observations share XY (${anchor.x}, ${anchor.y}). ` +
        "Select one observation time/record explicitly.",
      )
    }
  }
  if (anchors.length === 0) throw new Error("At least one groundwater anchor is required.")
  return anchors
}

/**
 * Creates a continuous exact IDW evaluator.
 *
 * The direct anchor lookup is the permanent hard-constraint guard: regardless
 * of interpolation settings, evaluating an observation XY returns its stored
 * head elevation without smoothing, gridding or bilinear resampling.
 *
 * `trendAt`, if supplied, is an optional background field (e.g. terrain
 * elevation) used to shape the surface *between* anchors so it can extend
 * sensibly past the observed area (ridges, valleys, etc.) instead of going
 * flat. IDW is applied to the *residual* (anchor value minus trend) and the
 * trend is added back at evaluation time. Because the exact-anchor branch is
 * evaluated first and returns unconditionally, the trend can never change an
 * anchor's value — see docs/groundwater_observation_hard_constraint.md rule 11.
 */
export function createExactGroundwaterSurface(
  input: readonly GroundwaterAnchor[],
  power = 2,
  trendAt?: (x: number, y: number) => number,
): GroundwaterSurface {
  if (!Number.isFinite(power) || power <= 0) throw new Error("IDW power must be positive.")
  const anchors = validateAndDeduplicateAnchors(input)

  const evaluate = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Groundwater surface evaluation requires finite X and Y.")
    }
    const exact = anchors.find(
      (anchor) => Math.abs(anchor.x - x) <= XY_TOLERANCE && Math.abs(anchor.y - y) <= XY_TOLERANCE,
    )
    if (exact) return exact.headElevationM

    let weighted = 0
    let weightSum = 0
    for (const anchor of anchors) {
      const distance = Math.hypot(anchor.x - x, anchor.y - y)
      const weight = 1 / Math.pow(distance, power)
      const value = trendAt ? anchor.headElevationM - trendAt(anchor.x, anchor.y) : anchor.headElevationM
      weighted += weight * value
      weightSum += weight
    }
    const interpolated = weighted / weightSum
    if (!trendAt) return interpolated
    const trendValue = trendAt(x, y)
    if (!Number.isFinite(trendValue)) {
      throw new Error("Groundwater trend function must return a finite elevation.")
    }
    return trendValue + interpolated
  }

  const diagnose = (toleranceM = DEFAULT_TOLERANCE_M): GroundwaterConstraintDiagnostic => {
    if (!Number.isFinite(toleranceM) || toleranceM < 0) {
      throw new Error("Groundwater constraint tolerance must be finite and non-negative.")
    }
    const errors = anchors.map(
      (anchor) => Math.abs(evaluate(anchor.x, anchor.y) - anchor.headElevationM),
    )
    const max = Math.max(...errors)
    const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length
    return {
      observationCount: anchors.length,
      maxAbsObservationErrorM: max,
      meanAbsObservationErrorM: mean,
      constraintPassed: max <= toleranceM,
      toleranceM,
    }
  }

  return { anchors, evaluate, diagnose }
}
