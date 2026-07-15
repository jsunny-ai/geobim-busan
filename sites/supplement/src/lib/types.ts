export interface Stratum {
  id?: number
  order: number
  depth_top: number
  depth_bottom: number
  soil_type: string
  strata_group?: string
}

export interface Borehole {
  id: number
  project_id?: number
  name: string
  longitude: number
  latitude: number
  elevation: number | null
  strata: Stratum[]
  is_supplementary?: boolean
  data_status?: string
  project_role?: "existing" | "new" | "duplicate_linked" | "excluded" | string | null
  isNew?: boolean
}

export interface RBFGrids {
  soil: number[][]
  weathered_rock: number[][]
  soft_rock: number[][]
  normal_rock: number[][]
  hard_rock: number[][]
  [key: string]: number[][]
}

export type InterpolationMode = "merge" | "new_only"

export interface ExportOptions {
  mode: InterpolationMode
  layers: string[]
  gridRes: number
}

export interface ParsedParams {
  bbox: [number, number, number, number] | null
  polygon: { lng: number; lat: number }[] | null
  projectId: number | null
  boreholeIds: number[]
  error: string | null
}
