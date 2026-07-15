import type { CrsOption, ManualLabel, ManualTemplate, PageMode, Tab } from "./types"
import { API_URL } from "@shared/urls"

export const API_BASE = import.meta.env.VITE_API_URL ?? API_URL

export const CRS_OPTIONS: CrsOption[] = [
  { value: "EPSG:5186", label: "GRS80 TM중부원점", kind: "grs80-tm", lon0: 127, falseNorthing: 600000 },
  { value: "EPSG:5187", label: "GRS80 TM동부원점", kind: "grs80-tm", lon0: 129, falseNorthing: 600000 },
  { value: "EPSG:5181", label: "GRS80 TM중부원점(500,000)", kind: "grs80-tm", lon0: 127, falseNorthing: 500000 },
  { value: "EPSG:5183", label: "GRS80 TM동부원점(500,000)", kind: "grs80-tm", lon0: 129, falseNorthing: 500000 },
  { value: "EPSG:4326", label: "WGS84 경위도", kind: "wgs84" },
  { value: "EPSG:5174", label: "Bessel TM중부원점", kind: "server" },
  { value: "EPSG:5176", label: "Bessel TM동부원점", kind: "server" },
]

export const MANUAL_TEMPLATES: { value: ManualTemplate; label: string }[] = [
  { value: "first", label: "첫 페이지 형식" },
  { value: "continuation", label: "연속 페이지 형식" },
]

export const PAGE_MODES: { value: PageMode; label: string }[] = [
  { value: "same", label: "모든 페이지 동일 형식" },
  { value: "split", label: "첫 페이지/연속 페이지 분리" },
]

export const MANUAL_LABELS: { value: ManualLabel; label: string }[] = [
  { value: "project_name", label: "프로젝트명" },
  { value: "borehole_name", label: "시추공명" },
  { value: "coordinates", label: "X/Y 좌표 묶음" },
  { value: "x_coord", label: "X 좌표" },
  { value: "y_coord", label: "Y 좌표" },
  { value: "elevation", label: "표고" },
  { value: "water_level_gl", label: "지하수위 GL" },
  { value: "water_level_el", label: "지하수위 EL" },
  { value: "depth", label: "심도 열" },
  { value: "stratum_name", label: "지층명 열" },
  { value: "crs", label: "기준좌표계" },
]

export const TABS: { value: Tab; label: string }[] = [
  { value: "auto", label: "자동 파싱" },
  { value: "manual", label: "직접 지정" },
  { value: "csv", label: "CSV/엑셀" },
]
