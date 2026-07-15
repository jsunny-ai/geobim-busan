import type { Borehole } from "./types.ts"
import type { GroundwaterAnchor } from "./groundwaterSurface.ts"
import { groundwaterHeadElevation } from "./groundwaterSurface.ts"

export interface BoreholeGroundwaterObservation extends GroundwaterAnchor {
  boreholeId: string
  boreholeName: string
  depthBelowGroundM: number
  observedAt: string | null
  source: "api" | "legacy_raw_text"
}

const LEGACY_WATER_PATTERN =
  /(?:지하수위|water[_\s-]*(?:level(?:[_\s-]*gl)?|gl))['"]?\s*[:=]\s*['"]?\s*(?:GL\s*\(?\s*[-+]?\s*\)?\s*)?(-?\d+(?:\.\d+)?)/i

export function groundwaterDepthFromBorehole(borehole: Borehole): {
  depthBelowGroundM: number
  source: "api" | "legacy_raw_text"
} | null {
  const direct = Number(borehole.groundwater_depth_bgl_m)
  if (Number.isFinite(direct) && direct >= 0) return { depthBelowGroundM: direct, source: "api" }
  for (const stratum of borehole.strata ?? []) {
    const raw = stratum.raw_text
    if (!raw || /(?:지하수위|water[_\s-]*(?:level(?:[_\s-]*gl)?|gl))['"]?\s*[:=]\s*['"]?\s*(?:N\/?A|NONE|NULL|-)(?:['",}\s]|$)/i.test(raw)) continue
    const match = raw.match(LEGACY_WATER_PATTERN)
    const depth = match ? Number(match[1]) : NaN
    if (Number.isFinite(depth) && depth >= 0) return { depthBelowGroundM: depth, source: "legacy_raw_text" }
  }
  return null
}

/**
 * Average observed depth-to-water across the current observation set. Used
 * as the offset between a terrain-elevation trend and a plausible head
 * elevation where no borehole exists (e.g. terrainElevAt(x,y) - this value).
 * Returns 0 for an empty set — callers should guard on observations.length.
 */
export function meanDepthBelowGroundM(observations: readonly BoreholeGroundwaterObservation[]): number {
  if (observations.length === 0) return 0
  const total = observations.reduce((sum, observation) => sum + observation.depthBelowGroundM, 0)
  return total / observations.length
}

export function groundwaterObservationsFromBoreholes(
  boreholes: readonly Borehole[],
): BoreholeGroundwaterObservation[] {
  const observations: BoreholeGroundwaterObservation[] = []
  for (const borehole of boreholes) {
    const depth = groundwaterDepthFromBorehole(borehole)
    if (!depth || !Number.isFinite(borehole.elevation)) continue
    const apiHead = Number(borehole.groundwater_head_elevation_m)
    observations.push({
      x: borehole.longitude, y: borehole.latitude,
      headElevationM: Number.isFinite(apiHead) ? apiHead : groundwaterHeadElevation(borehole.elevation, depth.depthBelowGroundM),
      observationId: borehole.id,
      boreholeId: String(borehole.id),
      boreholeName: borehole.name ?? String(borehole.id),
      depthBelowGroundM: depth.depthBelowGroundM,
      observedAt: borehole.groundwater_observed_at ?? null,
      source: depth.source,
    })
  }
  return observations
}
