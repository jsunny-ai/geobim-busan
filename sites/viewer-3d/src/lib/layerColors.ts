import { soilDetailColor } from "@/lib/soilDetail"

export const STRATA_LAYER_KEYS = [
  "soil",
  "weathered_rock",
  "soft_rock",
  "normal_rock",
  "hard_rock",
  "unknown",
] as const

export type StrataLayerKey = typeof STRATA_LAYER_KEYS[number]
export type LayerColorKey = StrataLayerKey | `soil_detail:${string}`
export type LayerColorOverrides = Partial<Record<LayerColorKey, string>>

export const DEFAULT_LAYER_COLORS: Record<StrataLayerKey, string> = {
  soil: "#8B7355",
  weathered_rock: "#C4A57B",
  soft_rock: "#6B8E5A",
  normal_rock: "#5F6552",
  hard_rock: "#3D3D3D",
  unknown: "#B4B4B4",
}

export const LAYER_LABEL: Record<StrataLayerKey, string> = {
  soil: "토사",
  weathered_rock: "풍화암",
  soft_rock: "연암",
  normal_rock: "보통암",
  hard_rock: "경암",
  unknown: "미분류",
}

export function normalizeHexColor(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim()
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/)
  return match ? `#${match[1].toUpperCase()}` : null
}

export function layerColorHex(key: string, overrides?: LayerColorOverrides): string {
  const normalizedKey = key as LayerColorKey
  const override = normalizeHexColor(overrides?.[normalizedKey])
  if (override) return override
  if (normalizedKey.startsWith("soil_detail:")) {
    return normalizeHexColor(soilDetailColor(normalizedKey.slice("soil_detail:".length))) ?? DEFAULT_LAYER_COLORS.soil
  }
  return DEFAULT_LAYER_COLORS[(normalizedKey as StrataLayerKey)] ?? DEFAULT_LAYER_COLORS.unknown
}

export function layerColorNumber(key: string, overrides?: LayerColorOverrides): number {
  return Number.parseInt(layerColorHex(key, overrides).slice(1), 16)
}

export function colorStorageKey(projectId: number | null): string {
  return `geobim.viewer3d.layerColors.project:${projectId ?? "adhoc"}`
}

