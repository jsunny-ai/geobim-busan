type Position = [number, number]
type PolygonCoordinates = Position[][]
type MultiPolygonCoordinates = Position[][][]

export interface CoastalFeature {
  geometry?: {
    type?: string
    coordinates?: PolygonCoordinates | MultiPolygonCoordinates
  }
}

export interface CoastalLandMask {
  polygonCount: number
  status: string
  source: string | null
  sourceDate: string | null
  verticalDatum: string | null
  configured: boolean
  polygons?: any[]
  contains(lng: number, lat: number): boolean
  containsWithBuffer(lng: number, lat: number, bufferM?: number): boolean
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

export function buildCoastalLandMask(
  features: readonly CoastalFeature[],
  metadata: Partial<Pick<CoastalLandMask, "status" | "source" | "sourceDate" | "verticalDatum">> = {},
): CoastalLandMask {
  const polygons: PolygonCoordinates[] = []
  for (const feature of features) {
    const geometry = feature.geometry
    if (!geometry?.coordinates) continue
    if (geometry.type === "Polygon") polygons.push(geometry.coordinates as PolygonCoordinates)
    if (geometry.type === "MultiPolygon") polygons.push(...(geometry.coordinates as MultiPolygonCoordinates))
  }
  const configured = metadata.status === "ok" && polygons.length > 0
  const contains = (lng: number, lat: number) =>
    !configured || polygons.some((polygon) => pointInPolygon(lng, lat, polygon))
  return {
    polygonCount: polygons.length,
    status: metadata.status ?? "not_configured",
    source: metadata.source ?? null,
    sourceDate: metadata.sourceDate ?? null,
    verticalDatum: metadata.verticalDatum ?? null,
    configured,
    polygons,
    // Fail open: an unavailable boundary must not erase the existing model.
    contains,
    // Conservative 5 m coastal transition: retain a cell when its centre is
    // on land or falls within a small sampling buffer of land. This avoids
    // removing narrow quays/islands because of a single centre-point sample.
    containsWithBuffer(lng: number, lat: number, bufferM = 5) {
      if (contains(lng, lat) || !configured || bufferM <= 0) return contains(lng, lat)
      const latDelta = bufferM / 110_540
      const lngDelta = bufferM / (111_320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)))
      return [
        [lng - lngDelta, lat],
        [lng + lngDelta, lat],
        [lng, lat - latDelta],
        [lng, lat + latDelta],
        [lng - lngDelta, lat - latDelta],
        [lng + lngDelta, lat - latDelta],
        [lng - lngDelta, lat + latDelta],
        [lng + lngDelta, lat + latDelta],
      ].some(([sampleLng, sampleLat]) => contains(sampleLng, sampleLat))
    },
  }
}
