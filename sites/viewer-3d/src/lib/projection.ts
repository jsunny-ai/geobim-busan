const EARTH_RADIUS_M = 6378137

export type Bbox = [number, number, number, number]

export interface LocalProjection {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
  originLng: number
  originLat: number
  cosOriginLat: number
  widthM: number
  heightM: number
  modelWidth: number
  modelDepth: number
  metersToModel: number
  lngLatToMeters: (lng: number, lat: number) => { x: number; y: number }
  lngLatToModel: (lng: number, lat: number) => { x: number; z: number }
  distanceMeters: (a: { lng: number; lat: number }, b: { lng: number; lat: number }) => number
}

export function createLocalProjection(bbox: Bbox, modelWidth = 2): LocalProjection {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const originLng = (minLng + maxLng) / 2
  const originLat = (minLat + maxLat) / 2
  const cosOriginLat = Math.cos(toRadians(originLat))

  const lngLatToMeters = (lng: number, lat: number) => ({
    x: toRadians(lng - originLng) * EARTH_RADIUS_M * cosOriginLat,
    y: toRadians(lat - originLat) * EARTH_RADIUS_M,
  })

  const sw = lngLatToMeters(minLng, minLat)
  const ne = lngLatToMeters(maxLng, maxLat)
  const widthM = Math.max(Math.abs(ne.x - sw.x), 1e-6)
  const heightM = Math.max(Math.abs(ne.y - sw.y), 1e-6)
  const metersToModel = modelWidth / widthM
  const modelDepth = heightM * metersToModel

  const lngLatToModel = (lng: number, lat: number) => {
    const p = lngLatToMeters(lng, lat)
    return {
      x: p.x * metersToModel,
      z: -p.y * metersToModel,
    }
  }

  const distanceMeters = (
    a: { lng: number; lat: number },
    b: { lng: number; lat: number },
  ) => {
    const pa = lngLatToMeters(a.lng, a.lat)
    const pb = lngLatToMeters(b.lng, b.lat)
    return Math.hypot(pa.x - pb.x, pa.y - pb.y)
  }

  return {
    minLng,
    minLat,
    maxLng,
    maxLat,
    originLng,
    originLat,
    cosOriginLat,
    widthM,
    heightM,
    modelWidth,
    modelDepth,
    metersToModel,
    lngLatToMeters,
    lngLatToModel,
    distanceMeters,
  }
}

export function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180
}
