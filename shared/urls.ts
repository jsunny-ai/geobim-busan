function localSiteUrl(port: number) {
  if (typeof window === "undefined") return `http://localhost:${port}`
  return `${window.location.protocol}//${window.location.hostname}:${port}`
}

function localApiUrl() {
  if (typeof window === "undefined") return "http://127.0.0.1:9001"
  const hostname = window.location.hostname === "localhost"
    ? "127.0.0.1"
    : window.location.hostname
  return `${window.location.protocol}//${hostname}:9001`
}

export const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? localSiteUrl(6170)
export const PROJECTS_URL = import.meta.env.VITE_PROJECTS_URL ?? localSiteUrl(6171)
export const MAP_URL = import.meta.env.VITE_MAP_URL ?? localSiteUrl(6172)
export const VIEWER_3D_URL = import.meta.env.VITE_VIEWER_3D_URL ?? localSiteUrl(6173)
export const UPLOAD_URL = import.meta.env.VITE_UPLOAD_URL ?? localSiteUrl(6174)
export const SUPPLEMENT_URL = import.meta.env.VITE_SUPPLEMENT_URL ?? localSiteUrl(6175)
export const API_URL = import.meta.env.VITE_API_URL ?? localApiUrl()

export function apiUrl(path: string) {
  const base = API_URL.replace(/\/$/, "")
  const suffix = path.startsWith("/") ? path : `/${path}`
  return `${base}${suffix}`
}
