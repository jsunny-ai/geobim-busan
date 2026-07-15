export const DEFAULT_BOREHOLE_PROJECTION_DISTANCE_M = 15

// Section borehole intervals sit immediately in front of the section caps.
// Keeping depth testing enabled lets cap fragments leak through as camera
// distance changes and depth-buffer precision shifts.
export const SECTION_BOREHOLE_RIBBON_DEPTH_TEST = false

export interface SectionProjectionPoint {
  x: number
  y: number
  z: number
}

interface SectionProjectionArgs {
  point: SectionProjectionPoint
  start: { x: number; z: number }
  end: { x: number; z: number }
  planeNormal: { x: number; z: number }
  planeConstant: number
  maxDistanceModel: number
  chainageMarginModel?: number
}

export interface SectionProjectionResult {
  point: SectionProjectionPoint
  signedDistanceModel: number
  chainageModel: number
  sectionLengthModel: number
}

interface OriginalBoreholeVisibilityArgs {
  boreholeColumnsVisible: boolean
  sectionActive: boolean
  clipBoreholes: boolean
  isSectionBorehole: boolean
  isLabel: boolean
  signedDistanceModel: number
  toleranceModel?: number
}

export const shouldShowOriginalBoreholeChild = ({
  boreholeColumnsVisible,
  sectionActive,
  clipBoreholes,
  isSectionBorehole,
  isLabel,
  signedDistanceModel,
  toleranceModel = 0,
}: OriginalBoreholeVisibilityArgs) => {
  if (!boreholeColumnsVisible) return false
  if (!sectionActive || !clipBoreholes) return true
  if (isSectionBorehole) return false
  return isLabel && signedDistanceModel >= -Math.max(0, toleranceModel)
}

export const projectPointToSection = ({
  point,
  start,
  end,
  planeNormal,
  planeConstant,
  maxDistanceModel,
  chainageMarginModel = 0,
}: SectionProjectionArgs): SectionProjectionResult | null => {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const sectionLengthModel = Math.hypot(dx, dz)
  if (!Number.isFinite(sectionLengthModel) || sectionLengthModel <= 1e-9) return null

  const signedDistanceModel = planeNormal.x * point.x + planeNormal.z * point.z + planeConstant
  if (!Number.isFinite(signedDistanceModel) || Math.abs(signedDistanceModel) > Math.max(0, maxDistanceModel)) return null

  const projected = {
    x: point.x - planeNormal.x * signedDistanceModel,
    y: point.y,
    z: point.z - planeNormal.z * signedDistanceModel,
  }
  const chainageModel = ((projected.x - start.x) * dx + (projected.z - start.z) * dz) / sectionLengthModel
  const margin = Math.max(0, chainageMarginModel)
  if (chainageModel < -margin || chainageModel > sectionLengthModel + margin) return null

  return {
    point: projected,
    signedDistanceModel,
    chainageModel,
    sectionLengthModel,
  }
}
