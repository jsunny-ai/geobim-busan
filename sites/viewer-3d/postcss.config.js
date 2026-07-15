import { fileURLToPath } from "url"
import path from "path"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

export default {
  plugins: {
    tailwindcss: { config: path.join(__dirname, "tailwind.config.cjs") },
    autoprefixer: {},
  },
}
