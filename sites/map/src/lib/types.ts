export interface Stratum {
  id: number
  order: number
  depth_top: number
  depth_bottom: number
  soil_type: string
  strata_group?: string
}

export interface Borehole {
  id: number
  project_id: number
  name: string
  longitude: number
  latitude: number
  elevation: number | null
  strata: Stratum[]
  is_supplementary?: boolean
  data_status?: string
  source_borehole_id?: number | null
  override_id?: number | null
}

export interface Project {
  id: number
  name: string
  description?: string | null
  region: string | null
  source_crs?: string | null
  bbox?: {
    bbox?: [number, number, number, number]
    polygon?: LngLat[]
    borehole_ids?: number[]
  } | null
  borehole_count: number
}

export interface LngLat {
  lng: number
  lat: number
}

export interface GeoJSONPolygon {
  type: "Polygon"
  coordinates: [number, number][][]
}

// GET /api/v1/boreholes 응답 형식
export interface BoreholeApiResponse {
  boreholes: Borehole[]
  count: number
  total?: number
  limit: number
  offset: number
}
