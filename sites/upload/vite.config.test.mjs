import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

console.error("CONFIG LOADING - react type:", typeof react)

export default defineConfig({
  plugins: [react()],
  server: { port: 5186, strictPort: true },
})
