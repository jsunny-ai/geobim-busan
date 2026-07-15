import type { ParsedParams } from "./types"

export function parseUrlParams(): ParsedParams {
  const sp = new URLSearchParams(window.location.search)
  const bboxStr = sp.get("bbox")
  const polyStr = sp.get("polygon")
  const projStr = sp.get("projectId") ?? sp.get("project_id")
  const bhIdsStr = sp.get("boreholeIds")
  const projectId = projStr ? Number(projStr) : null

  const boreholeIds = bhIdsStr
    ? bhIdsStr.split(",").map(Number).filter((n) => Number.isFinite(n))
    : []

  if (!bboxStr) {
    if (projectId && Number.isFinite(projectId)) {
      return { bbox: null, polygon: null, projectId, boreholeIds, error: null }
    }
    return {
      bbox: null,
      polygon: null,
      projectId: null,
      boreholeIds,
      error: "bbox 파라미터가 없습니다. 지도 또는 프로젝트에서 다시 진입해주세요.",
    }
  }

  try {
    const bbox = bboxStr.split(",").map(Number) as [number, number, number, number]
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
      return { bbox: null, polygon: null, projectId, boreholeIds, error: "bbox 형식이 올바르지 않습니다." }
    }

    const polygon = polyStr
      ? (JSON.parse(decodeURIComponent(polyStr)) as { lng: number; lat: number }[])
      : null

    return { bbox, polygon, projectId, boreholeIds, error: null }
  } catch {
    return { bbox: null, polygon: null, projectId, boreholeIds, error: "URL 파라미터를 읽지 못했습니다." }
  }
}

export async function fetchBoreholes(
  bbox: [number, number, number, number],
  projectId: number | null,
  boreholeIds: number[] = [],
  polygon: { lng: number; lat: number }[] | null = null,
): Promise<any[]> {
  if (projectId) {
    const r = await fetch(`/api/v1/projects/${projectId}/boreholes/effective`)
    if (!r.ok) throw new Error(`프로젝트 시추공 API 오류: HTTP ${r.status}`)
    const data = await r.json()
    return data.boreholes ?? []
  }

  const ids = boreholeIds.filter((n) => Number.isFinite(n))
  if (ids.length > 0) {
    const url = `/api/v1/boreholes/?ids=${ids.join(",")}&limit=${Math.max(ids.length, 1)}&include_strata=true`
    const r = await fetch(url)
    if (!r.ok) throw new Error(`시추공 API 오류: HTTP ${r.status}`)
    const data = await r.json()
    return data.boreholes ?? []
  }

  const [minLng, minLat, maxLng, maxLat] = bbox
  const ring = polygon && polygon.length >= 3
    ? polygon
    : [
        { lng: minLng, lat: minLat },
        { lng: maxLng, lat: minLat },
        { lng: maxLng, lat: maxLat },
        { lng: minLng, lat: maxLat },
      ]
  const closedRing = [...ring]
  const first = closedRing[0]
  const last = closedRing[closedRing.length - 1]
  if (first && last && (first.lng !== last.lng || first.lat !== last.lat)) {
    closedRing.push(first)
  }

  const r = await fetch("/api/v1/boreholes/by-area", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      polygon: {
        type: "Polygon",
        coordinates: [closedRing.map((p) => [p.lng, p.lat])],
      },
      project_id: projectId,
      include_strata: true,
    }),
  })
  if (!r.ok) throw new Error(`시추공 API 오류: HTTP ${r.status}`)
  const data = await r.json()
  return data.boreholes ?? []
}
