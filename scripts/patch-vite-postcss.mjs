#!/usr/bin/env node
/**
 * patch-vite-postcss.mjs
 *
 * Patches Vite's bundled importPostcss() to use __require('postcss') instead
 * of dynamic import('postcss').  The dynamic import fails on Windows when the
 * project path contains '#' (e.g. G:\geobim-stratum subst of C:\antigravity\#1_4_GeoBIM)
 * because the ESM loader treats '#' as a package-import prefix.
 *
 * Run automatically via each site's "postinstall" script after pnpm install.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

// Resolve vite from the site directory (process.cwd() = site root when run via postinstall)
const _require = createRequire(join(process.cwd(), "package.json"))

let viteDir
try {
  viteDir = dirname(_require.resolve("vite/package.json"))
} catch {
  console.warn("[patch-vite-postcss] vite not found in", process.cwd(), "— skipping")
  process.exit(0)
}

const chunksDir = join(viteDir, "dist/node/chunks")

const PATTERN =
  /const importPostcss = createCachedImport\(\(\) => import\('postcss'\)\)/

const REPLACEMENT =
  "const importPostcss = createCachedImport(() => Promise.resolve({ default: __require('postcss') }))"

let files
try {
  files = readdirSync(chunksDir).filter((f) => f.endsWith(".js"))
} catch {
  console.warn("[patch-vite-postcss] chunks dir not found:", chunksDir)
  process.exit(0)
}

let patched = false
for (const file of files) {
  const path = join(chunksDir, file)
  const content = readFileSync(path, "utf-8")
  if (PATTERN.test(content)) {
    writeFileSync(path, content.replace(PATTERN, REPLACEMENT))
    console.log("[patch-vite-postcss] ✓ Patched", file, "in", viteDir)
    patched = true
    break
  }
}

if (!patched) {
  console.log("[patch-vite-postcss] Already patched or pattern not found — no change")
}
