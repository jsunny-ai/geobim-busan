import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

// StrictMode 제거 — Cesium viewer가 double-invoke 시 지도/3D 렌더링 깨짐
createRoot(document.getElementById("root")!).render(<App />)
