// =============================================================================

import { apiUrl } from "@shared/urls"
// terrain.ts — 지형/타일 공통 유틸 (step2 / step3 공유)
//
// - lngToWorldX / latToWorldY : Web Mercator 타일 좌표
// - buildAreaCanvas           : V-World 타일 합성 (layer 배열 순서대로 오버레이)
// - idwGrid                   : IDW(역거리가중) 보간
// - buildElevationGrid        : AWS Terrain Tiles → 정제된 표고 그리드
//
// 브라우저 메인 스레드 및 Web Worker 환경을 자동 감지하여 OffscreenCanvas로 동작 지원
// =============================================================================

// ── Web Worker와 메인 스레드 호환 캔버스 및 이미지 생성 헬퍼 ──────
function createCanvas(width: number, height: number): any {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    return canvas
  } else {
    return new OffscreenCanvas(width, height)
  }
}

async function loadImage(src: string): Promise<any> {
  if (typeof document !== "undefined") {
    return new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = src
    })
  } else {
    try {
      const res = await fetch(src)
      if (!res.ok) return null
      const blob = await res.blob()
      return await createImageBitmap(blob)
    } catch {
      return null
    }
  }
}

// ── Web Mercator 타일 좌표 ─────────────────────────────────────────
export function lngToWorldX(lng: number, z: number) {
  return ((lng + 180) / 360) * 256 * Math.pow(2, z)
}
export function latToWorldY(lat: number, z: number) {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z)
}

// ── V-World 타일 합성 → Canvas ──────────────────────────
export async function buildAreaCanvas(
  bbox: [number, number, number, number],
  layers: string[],
  polygon?: { lng: number; lat: number }[],
): Promise<any> {
  const [minLng, minLat, maxLng, maxLat] = bbox
  let zoom = 19
  while (zoom > 10) {
    const txCount =
      Math.floor(lngToWorldX(maxLng, zoom) / 256) -
      Math.floor(lngToWorldX(minLng, zoom) / 256) + 1
    const tyCount =
      Math.floor(latToWorldY(minLat, zoom) / 256) -
      Math.floor(latToWorldY(maxLat, zoom) / 256) + 1
    if (txCount * tyCount <= 100) break
    zoom--
  }

  const wxMin = lngToWorldX(minLng, zoom)
  const wxMax = lngToWorldX(maxLng, zoom)
  const wyMin = latToWorldY(maxLat, zoom)
  const wyMax = latToWorldY(minLat, zoom)
  const txMin = Math.floor(wxMin / 256), txMax = Math.floor(wxMax / 256)
  const tyMin = Math.floor(wyMin / 256), tyMax = Math.floor(wyMax / 256)

  const grid = createCanvas((txMax - txMin + 1) * 256, (tyMax - tyMin + 1) * 256)
  const gctx = grid.getContext('2d')!
  gctx.fillStyle = '#e8e8e8'
  gctx.fillRect(0, 0, grid.width, grid.height)

  for (const layer of layers) {
    const jobs: Promise<void>[] = []
    for (let tx = txMin; tx <= txMax; tx++)
      for (let ty = tyMin; ty <= tyMax; ty++) {
        const url = apiUrl(`/api/v1/tiles/vworld/${layer}/${zoom}/${tx}/${ty}`)
        jobs.push(loadImage(url).then((img) => {
          if (img) gctx.drawImage(img, (tx - txMin) * 256, (ty - tyMin) * 256)
        }))
      }
    await Promise.all(jobs)
  }

  const cropX = wxMin - txMin * 256
  const cropY = wyMin - tyMin * 256
  const cropW = Math.max(1, Math.round(wxMax - wxMin))
  const cropH = Math.max(1, Math.round(wyMax - wyMin))
  const out = createCanvas(cropW, cropH)
  const octx = out.getContext('2d')!
  octx.drawImage(grid, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

  if (polygon && polygon.length > 0) {
    octx.save()
    octx.globalCompositeOperation = 'destination-in'
    octx.beginPath()
    const startWx = lngToWorldX(polygon[0].lng, zoom)
    const startWy = latToWorldY(polygon[0].lat, zoom)
    octx.moveTo(startWx - wxMin, startWy - wyMin)
    for (let i = 1; i < polygon.length; i++) {
      const wx = lngToWorldX(polygon[i].lng, zoom)
      const wy = latToWorldY(polygon[i].lat, zoom)
      octx.lineTo(wx - wxMin, wy - wyMin)
    }
    octx.closePath()
    octx.fillStyle = '#ffffff'
    octx.fill()
    octx.restore()
  }

  return out
}

// ── IDW(역거리가중) 보간 ───────────────────────────────────────────
export function idwGrid(
  points: { x: number; y: number; z: number }[],
  gx: number[], gy: number[], power = 2,
): number[][] {
  const out: number[][] = []
  for (let j = 0; j < gy.length; j++) {
    const row: number[] = []
    for (let i = 0; i < gx.length; i++) {
      let num = 0, den = 0, exact: number | null = null
      for (const p of points) {
        const dx = gx[i] - p.x, dy = gy[j] - p.y
        const d2 = dx * dx + dy * dy
        if (d2 < 1e-14) { exact = p.z; break }
        const w = 1 / Math.pow(d2, power / 2)
        num += w * p.z; den += w
      }
      row.push(exact !== null ? exact : den > 0 ? num / den : 0)
    }
    out.push(row)
  }
  return out
}

// ── AWS Terrain Tiles → 정제된 표고 그리드 ─────────────────────────
export async function buildElevationGrid(
  bbox: [number, number, number, number],
  N: number,
  axes?: { gx: number[]; gy: number[] },
): Promise<{
  elevGrid: number[][]
  gx: number[]
  gy: number[]
  terrainElevAt: (lng: number, lat: number) => number
}> {
  const [minLng, minLat, maxLng, maxLat] = bbox

  let zoom = 14
  while (zoom > 8) {
    const tx =
      Math.floor(lngToWorldX(maxLng, zoom) / 256) -
      Math.floor(lngToWorldX(minLng, zoom) / 256) + 1
    const ty =
      Math.floor(latToWorldY(minLat, zoom) / 256) -
      Math.floor(latToWorldY(maxLat, zoom) / 256) + 1
    if (tx * ty <= 9) break
    zoom--
  }

  const wxMin = lngToWorldX(minLng, zoom)
  const wxMax = lngToWorldX(maxLng, zoom)
  const wyMin = latToWorldY(maxLat, zoom)
  const wyMax = latToWorldY(minLat, zoom)
  const txMin = Math.floor(wxMin / 256), txMax = Math.floor(wxMax / 256)
  const tyMin = Math.floor(wyMin / 256), tyMax = Math.floor(wyMax / 256)

  const cw = (txMax - txMin + 1) * 256
  const ch = (tyMax - tyMin + 1) * 256
  const cv = createCanvas(cw, ch)
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = 'rgb(128,0,0)'
  ctx.fillRect(0, 0, cw, ch)

  const jobs: Promise<void>[] = []
  for (let tx = txMin; tx <= txMax; tx++)
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const url = apiUrl(`/api/v1/tiles/terrain/${zoom}/${tx}/${ty}`)
      jobs.push(loadImage(url).then((img) => {
        if (img) ctx.drawImage(img, (tx - txMin) * 256, (ty - tyMin) * 256)
      }))
    }
  await Promise.all(jobs)

  const imgData = ctx.getImageData(0, 0, cw, ch)
  const decodeRaw = (px: number, py: number) => {
    const x = Math.max(0, Math.min(cw - 1, Math.round(px)))
    const y = Math.max(0, Math.min(ch - 1, Math.round(py)))
    const idx = (y * cw + x) * 4
    const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2]
    return r * 256 + g + b / 256 - 32768
  }
  const pxAt = (worldX: number) => worldX - txMin * 256
  const pyAt = (worldY: number) => worldY - tyMin * 256

  const clip = (v: number) =>
    !Number.isFinite(v) || v < -30 || v > 2000 ? NaN : v

  const gx = axes?.gx?.length ? axes.gx : Array.from({ length: N }, (_, i) => minLng + (maxLng - minLng) * i / (N - 1))
  const gy = axes?.gy?.length ? axes.gy : Array.from({ length: N }, (_, j) => minLat + (maxLat - minLat) * j / (N - 1))
  const nx = gx.length
  const ny = gy.length

  let grid: number[][] = []
  for (let j = 0; j < ny; j++) {
    const row: number[] = []
    for (let i = 0; i < nx; i++) {
      row.push(clip(decodeRaw(pxAt(lngToWorldX(gx[i], zoom)), pyAt(latToWorldY(gy[j], zoom)))))
    }
    grid.push(row)
  }

  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (Number.isFinite(grid[j][i])) continue
        let s = 0, c = 0
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const nj = j + dj, ni = i + di
            if (nj >= 0 && nj < ny && ni >= 0 && ni < nx && Number.isFinite(grid[nj][ni])) {
              s += grid[nj][ni]; c++
            }
          }
        if (c > 0) grid[j][i] = s / c
      }
  }
  const validVals = grid.flat().filter(Number.isFinite)
  const meanElev = validVals.length
    ? validVals.reduce((a, b) => a + b, 0) / validVals.length : 0
  grid = grid.map((row) => row.map((v) => (Number.isFinite(v) ? v : meanElev)))

  const smooth = grid.map((r) => r.slice())
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0, c = 0
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const nj = j + dj, ni = i + di
          if (nj >= 0 && nj < ny && ni >= 0 && ni < nx) { s += grid[nj][ni]; c++ }
        }
      smooth[j][i] = s / c
    }
  const elevGrid = smooth

  const terrainElevAt = (lng: number, lat: number) => {
    const v = clip(decodeRaw(pxAt(lngToWorldX(lng, zoom)), pyAt(latToWorldY(lat, zoom))))
    return Number.isFinite(v) ? v : meanElev
  }

  return { elevGrid, gx, gy, terrainElevAt }
}
