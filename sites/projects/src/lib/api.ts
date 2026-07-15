import axios from "axios"
import { API_URL, AUTH_URL } from "@shared/urls"

export const api = axios.create({
  baseURL: `${API_URL.replace(/\/$/, "")}/api/v1`,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
})

// 401 → auth 사이트로 리다이렉트
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      window.location.href = AUTH_URL
    }
    return Promise.reject(err)
  },
)
