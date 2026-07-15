import type { CoastalLandMask } from "./coastalLandMask.ts"

const SAMPLE_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7071, 0.7071],
  [-0.7071, 0.7071],
  [0.7071, -0.7071],
  [-0.7071, -0.7071],
] as const

function offsetLngLat(lng: number, lat: number, eastM: number, northM: number) {
  const latDelta = northM / 110_540
  const lngDelta = eastM / (111_320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)))
  return { lng: lng + lngDelta, lat: lat + latDelta }
}

export function coastalDisplayTerrainElevation(
  lng: number,
  lat: number,
  sourceElevationM: number,
  coastalLandMask: CoastalLandMask | undefined,
  seaLevelM = 0,
) {
  if (!coastalLandMask?.configured || coastalLandMask.containsWithBuffer(lng, lat, 2)) {
    return sourceElevationM
  }

  const searchRadiiM = [5, 10, 20, 40, 80, 160, 320]
  const nearestLandRadiusM = searchRadiiM.find((radiusM) =>
    SAMPLE_DIRECTIONS.some(([dx, dy]) => {
      const sample = offsetLngLat(lng, lat, dx * radiusM, dy * radiusM)
      return coastalLandMask.containsWithBuffer(sample.lng, sample.lat, 2)
    }),
  )
  const depthM = nearestLandRadiusM === undefined
    ? 16
    : Math.min(16, 0.75 + nearestLandRadiusM * 0.045)
  return Math.min(sourceElevationM, seaLevelM - depthM)
}
