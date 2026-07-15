const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/**
 * Converts the signed soil domain into a physical soil-presence weight.
 *
 * The non-positive side is confirmed no-soil and therefore has exactly zero
 * soil thickness. Cubic smoothstep avoids a visible shoulder in the shared
 * soil/weathered-rock contact through the transition.
 */
export function soilPresenceWeightFromSigned(signed: number) {
  const t = clamp01(signed)
  return t * t * (3 - 2 * t)
}

export function effectiveSoilThickness(interpolatedThickness: number, signed: number) {
  if (!Number.isFinite(interpolatedThickness) || interpolatedThickness <= 0) return 0
  return interpolatedThickness * soilPresenceWeightFromSigned(signed)
}

export function soilAbsenceRadii(
  nearestPresentM: number,
  averageSpacingM: number,
  gridCellM: number,
) {
  const finiteNearest = Number.isFinite(nearestPresentM)
    ? nearestPresentM
    : Math.min(averageSpacingM, 200)
  const coreRadiusM = Math.min(
    100,
    Math.max(gridCellM * 2, Math.min(finiteNearest * 0.3, averageSpacingM * 0.5, 100)),
  )
  const transitionRadiusM = Math.min(
    150,
    Math.max(
      coreRadiusM + gridCellM,
      Math.min(finiteNearest * 0.5, averageSpacingM * 0.75, 150),
    ),
  )
  return { coreRadiusM, transitionRadiusM }
}
