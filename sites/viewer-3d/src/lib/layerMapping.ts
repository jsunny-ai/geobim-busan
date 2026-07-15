// =============================================================================
// 지층명 정규화 매핑
// 원본 지층명 텍스트를 표준 LayerType enum 으로 변환
// =============================================================================

export type LayerTypeKey =
  | 'TOPSOIL'
  | 'WEATHERED'
  | 'SOFT_ROCK'
  | 'HARD_ROCK'
  | 'UNKNOWN'

/** 지층명 표준 색상 (RGB) */
export const LAYER_COLORS: Record<LayerTypeKey, [number, number, number]> = {
  TOPSOIL:   [139, 115, 85],   // #8B7355 - 토사
  WEATHERED: [196, 165, 123],  // #C4A57B - 풍화암
  SOFT_ROCK: [107, 142, 90],   // #6B8E5A - 연암
  HARD_ROCK: [61,  61,  61],   // #3D3D3D - 경암
  UNKNOWN:   [180, 180, 180],  // #B4B4B4 - 미분류
}

export const LAYER_LABEL_KO: Record<LayerTypeKey, string> = {
  TOPSOIL:   '토사',
  WEATHERED: '풍화암',
  SOFT_ROCK: '연암',
  HARD_ROCK: '경암',
  UNKNOWN:   '미분류',
}

const LAYER_SYNONYMS: Record<string, LayerTypeKey> = {
  // 토사 계열
  '토사': 'TOPSOIL',
  '매립층': 'TOPSOIL',
  '퇴적층': 'TOPSOIL',
  '충적층': 'TOPSOIL',
  '붕적층': 'TOPSOIL',
  '풍화토': 'TOPSOIL',
  // 풍화암
  '풍화암': 'WEATHERED',
  '풍화대': 'WEATHERED',
  // 연암
  '연암': 'SOFT_ROCK',
  // 경암
  '경암': 'HARD_ROCK',
  '보통암': 'HARD_ROCK',
}

export function normalizeLayerType(raw: string | null | undefined): LayerTypeKey {
  if (!raw) return 'UNKNOWN'
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^가-힣]/g, '')

  if (LAYER_SYNONYMS[cleaned]) return LAYER_SYNONYMS[cleaned]

  const matches = Object.entries(LAYER_SYNONYMS)
    .filter(([key]) => cleaned.includes(key))
    .sort(([a], [b]) => b.length - a.length)

  return matches[0]?.[1] ?? 'UNKNOWN'
}

export function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}
