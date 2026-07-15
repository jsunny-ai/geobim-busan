import type { AuthoritativeTerrainGrid } from "./authoritativeTerrain.ts"

type Position = [number, number]
type PolygonCoordinates = Position[][]
type MultiPolygonCoordinates = Position[][][]

export interface WaterFeature {
  geometry?: {
    type?: string
    coordinates?: PolygonCoordinates | MultiPolygonCoordinates
  }
  properties?: {
    water_elevation_m?: number | null
    elevation_source?: string | null
  }
}

export interface WaterSurfaceMask {
  featureCount: number
  capElevationAt(lng: number, lat: number): number | null
}

function pointInRing(lng: number, lat: number, ring: Position[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-15) + xi) {
      inside = !inside
    }
  }
  return inside
}

function pointInPolygon(lng: number, lat: number, polygon: PolygonCoordinates) {
  if (!polygon[0] || !pointInRing(lng, lat, polygon[0])) return false
  return !polygon.slice(1).some((hole) => pointInRing(lng, lat, hole))
}

function polygonSamples(polygon: PolygonCoordinates, terrain: AuthoritativeTerrainGrid) {
  const outer = polygon[0] ?? []
  const samples = outer
    .filter((_, index) => index % Math.max(1, Math.floor(outer.length / 64)) === 0)
    .map(([lng, lat]) => terrain.elevationAt(lng, lat))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return samples
}

function median(values: number[]) {
  if (values.length === 0) return null
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}

export function buildWaterSurfaceMask(
  features: readonly WaterFeature[],
  terrain: AuthoritativeTerrainGrid,
): WaterSurfaceMask {
  const polygons: Array<{ coordinates: PolygonCoordinates; capElevationM: number }> = []
  for (const feature of features) {
    const geometry = feature.geometry
    if (!geometry?.coordinates) continue
    const groups: PolygonCoordinates[] =
      geometry.type === "Polygon"
        ? [geometry.coordinates as PolygonCoordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates as MultiPolygonCoordinates
          : []
    for (const coordinates of groups) {
      const rawObserved = feature.properties?.water_elevation_m
      const observed = rawObserved === null || rawObserved === undefined ? NaN : Number(rawObserved)
      const capElevationM = Number.isFinite(observed)
        ? observed
        : median(polygonSamples(coordinates, terrain))
      if (capElevationM !== null) polygons.push({ coordinates, capElevationM })
    }
  }
  return {
    featureCount: polygons.length,
    capElevationAt(lng: number, lat: number) {
      const matches = polygons
        .filter((polygon) => pointInPolygon(lng, lat, polygon.coordinates))
        .map((polygon) => polygon.capElevationM)
      return matches.length ? Math.min(...matches) : null
    },
  }
}
