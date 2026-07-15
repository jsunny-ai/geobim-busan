// =============================================================================
// 공유 도메인 타입 (프론트엔드 + 백엔드 스키마와 일치)
//
// 변경 이력
//   2026-05-19  Stratum 에 n_value/uscs_code 추가, BoreholeApiResponse 추가,
//               LayerSegment + flattenToSegments 추가 (Cesium/deck.gl 공용)
// =============================================================================

import { normalizeStrataGroup } from "./strataColor"
import type { StrataGroup } from "./strataColor"

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------
export interface Project {
  id: string
  name: string
  region: string | null
  source_crs: string | null
  borehole_count: number
  updated_at: string        // ISO 8601
}

// ---------------------------------------------------------------------------
// Stratum (지층 1개 구간)
// ---------------------------------------------------------------------------
export interface Stratum {
  id?: number
  borehole_id?: string
  soil_type: string         // 원본 한글 텍스트 ("토사", "풍화암" 등)
  depth_top: number         // 상심도 m
  depth_bottom: number      // 하심도 m
  n_value?: number | null   // 표준관입시험 N치
  uscs_code?: string | null // USCS 분류 (선택)
  raw_text?: string | null  // 정규화 전 원본 문자열
  strata_group?: StrataGroup | "unknown" | string | null
}

// ---------------------------------------------------------------------------
// Borehole (시추공)
// ---------------------------------------------------------------------------
export interface Borehole {
  id: string
  name?: string
  project_id: string
  longitude: number         // WGS84 경도
  latitude: number          // WGS84 위도
  elevation: number         // m (MSL 기준 표고)
  groundwater_depth_bgl_m?: number | null
  groundwater_head_elevation_m?: number | null
  groundwater_reference_datum?: string | null
  groundwater_observed_at?: string | null
  source_crs?: string | null
  strata: Stratum[]         // depth_top 오름차순
}

// ---------------------------------------------------------------------------
// BoreholeApiResponse — GET /api/v1/boreholes 응답
// ---------------------------------------------------------------------------
export interface BoreholeApiResponse {
  boreholes: Borehole[]
  count: number             // 반환된 건수
  total?: number            // 전체 건수 (페이지네이션 시)
  limit: number
  offset: number
}

// ---------------------------------------------------------------------------
// LayerSegment — Cesium Cylinder / deck.gl ColumnLayer 입력용 평탄화 세그먼트
// ---------------------------------------------------------------------------
export interface LayerSegment {
  boreholeId: string
  boreholeName?: string
  projectId: string
  lon: number
  lat: number
  elevation: number
  depthFrom: number         // 상심도
  depthTo: number           // 하심도
  zTop: number              // 절대 표고 상단 (elevation - depthFrom)
  zBot: number              // 절대 표고 하단 (elevation - depthTo)
  thickness: number         // 층 두께
  soilType: string          // 원본 한글
  group: StrataGroup        // 정규화된 분류
}

// ---------------------------------------------------------------------------
// flattenToSegments — Borehole[] → LayerSegment[]
//   Cesium CylinderGraphics 및 deck.gl ColumnLayer 에서 직접 사용
// ---------------------------------------------------------------------------
export function flattenToSegments(boreholes: Borehole[]): LayerSegment[] {
  const out: LayerSegment[] = []
  for (const b of boreholes) {
    for (const s of b.strata) {
      out.push({
        boreholeId:   b.id,
        boreholeName: (b as any).name ?? b.id,
        projectId:    b.project_id,
        lon:          b.longitude,
        lat:          b.latitude,
        elevation:    b.elevation,
        depthFrom:    s.depth_top,
        depthTo:      s.depth_bottom,
        zTop:         b.elevation - s.depth_top,
        zBot:         b.elevation - s.depth_bottom,
        thickness:    s.depth_bottom - s.depth_top,
        soilType:     s.soil_type,
        group:        normalizeStrataGroup(s.soil_type),  // 정규화 직접 적용
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
export interface User {
  id: string
  email: string
  display_name: string | null
  role: "designer" | "expert" | "reviewer" | "admin"
}
