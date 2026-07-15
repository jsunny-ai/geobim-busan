import type { Borehole, Project } from "./types"

export const MOCK_PROJECTS: Project[] = [
  {
    id: 1,
    name: "94건설수원영통(7 8블럭)지구지반조사보고서",
    description: null,
    region: "경기도 수원시",
    source_crs: "EPSG:5186",
    borehole_count: 12,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    name: "수원시 광교신도시 지반조사",
    description: null,
    region: "경기도 수원시",
    source_crs: "EPSG:5186",
    borehole_count: 8,
    created_at: "2026-01-15T00:00:00Z",
  },
  {
    id: 3,
    name: "수원 망포동 택지개발 지반조사",
    description: null,
    region: "경기도 수원시",
    source_crs: "EPSG:5186",
    borehole_count: 24,
    created_at: "2026-02-01T00:00:00Z",
  },
]

export const MOCK_BOREHOLES: Record<number, Borehole[]> = {
  1: [
    {
      id: 1,
      project_id: 1,
      name: "CH-1",
      longitude: 127.0632727,
      latitude: 37.2528274,
      elevation: 39.71,
      strata: [
        { id: 1, order: 0, depth_top: 0.0, depth_bottom: 1.5, soil_type: "토사" },
        { id: 2, order: 1, depth_top: 1.5, depth_bottom: 4.0, soil_type: "풍화암" },
        { id: 3, order: 2, depth_top: 4.0, depth_bottom: 8.5, soil_type: "연암" },
        { id: 4, order: 3, depth_top: 8.5, depth_bottom: 15.0, soil_type: "경암" },
      ],
    },
    {
      id: 2,
      project_id: 1,
      name: "CH-2",
      longitude: 127.0634304,
      latitude: 37.2527372,
      elevation: 43.36,
      strata: [
        { id: 5, order: 0, depth_top: 0.0, depth_bottom: 2.5, soil_type: "풍화암" },
        { id: 6, order: 1, depth_top: 2.5, depth_bottom: 4.5, soil_type: "연암" },
        { id: 7, order: 2, depth_top: 4.5, depth_bottom: 12.0, soil_type: "경암" },
      ],
    },
    {
      id: 3,
      project_id: 1,
      name: "CH-3",
      longitude: 127.0631,
      latitude: 37.253,
      elevation: 41.2,
      strata: [
        { id: 8, order: 0, depth_top: 0.0, depth_bottom: 3.0, soil_type: "토사" },
        { id: 9, order: 1, depth_top: 3.0, depth_bottom: 6.0, soil_type: "풍화토" },
        { id: 10, order: 2, depth_top: 6.0, depth_bottom: 10.0, soil_type: "풍화암" },
        { id: 11, order: 3, depth_top: 10.0, depth_bottom: 18.0, soil_type: "연암" },
      ],
    },
  ],
  2: [
    {
      id: 4,
      project_id: 2,
      name: "BH-1",
      longitude: 127.05,
      latitude: 37.28,
      elevation: 52.1,
      strata: [
        { id: 12, order: 0, depth_top: 0.0, depth_bottom: 2.0, soil_type: "토사" },
        { id: 13, order: 1, depth_top: 2.0, depth_bottom: 7.0, soil_type: "풍화암" },
        { id: 14, order: 2, depth_top: 7.0, depth_bottom: 20.0, soil_type: "경암" },
      ],
    },
  ],
  3: [],
}
