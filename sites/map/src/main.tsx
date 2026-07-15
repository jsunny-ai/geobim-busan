import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

// StrictMode 제거 — Cesium viewer가 StrictMode double-invoke 시
// destroy() 후 재생성 과정에서 타일 요청이 취소되어 지도가 표시되지 않음
createRoot(document.getElementById("root")!).render(<App />)
