import type React from "react"
import type { Borehole } from "@/lib/types"

export const SOIL_DETAIL_TYPES = [
  "토사",
  "매립토",
  "매립 점토",
  "매립 사질토",
  "매립 자갈",
  "퇴적토",
  "퇴적점토",
  "퇴적 사질토",
  "퇴적자갈",
  "충적토",
  "붕적토",
  "풍화토",
  "점토",
  "실트",
  "모래",
  "자갈",
] as const

const SOIL_DETAIL_ALIASES: Record<string, string> = {
  토사: "토사",
  토층: "토사",
  표토: "토사",
  매립층: "매립토",
  매립토: "매립토",
  매립점토: "매립 점토",
  매립사질토: "매립 사질토",
  매립모래: "매립토",
  매립자갈: "매립 자갈",
  되메움: "매립토",
  붕적층: "붕적토",
  붕적토: "붕적토",
  퇴적층: "퇴적토",
  퇴적토: "퇴적토",
  퇴적점성토: "퇴적점토",
  퇴적점토: "퇴적점토",
  퇴적사질토: "퇴적 사질토",
  퇴적모래: "퇴적 사질토",
  퇴적역질토: "퇴적자갈",
  퇴적자갈: "퇴적자갈",
  충적층: "충적토",
  충적토: "충적토",
  풍화토: "풍화토",
  잔류토: "풍화토",
  점성토: "점토",
  점토: "점토",
  실트: "실트",
  사질토: "모래",
  모래: "모래",
  역질토: "자갈",
  자갈: "자갈",
}

const SOIL_DETAIL_COLOR: Record<string, string> = {
  토사: "#8b7355",
  매립토: "#9a7b59",
  "매립 점토": "#84664d",
  "매립 사질토": "#a17d55",
  "매립 자갈": "#6f5c4e",
  붕적토: "#80694f",
  퇴적토: "#a08863",
  충적토: "#8d805c",
  풍화토: "#a56f3f",
  퇴적점토: "#74604c",
  "퇴적 사질토": "#b99054",
  퇴적자갈: "#68584a",
  점토: "#6f5b49",
  실트: "#9c8b74",
  모래: "#b99054",
  자갈: "#68584a",
}

export function normalizeSoilDetailName(raw: string | null | undefined): string | null {
  const key = String(raw ?? "").trim()
  if (!key) return null
  const compactKey = key.replace(/\s+/g, "")
  return SOIL_DETAIL_ALIASES[key] ?? SOIL_DETAIL_ALIASES[compactKey] ?? null
}

export function layerGroupForSoilType(soilType: string | null | undefined): string {
  if (normalizeSoilDetailName(soilType)) return "soil"
  if (soilType === "풍화암") return "weathered_rock"
  if (soilType === "연암") return "soft_rock"
  if (soilType === "보통암") return "normal_rock"
  if (soilType === "경암") return "hard_rock"
  if (soilType === "미분류") return "unknown"
  return "unknown"
}

export function uniqueSoilDetails(borehole: Borehole): string[] {
  const details: string[] = []
  for (const stratum of borehole.strata || []) {
    const detail = normalizeSoilDetailName(stratum.soil_type)
    if (detail && !details.includes(detail)) details.push(detail)
  }
  return details
}

export function soilDetailSwatchStyle(detail: string, colorOverride?: string): React.CSSProperties {
  return { background: colorOverride ?? soilDetailColor(detail) }
}

export function soilDetailColor(detail: string | null | undefined): string {
  return SOIL_DETAIL_COLOR[String(detail ?? "")] ?? SOIL_DETAIL_COLOR["토사"]
}
