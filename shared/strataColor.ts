// =============================================================================
// 지층 색상 · 분류 공유 유틸  (shared — 프론트엔드 + 백엔드 타입 참조용)
//
// 색상 체계: 지질학적 톤 (deck.gl ColumnLayer / Cesium Entity / Three.js 공용)
//   토사    #8B7355  갈색
//   풍화암  #C4A57B  베이지
//   연암    #6B8E5A  올리브 녹색
//   보통암  #5F6552  짙은 올리브 회색
//   경암    #3D3D3D  진회색
//   미분류  #B4B4B4  회색
//
// 변경 이력
//   2026-05-19  색상 → 지질 톤으로 교체, normalizeStrataGroup 추가
//   2026-06-01  보통암을 normal_rock 으로 분리하여 5단계 지층 기준 적용
// =============================================================================

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------
export type StrataGroup =
  | "soil"
  | "weathered_rock"
  | "soft_rock"
  | "normal_rock"
  | "hard_rock"
  | "unknown"

// ---------------------------------------------------------------------------
// 색상 — CSS hex
// ---------------------------------------------------------------------------
export const COLOR_SOIL      = "#8B7355"   // 토사
export const COLOR_WEATHERED = "#C4A57B"   // 풍화암
export const COLOR_SOFT      = "#6B8E5A"   // 연암
export const COLOR_NORMAL    = "#5F6552"   // 보통암
export const COLOR_HARD      = "#3D3D3D"   // 경암
export const COLOR_FALLBACK  = "#B4B4B4"   // 미분류

// ---------------------------------------------------------------------------
// 색상 — RGB [R, G, B]  (deck.gl getFillColor / Cesium Color.fromBytes 용)
// ---------------------------------------------------------------------------
export const STRATA_RGB: Record<StrataGroup, [number, number, number]> = {
  soil:          [139, 115,  85],
  weathered_rock:[196, 165, 123],
  soft_rock:     [107, 142,  90],
  normal_rock:   [ 95, 101,  82],
  hard_rock:     [ 61,  61,  61],
  unknown:       [180, 180, 180],
}

// ---------------------------------------------------------------------------
// 동의어 맵 — 원본 텍스트(정제 후) → StrataGroup
//
// 완전 일치 우선, 이후 부분 일치 fallback (normalizeStrataGroup 내부 사용)
// 보통암은 normal_rock 으로 분리하고 발파암 · 극경암은 hard_rock 으로 통합
// ---------------------------------------------------------------------------
const STRATA_SYNONYMS: Record<string, StrataGroup> = {
  // 토사 계열
  "토사":       "soil",
  "매립토":     "soil",
  "매립층":     "soil",
  "퇴적토":     "soil",
  "퇴적층":     "soil",
  "충적층":     "soil",
  "붕적층":     "soil",
  "풍화토":     "soil",
  "잔류토":     "soil",

  // 풍화암
  "풍화암":     "weathered_rock",
  "풍화대":     "weathered_rock",
  "풍화기반암": "weathered_rock",

  // 연암
  "연암":       "soft_rock",
  "리핑암":     "soft_rock",

  // 보통암
  "보통암":     "normal_rock",

  // 경암
  "경암":       "hard_rock",
  "발파암":     "hard_rock",
  "극경암":     "hard_rock",
}

// ---------------------------------------------------------------------------
// normalizeStrataGroup
//   1) 공백·괄호·한글 외 문자 제거 → 완전 일치
//   2) 부분 일치 (가장 긴 키 우선 — 우선순위 역전 방지)
//   3) 매칭 실패 → "unknown"
// ---------------------------------------------------------------------------
export function normalizeStrataGroup(raw: string | null | undefined): StrataGroup {
  if (!raw) return "unknown"

  const rawTrimmed = raw.trim().toLowerCase()
  if (["soil", "weathered_rock", "soft_rock", "normal_rock", "hard_rock", "unknown"].includes(rawTrimmed)) {
    return rawTrimmed as StrataGroup
  }

  const cleaned = raw
    .trim()
    .replace(/\s+/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[^가-힣]/g, "")

  // 완전 일치
  if (STRATA_SYNONYMS[cleaned]) return STRATA_SYNONYMS[cleaned]

  // 부분 일치 (키 길이 내림차순)
  const match = Object.entries(STRATA_SYNONYMS)
    .filter(([key]) => cleaned.includes(key))
    .sort(([a], [b]) => b.length - a.length)[0]

  return match ? match[1] : "unknown"
}

// ---------------------------------------------------------------------------
// getStrataGroup — 하위 호환 래퍼 (기존 코드 호환)
// 신규 코드는 normalizeStrataGroup 사용 권장
// ---------------------------------------------------------------------------
export function getStrataGroup(soilType: string): StrataGroup {
  return normalizeStrataGroup(soilType)
}

// ---------------------------------------------------------------------------
// getStrataColor — CSS hex 반환
// ---------------------------------------------------------------------------
export function getStrataColor(soilType: string): string {
  switch (normalizeStrataGroup(soilType)) {
    case "soil":           return COLOR_SOIL
    case "weathered_rock": return COLOR_WEATHERED
    case "soft_rock":      return COLOR_SOFT
    case "normal_rock":    return COLOR_NORMAL
    case "hard_rock":      return COLOR_HARD
    default:               return COLOR_FALLBACK
  }
}

// ---------------------------------------------------------------------------
// getStrataRgb — [R, G, B] 반환  (deck.gl / Cesium / Three.js 직접 사용)
// ---------------------------------------------------------------------------
export function getStrataRgb(soilType: string): [number, number, number] {
  return STRATA_RGB[normalizeStrataGroup(soilType)] ?? [180, 180, 180]
}

// ---------------------------------------------------------------------------
// rgbToHex — [R, G, B] → CSS hex (#RRGGBB)
// ---------------------------------------------------------------------------
export function rgbToHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")
}

// ---------------------------------------------------------------------------
// 범례
// ---------------------------------------------------------------------------
export interface StrataLegendEntry {
  group: StrataGroup
  label: string
  color: string
  rgb: [number, number, number]
}

export const STRATA_LEGEND: StrataLegendEntry[] = [
  { group: "soil",           label: "토사",         color: COLOR_SOIL,      rgb: STRATA_RGB.soil },
  { group: "weathered_rock", label: "풍화암",       color: COLOR_WEATHERED, rgb: STRATA_RGB.weathered_rock },
  { group: "soft_rock",      label: "연암",         color: COLOR_SOFT,      rgb: STRATA_RGB.soft_rock },
  { group: "normal_rock",    label: "보통암",       color: COLOR_NORMAL,    rgb: STRATA_RGB.normal_rock },
  { group: "hard_rock",      label: "경암",         color: COLOR_HARD,      rgb: STRATA_RGB.hard_rock },
  { group: "unknown",        label: "미분류",       color: COLOR_FALLBACK,  rgb: STRATA_RGB.unknown },
]
