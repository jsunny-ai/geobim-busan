import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const _require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const tailwindConfig = _require("./tailwind.config.cjs")
const tailwindcss = _require("tailwindcss")
const autoprefixer = _require("autoprefixer")

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), autoprefixer()],
    },
  },
  cacheDir: resolve(__dirname, "../../.vite-cache2/auth"),
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@shared": resolve(__dirname, "../../shared"),
    },
  },
  server: { port: 5170, strictPort: true },
})
