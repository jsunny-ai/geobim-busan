import { API_BASE } from "./constants"

export async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path)
}

export async function apiPostForm<T>(path: string, body: FormData): Promise<T> {
  return apiRequest<T>("POST", path, body)
}

export async function apiPost<T>(path: string): Promise<T> {
  return apiRequest<T>("POST", path)
}

export async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>("POST", path, JSON.stringify(body), "application/json")
}

export function apiRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: XMLHttpRequestBodyInit,
  contentType?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(method, `${API_BASE}${path}`, true)
    request.withCredentials = true
    if (contentType) request.setRequestHeader("Content-Type", contentType)

    request.onload = () => {
      const text = request.responseText || "null"
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(text) as T)
        } catch {
          resolve(null as T)
        }
        return
      }

      reject(new Error(parseErrorMessage(request.status, text)))
    }

    request.onerror = () => {
      reject(new Error("API request failed. Check that the backend is running and CORS allows this origin."))
    }

    request.send(body)
  })
}

export function parseErrorMessage(status: number, text: string) {
  let message = `요청 실패 (${status})`
  try {
    const body = JSON.parse(text)
    message = body.detail ?? message
  } catch {
    // Keep status-based message.
  }
  if (
    message.includes("Connect call failed") ||
    message.includes("connection refused") ||
    message.includes("ECONNREFUSED")
  ) {
    return "데이터베이스에 연결할 수 없습니다. PostgreSQL(127.0.0.1:5432)을 먼저 실행한 뒤 다시 시도해 주세요."
  }
  return message
}
