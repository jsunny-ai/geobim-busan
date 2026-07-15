export type Project = {
  id: number
  name: string
  region?: string | null
}

export type JobStatus = "pending" | "running" | "awaiting_review" | "approved" | "failed"

export type ExtractionJob = {
  id: number
  project_id: number
  status: JobStatus
  borehole_count: number
  result?: {
    project_name?: string
    borehole_count?: number
    stratum_count?: number
    rows?: PreviewRow[]
  } | null
  error?: string | null
}

export type PreviewRow = {
  [key: string]: number | string | undefined
  "프로젝트명"?: string
  "시추공명"?: string
  "상심도"?: number | string
  "하심도"?: number | string
  "지층명"?: string
  "경도"?: number | string
  "위도"?: number | string
  lon_wgs84?: number | string
  lat_wgs84?: number | string
  tm_x?: number | string
  tm_y?: number | string
  raw_x?: number | string
  raw_y?: number | string
  coordinate_order?: string
  water_level_gl?: number | string
  water_level_el?: number | string
  "표고"?: number | string
  meta_crs?: string
}

export type CrsOption = {
  value: string
  label: string
  kind: "wgs84" | "grs80-tm" | "server"
  lon0?: number
  lat0?: number
  scaleFactor?: number
  falseEasting?: number
  falseNorthing?: number
}

export type ManualUpload = {
  job_id: number
  status: JobStatus
  project_id: number
  page_count: number
}

export type CoordinateConvertResponse = {
  raw_x: number | string
  raw_y: number | string
  source_crs: string | null
  lon_wgs84: number | string
  lat_wgs84: number | string
  tm_x: number | string
  tm_y: number | string
  meta_crs: string
  valid: boolean
  message?: string | null
}

export type ManualBox = {
  id: string
  label: ManualLabel
  template: ManualTemplate
  page: number
  rect: [number, number, number, number]
}

export type ManualTemplate = "first" | "continuation"
export type PageMode = "same" | "split"

export type ManualLabel =
  | "project_name"
  | "borehole_name"
  | "coordinates"
  | "x_coord"
  | "y_coord"
  | "elevation"
  | "water_level_gl"
  | "water_level_el"
  | "depth"
  | "top_depth"
  | "bottom_depth"
  | "stratum_name"
  | "crs"

export type PreviewPoint = {
  id: string
  name: string
  lon: number
  lat: number
  crs?: string
}

export type Tab = "auto" | "manual" | "csv"
