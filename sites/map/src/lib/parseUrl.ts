import type { Borehole, GeoJSONPolygon, LngLat } from "./types"

export interface ParsedParams {
  polygon: LngLat[] | null
  boreholeIds: number[]          // ID 목록만 반환 (실제 데이터는 비동기 fetch)
  bbox: [number, number, number, number] | null  // [minLng, minLat, maxLng, maxLat]
  error: string | null
}

/** URL 파라미터에서 polygon · borehole ID 목록 파싱 (동기, mock 없음). */
export function parseUrlParams(): ParsedParams {
  const sp = new URLSearchParams(window.location.search)
  const polyB64 = sp.get("polygon")
  const bhIds   = sp.get("boreholes")

  if (!polyB64) {
    return { polygon: null, boreholeIds: [], bbox: null, error: "polygon 파라미터 없음 — 1단계(지도)부터 시작하세요." }
  }

  try {
    const geojson: GeoJSONPolygon = JSON.parse(atob(polyB64))
    const polygon: LngLat[] = geojson.coordinates[0].map(([lng, lat]) => ({ lng, lat }))

    const lngs = polygon.map((p) => p.lng)
    const lats = polygon.map((p) => p.lat)
    const bbox: [number, number, number, number] = [
      Math.min(...lngs), Math.min(...lats),
      Math.max(...lngs), Math.max(...lats),
    ]

    const boreholeIds = bhIds
      ? bhIds.split(",").map(Number).filter(Boolean)
      : []

    return { polygon, boreholeIds, bbox, error: null }
  } catch {
    return { polygon: null, boreholeIds: [], bbox: null, error: "URL 파라미터 파싱 실패" }
  }
}

/** bbox로 시추공 목록 fetch (include_strata=true). */
export async function fetchBoreholesByBbox(
  bbox: [number, number, number, number],
): Promise<Borehole[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const url = `/api/v1/boreholes?bbox=${minLng},${minLat},${maxLng},${maxLat}&limit=5000&include_strata=true`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`시추공 API 오류: HTTP ${r.status}`)
  const data = await r.json()
  return data.boreholes ?? []
}
