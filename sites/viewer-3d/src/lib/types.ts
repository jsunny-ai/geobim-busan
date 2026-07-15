import type { Borehole } from "@shared/types"
import { DEFAULT_SECTION_FLIPPED } from "./sectionDefaults"
import { DEFAULT_BOREHOLE_PROJECTION_DISTANCE_M } from "./sectionBoreholeProjection"

export * from "@shared/types"

export interface VirtualBorehole {
  id: number
  project_id: number
  name: string
  longitude: number
  latitude: number
  elevation: number
  total_depth: number
  source_borehole_id?: number | null
  status: "draft" | "active" | "inactive" | "archived"
  model_enabled: boolean
  constraint_mode: "hard" | "soft"
  influence_weight: number
  influence_radius_m?: number | null
  purpose?: string | null
  interpretation_note: string
  version: number
  data_origin: "virtual_interpretation"
  project_role: "virtual"
  is_virtual: true
  strata: Borehole["strata"]
  dem_elevation?: number
}

export type SectionInteractionMode = "idle" | "placing-start" | "placing-end" | "editing"

export interface SectionPoint {
  x: number
  z: number
}

export interface VerticalSectionState {
  enabled: boolean
  interactionMode: SectionInteractionMode
  start: SectionPoint | null
  end: SectionPoint | null
  offsetM: number
  flipped: boolean
  boreholeProjectionDistanceM: number
  clipDrape: boolean
  clipBoreholes: boolean
}

export const DEFAULT_VERTICAL_SECTION_STATE: VerticalSectionState = {
  enabled: false,
  interactionMode: "idle",
  start: null,
  end: null,
  offsetM: 0,
  flipped: DEFAULT_SECTION_FLIPPED,
  boreholeProjectionDistanceM: DEFAULT_BOREHOLE_PROJECTION_DISTANCE_M,
  clipDrape: true,
  clipBoreholes: true,
}
