import { API_URL } from "@shared/urls"

const API_BASE = `${API_URL.replace(/\/$/, "")}/api/v1`

export interface LoginError {
  message: string
}

function errorMessage(detail: unknown): string {
  if (typeof detail === "string") return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item
        if (item && typeof item === "object" && "msg" in item) return String(item.msg)
        return JSON.stringify(item)
      })
      .join("\n")
  }
  if (detail && typeof detail === "object" && "msg" in detail) {
    return String((detail as { msg: unknown }).msg)
  }
  return "로그인에 실패했습니다."
}

export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(errorMessage(data.detail))
  }
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  })
}
