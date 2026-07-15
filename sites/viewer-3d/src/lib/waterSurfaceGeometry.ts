import * as THREE from "three"
import type { AuthoritativeTerrainGrid } from "./authoritativeTerrain.ts"
import type { CoastalLandMask } from "./coastalLandMask.ts"
import { createLocalProjection, type Bbox } from "./projection.ts"
import type { WaterSurfaceMask } from "./waterSurfaceMask.ts"

export interface WaterSurfaceGeometryDiagnostic {
  cellCount: number
  seaCellCount: number
  inlandWaterCellCount: number
  seaLevelM: number
}

export function seaWaterElevationAt(
  coastalLandMask: CoastalLandMask | undefined,
  lng: number,
  lat: number,
  seaLevelM = 0,
) {
  if (!coastalLandMask?.configured) return null
  return coastalLandMask.containsWithBuffer(lng, lat, 2) ? null : seaLevelM
}

export function combinedWaterElevationAt(
  waterMask: WaterSurfaceMask,
  coastalLandMask: CoastalLandMask | undefined,
  lng: number,
  lat: number,
  seaLevelM = 0,
) {
  const inlandElevation = waterMask.capElevationAt(lng, lat)
  if (inlandElevation !== null && inlandElevation !== undefined && Number.isFinite(inlandElevation)) {
    return { elevationM: inlandElevation, kind: "inland" as const }
  }
  const seaElevation = seaWaterElevationAt(coastalLandMask, lng, lat, seaLevelM)
  if (seaElevation !== null) return { elevationM: seaElevation, kind: "sea" as const }
  return null
}

export function buildWaterSurfaceGeometry(
  bbox: Bbox,
  terrain: AuthoritativeTerrainGrid,
  waterMask: WaterSurfaceMask,
  coastalLandMask?: CoastalLandMask,
  modelWidth = 2,
  resolution = 240,
  seaLevelM = 0,
) {
  const projection = createLocalProjection(bbox, modelWidth)
  const nx = Math.max(2, resolution)
  const ny = Math.max(2, Math.round(resolution * projection.modelDepth / projection.modelWidth))
  const positions: number[] = []
  const indices: number[] = []
  let seaCellCount = 0
  let inlandWaterCellCount = 0

  const lngAt = (i: number) => bbox[0] + ((bbox[2] - bbox[0]) * i) / nx
  const latAt = (j: number) => bbox[1] + ((bbox[3] - bbox[1]) * j) / ny

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const centerLng = (lngAt(i) + lngAt(i + 1)) / 2
      const centerLat = (latAt(j) + latAt(j + 1)) / 2
      const water = combinedWaterElevationAt(waterMask, coastalLandMask, centerLng, centerLat, seaLevelM)
      if (!water) continue

      const cornerLngLat = [
        [lngAt(i), latAt(j)],
        [lngAt(i + 1), latAt(j)],
        [lngAt(i + 1), latAt(j + 1)],
        [lngAt(i), latAt(j + 1)],
      ] as const
      const base = positions.length / 3
      const elevationM = water.elevationM
      for (const [lng, lat] of cornerLngLat) {
        const model = projection.lngLatToModel(lng, lat)
        positions.push(model.x, elevationM * projection.metersToModel + 0.004, model.z)
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      if (water.kind === "sea") seaCellCount++
      else inlandWaterCellCount++
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return {
    geometry,
    diagnostic: {
      cellCount: indices.length / 6,
      seaCellCount,
      inlandWaterCellCount,
      seaLevelM,
    } satisfies WaterSurfaceGeometryDiagnostic,
  }
}
