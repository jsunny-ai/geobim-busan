import type { Borehole } from "@shared/types"
import { apiUrl } from "@shared/urls"

export interface LngLat {
  lng: number
  lat: number
}

export interface GeoJSONPolygon {
  type: "Polygon"
  coordinates: [number, number][][]
}

export interface ParsedParams {
  polygon: LngLat[] | null
  boreholeIds: number[]
  bbox: [number, number, number, number] | null
  error: string | null
}

export function parseUrlParams(): ParsedParams {
  const sp = new URLSearchParams(window.location.search)
  const bboxStr = sp.get("bbox")
  const bhIds = sp.get("boreholeIds")
  const polyStr = sp.get("polygon")

  if (!bboxStr) {
    return { polygon: null, boreholeIds: [], bbox: null, error: "bbox 파라미터 없음 — 1단계(지도)부터 시작하세요." }
  }

  try {
    // 1. bbox 파싱
    const bbox = bboxStr.split(",").map(Number) as [number, number, number, number]
    if (bbox.length !== 4 || bbox.some(isNaN)) {
      return { polygon: null, boreholeIds: [], bbox: null, error: "잘못된 bbox 형식" }
    }

    // 2. boreholeIds 파싱
    const boreholeIds = bhIds
      ? bhIds.split(",").map(Number).filter(n => !isNaN(n))
      : []

    // 3. polygon 파싱
    let polygon: LngLat[] | null = null
    if (polyStr) {
      polygon = JSON.parse(decodeURIComponent(polyStr)) as LngLat[]
    }

    return { polygon, boreholeIds, bbox, error: null }
  } catch (err) {
    return { polygon: null, boreholeIds: [], bbox: null, error: "URL 파라미터 파싱 실패" }
  }
}

export async function fetchBoreholesByBbox(
  bbox: [number, number, number, number],
  polygon?: LngLat[],
  boreholeIds?: number[]
): Promise<Borehole[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox
  // [버그 수정] 백엔드 list_boreholes는 bbox 파라미터를 지원하지 않음(무시하고
  // 전체에서 limit건 반환) → 선택 ID가 limit 범위 밖이면 0건이 되는 잠복 버그.
  // 1차: ids 파라미터로 정확히 요청 (현행 백엔드 코드 지원)
  // 2차: 실행 중인 백엔드가 ids 미지원 구버전이면 단건 엔드포인트로 폴백
  const ids = (boreholeIds ?? []).map(Number).filter((n) => Number.isFinite(n))
  const idsParam = ids.length > 0 ? `&ids=${ids.join(",")}` : ""
  const url = apiUrl(`/api/v1/boreholes?bbox=${minLng},${minLat},${maxLng},${maxLat}&limit=5000&include_strata=true${idsParam}`)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`시추공 API 오류: HTTP ${r.status}`)
  const data = await r.json()
  const boreholes: Borehole[] = data.boreholes ?? []
  if (ids.length === 0) return boreholes

  const wanted = new Set(ids)
  const matched = boreholes.filter((b: any) => wanted.has(Number(b.id)))

  // 백엔드가 ids를 적용했다면 응답 전체가 요청 ID의 부분집합이어야 한다.
  // (일부 ID가 DB에 없을 수는 있으나, 무관한 시추공이 섞여 있으면 ids 미적용)
  const idsHonored = boreholes.length === matched.length
  if (idsHonored && matched.length > 0) return matched

  // 폴백: GET /boreholes/{id} (항상 strata 포함) 병렬 단건 조회
  const fetched = await Promise.all(
    ids.map(async (id) => {
      try {
        const rr = await fetch(apiUrl(`/api/v1/boreholes/${id}`))
        return rr.ok ? ((await rr.json()) as Borehole) : null
      } catch {
        return null
      }
    }),
  )
  return fetched.filter((b): b is Borehole => b !== null)
}
