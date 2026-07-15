import type { CSSProperties } from "react"
import type {
  PreviewRow,
  CrsOption,
  PreviewPoint,
  ManualLabel,
  ManualTemplate,
  ManualBox,
  CoordinateConvertResponse,
} from "./types"
import { CRS_OPTIONS, MANUAL_LABELS, MANUAL_TEMPLATES } from "./constants"
import { apiPostJson } from "./api"

export function degreesToRadians(value: number) {
  return (value * Math.PI) / 180
}

export function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI
}

export function roundCoordinate(value: number) {
  return Number(value.toFixed(7))
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(String(value).replace(/,/g, ""))
  return Number.isFinite(parsed) ? parsed : null
}

export function lonLatToWorld(lon: number, lat: number, zoom: number) {
  const sinLat = Math.sin((lat * Math.PI) / 180)
  const scale = 256 * 2 ** zoom
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  }
}

export function worldToLonLat(x: number, y: number, zoom: number) {
  const scale = 256 * 2 ** zoom
  const lon = (x / scale) * 360 - 180
  const n = Math.PI - (2 * Math.PI * y) / scale
  const lat = radiansToDegrees(Math.atan(Math.sinh(n)))
  return { lon, lat }
}

export function averagePoint(points: PreviewPoint[]) {
  const total = points.reduce(
    (acc, point) => ({ lon: acc.lon + point.lon, lat: acc.lat + point.lat }),
    { lon: 0, lat: 0 },
  )
  return { lon: total.lon / points.length, lat: total.lat / points.length }
}

export function isWgs84Range(lon: number, lat: number) {
  return lon >= 120 && lon <= 135 && lat >= 30 && lat <= 45
}

export function grs80TmToWgs84(northing: number, easting: number, option: CrsOption): { lat: number; lon: number } | null {
  if (option.lon0 === undefined || option.falseNorthing === undefined) return null
  const a = 6378137.0
  const f = 1 / 298.257222101
  const centralMeridian = option.lon0
  const latitudeOfOrigin = option.lat0 ?? 38
  const scaleFactor = option.scaleFactor ?? 1
  const falseEasting = option.falseEasting ?? 200000
  const falseNorthing = option.falseNorthing
  const b = a * (1 - f)
  const e2 = (a ** 2 - b ** 2) / a ** 2
  const ep2 = (a ** 2 - b ** 2) / b ** 2
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
  const phi0 = degreesToRadians(latitudeOfOrigin)
  const lam0 = degreesToRadians(centralMeridian)
  const mo =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi0 -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi0) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi0) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi0))

  const m = mo + (northing - falseNorthing) / scaleFactor
  const phi1Init = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256))
  const phi1 =
    phi1Init +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * phi1Init) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * phi1Init) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * phi1Init) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * phi1Init)

  const r = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5
  const c = ep2 * Math.cos(phi1) ** 2
  const t = Math.tan(phi1) ** 2
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2)
  const d = (easting - falseEasting) / (n * scaleFactor)

  const latRad =
    phi1 -
    ((n * Math.tan(phi1)) / r) *
      (d ** 2 / 2 -
        (d ** 4 / 24) * (5 + 3 * t + 10 * c - 4 * c ** 2 - 9 * ep2) +
        (d ** 6 / 720) * (61 + 90 * t + 298 * c + 45 * t ** 2 - 252 * ep2 - 3 * c ** 2))
  const lon =
    radiansToDegrees(lam0) +
    radiansToDegrees(
      (1 / Math.cos(phi1)) *
        (d -
          (d ** 3 / 6) * (1 + 2 * t + c) +
          (d ** 5 / 120) * (5 - 2 * c + 28 * t - 3 * c ** 2 + 8 * ep2 + 24 * t ** 2)),
    )
  const lat = radiansToDegrees(latRad)

  return isWgs84Range(lon, lat) ? { lat, lon } : null
}

export function sourceTmCoordinates(row: PreviewRow): { x: number; y: number } | null {
  const candidates: Array<[unknown, unknown]> = [
    [row.raw_x, row.raw_y],
    [row["경도"], row["위도"]],
    [row.tm_x, row.tm_y],
    [row.lon_wgs84, row.lat_wgs84],
  ]

  for (const [rawX, rawY] of candidates) {
    const x = toNumber(rawX)
    const y = toNumber(rawY)
    if (x === null || y === null) continue
    if (Math.max(Math.abs(x), Math.abs(y)) > 100000) {
      return { x, y }
    }
  }
  return null
}

export function normalizeCrsValue(value: unknown) {
  return String(value ?? "").replace(/_INFERRED$/, "")
}

export function recalculatePreviewCoordinates(row: PreviewRow): PreviewRow {
  const crs = normalizeCrsValue(row.meta_crs)
  const option = CRS_OPTIONS.find((item) => item.value === crs)
  if (!option) return row

  if (option.kind === "wgs84") {
    const lon = toNumber(row.raw_x ?? row["경도"] ?? row.lon_wgs84)
    const lat = toNumber(row.raw_y ?? row["위도"] ?? row.lat_wgs84)
    if (lon === null || lat === null || !isWgs84Range(lon, lat)) return row
    return { ...row, lon_wgs84: roundCoordinate(lon), lat_wgs84: roundCoordinate(lat), meta_crs: option.value }
  }

  if (option.kind !== "grs80-tm" || option.lon0 === undefined || option.falseNorthing === undefined) {
    return { ...row, meta_crs: option.value }
  }

  const source = sourceTmCoordinates(row)
  if (!source) return { ...row, meta_crs: option.value }

  const [easting, northing] = source.x < source.y ? [source.x, source.y] : [source.y, source.x]
  const converted = grs80TmToWgs84(northing, easting, option)
  if (!converted) return { ...row, meta_crs: option.value }

  return {
    ...row,
    lon_wgs84: roundCoordinate(converted.lon),
    lat_wgs84: roundCoordinate(converted.lat),
    meta_crs: option.value,
  }
}

export function sourceCoordinatesForConversion(row: PreviewRow, crs: string): { x: number; y: number } | null {
  const normalized = normalizeCrsValue(crs)
  const wgs84Candidates: Array<[unknown, unknown]> = [
    [row.raw_x, row.raw_y],
    [row["경도"], row["위도"]],
    [row.lon_wgs84, row.lat_wgs84],
  ]
  const tmCandidates: Array<[unknown, unknown]> = [
    [row.raw_x, row.raw_y],
    [row["경도"], row["위도"]],
    [row.tm_x, row.tm_y],
  ]
  const candidates = normalized === "EPSG:4326" || normalized === "WGS84" ? wgs84Candidates : tmCandidates

  for (const [rawX, rawY] of candidates) {
    const x = toNumber(rawX)
    const y = toNumber(rawY)
    if (x === null || y === null) continue
    if (normalized === "EPSG:4326" || normalized === "WGS84") {
      if (isWgs84Range(x, y)) return { x, y }
      continue
    }
    if (Math.max(Math.abs(x), Math.abs(y)) > 100000) {
      return { x, y }
    }
  }
  return null
}

export async function convertPreviewCoordinates(row: PreviewRow): Promise<PreviewRow | null> {
  const crs = normalizeCrsValue(row.meta_crs)
  if (!crs) return null
  const source = sourceCoordinatesForConversion(row, crs)
  if (!source) return null

  const converted = await apiPostJson<CoordinateConvertResponse>("/api/v1/coordinates/convert", {
    x: source.x,
    y: source.y,
    source_crs: crs,
    coordinate_order: row.coordinate_order,
    borehole_id: String(row["시추공명"] ?? "preview"),
  })
  if (!converted.valid) return null
  return {
    ...row,
    lon_wgs84: converted.lon_wgs84,
    lat_wgs84: converted.lat_wgs84,
    tm_x: converted.tm_x,
    tm_y: converted.tm_y,
    meta_crs: converted.meta_crs,
  }
}

export function projectNameFromRows(rows: PreviewRow[]) {
  for (const row of rows) {
    const name = String(row["프로젝트명"] ?? "").trim()
    if (name) return name
  }
  return null
}

export function rowsWithProjectName(rows: PreviewRow[], projectName: string): PreviewRow[] {
  const trimmed = projectName.trim()
  if (!trimmed) return rows
  return rows.map((row) => ({ ...row, "프로젝트명": trimmed }))
}

export function previewBoreholeName(row: PreviewRow, index: number) {
  const record = row as Record<string, unknown>
  const direct = record["시추공명"] ?? record["borehole_name"]
  if (direct) return String(direct)
  const fuzzyKey = Object.keys(record).find((key) => key.includes("시추") || key.includes("怨듬챸"))
  const fuzzyValue = fuzzyKey ? record[fuzzyKey] : null
  return fuzzyValue ? String(fuzzyValue) : `BH-${index + 1}`
}

export function uniquePreviewPoints(rows: PreviewRow[]): PreviewPoint[] {
  const points = new Map<string, PreviewPoint>()
  rows.forEach((row, index) => {
    const lon = toNumber(row.lon_wgs84)
    const lat = toNumber(row.lat_wgs84)
    if (lon === null || lat === null) return
    if (lon < 120 || lon > 135 || lat < 30 || lat > 45) return
    const name = previewBoreholeName(row, index)
    const groupId = String(row.__previewGroupId ?? `${name}:${lon.toFixed(7)}:${lat.toFixed(7)}`)
    const key = groupId
    if (!points.has(key)) {
      points.set(key, {
        id: key,
        name,
        lon,
        lat,
        crs: row.meta_crs ? String(row.meta_crs) : undefined,
      })
    }
  })
  return Array.from(points.values())
}

export function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function normalizedRect(start: [number, number], end: [number, number]): [number, number, number, number] {
  return [
    Math.min(start[0], end[0]),
    Math.min(start[1], end[1]),
    Math.max(start[0], end[0]),
    Math.max(start[1], end[1]),
  ]
}

export function boxStyle(rect: [number, number, number, number]): CSSProperties {
  const [x0, y0, x1, y1] = rect
  return {
    left: `${x0 * 100}%`,
    top: `${y0 * 100}%`,
    width: `${(x1 - x0) * 100}%`,
    height: `${(y1 - y0) * 100}%`,
  }
}

export function labelText(label: ManualLabel) {
  return MANUAL_LABELS.find((item) => item.value === label)?.label ?? label
}

export function templateText(template: ManualTemplate) {
  return MANUAL_TEMPLATES.find((item) => item.value === template)?.label ?? template
}

export function hasBox(boxes: ManualBox[], label: ManualLabel) {
  return boxes.some((box) => box.label === label)
}

export function buttonLabel({
  busy,
  file,
  projectId,
}: {
  busy: boolean
  file: File | null
  projectId: number | ""
}) {
  if (busy) return "변환 중"
  if (!file) return "파일을 선택하세요"
  if (projectId === "") return "프로젝트를 선택하세요"
  return "변환 시작"
}

export function cell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-"
  return String(value)
}
