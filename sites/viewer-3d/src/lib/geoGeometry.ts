import * as THREE from 'three'

// ── 마칭큐브 삼각형 테이블 (표준 256 케이스) ──────────────────────
const TRI_TABLE: number[][] = [
  [],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],
  [2,8,3,2,10,8,10,9,8],[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],
  [1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],
  [3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],[4,7,8],[4,3,0,7,3,4],
  [0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],
  [9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],[8,4,7,3,11,2],
  [11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],
  [3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],
  [4,7,8,9,0,11,9,11,10,11,0,3],[4,7,11,4,11,9,9,11,10],[9,5,4],
  [9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],[1,2,10,9,5,4],
  [3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],
  [9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],
  [2,1,5,2,5,8,2,8,11,4,8,5],[10,3,11,10,1,3,9,5,4],
  [4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],
  [5,4,8,5,8,10,10,8,11],[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],
  [0,7,8,0,1,7,1,5,7],[1,5,3,3,5,7],[9,7,8,9,5,7,10,1,2],
  [10,1,2,9,5,0,5,3,0,5,7,3],[8,0,2,8,2,5,8,5,7,10,5,2],
  [2,10,5,2,5,3,3,5,7],[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],
  [2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],
  [9,5,8,8,5,7,10,1,3,10,3,11],[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],
  [11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],[11,10,5,7,11,5],[10,6,5],
  [0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],[1,6,5,2,6,1],
  [1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,5,2,6,3,2,8],
  [2,3,11,10,6,5],[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],
  [5,10,6,1,9,2,9,11,2,9,8,11],[6,3,11,6,5,3,5,1,3],
  [0,8,11,0,11,5,0,5,1,5,11,6],[3,11,6,0,3,6,0,6,5,0,5,9],
  [6,5,9,6,9,11,11,9,8],[5,10,6,4,7,8],[4,3,0,4,7,3,6,5,10],
  [1,9,0,5,10,6,8,4,7],[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],
  [1,2,5,5,2,6,3,0,4,3,4,7],[8,4,7,9,0,5,0,6,5,0,2,6],
  [7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],[3,11,2,7,8,4,10,6,5],
  [5,10,6,4,7,2,4,2,0,2,7,11],[0,1,9,4,7,8,2,3,11,5,10,6],
  [9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],[8,4,7,3,11,5,3,5,1,5,11,6],
  [5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],
  [0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],[6,5,9,6,9,11,4,7,9,7,11,9],
  [10,4,9,6,4,10],[4,10,6,4,9,10,0,8,3],[10,0,1,10,6,0,6,4,0],
  [8,3,1,8,1,6,8,6,4,6,1,10],[1,4,9,1,2,4,2,6,4],
  [3,0,8,1,2,9,2,4,9,2,6,4],[0,2,4,4,2,6],[8,3,2,8,2,4,4,2,6],
  [10,4,9,10,6,4,11,2,3],[0,8,2,2,8,11,4,9,10,4,10,6],
  [3,11,2,0,1,6,0,6,4,6,1,10],[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],
  [9,6,4,9,3,6,9,1,3,11,6,3],[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],
  [3,11,6,3,6,0,0,6,4],[6,4,8,11,6,8],[7,10,6,7,8,10,8,9,10],
  [0,7,3,0,10,7,0,9,10,6,7,10],[10,6,7,1,10,7,1,7,8,1,8,0],
  [10,6,7,10,7,1,1,7,3],[1,2,6,1,6,8,1,8,9,8,6,7],
  [2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],[7,8,0,7,0,6,6,0,2],[7,3,2,6,7,2],
  [2,3,11,10,6,8,10,8,9,8,6,7],[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],
  [1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],[11,2,1,11,1,7,10,6,1,6,7,1],
  [8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],[0,9,1,11,6,7],
  [7,8,0,7,0,6,3,11,0,11,6,0],[7,11,6],[7,6,11],[3,0,8,11,7,6],
  [0,1,9,11,7,6],[8,1,9,8,3,1,11,7,6],[10,1,2,6,11,7],
  [1,2,10,3,0,8,6,11,7],[2,9,0,2,10,9,6,11,7],
  [6,11,7,2,10,3,10,8,3,10,9,8],[7,2,3,6,2,7],[7,0,8,7,6,0,6,2,0],
  [2,7,6,2,3,7,0,1,9],[1,6,2,1,8,6,1,9,8,8,7,6],[10,7,6,10,1,7,1,3,7],
  [10,7,6,1,7,10,1,8,7,1,0,8],[0,3,7,0,7,10,0,10,9,6,10,7],
  [7,6,10,7,10,8,8,10,9],[6,8,4,11,8,6],[3,6,11,3,0,6,0,4,6],
  [8,6,11,8,4,6,9,0,1],[9,4,6,9,6,3,9,3,1,11,3,6],[6,8,4,6,11,8,2,10,1],
  [1,2,10,3,0,11,0,6,11,0,4,6],[4,11,8,4,6,11,0,2,9,2,10,9],
  [10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],[8,2,3,8,4,2,4,6,2],[0,4,2,4,6,2],
  [1,9,0,2,3,4,2,4,6,4,3,8],[1,9,4,1,4,2,2,4,6],
  [8,1,3,8,6,1,8,4,6,6,10,1],[10,1,0,10,0,6,6,0,4],
  [4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],[10,9,4,6,10,4],[4,9,5,7,6,11],
  [0,8,3,4,9,5,11,7,6],[5,0,1,5,4,0,7,6,11],
  [11,7,6,8,3,4,3,5,4,3,1,5],[9,5,4,10,1,2,7,6,11],
  [6,11,7,1,2,10,0,8,3,4,9,5],[7,6,11,5,4,10,4,2,10,4,0,2],
  [3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],[7,2,3,7,6,2,5,4,9],
  [9,5,4,0,8,6,0,6,2,6,8,7],[3,6,2,3,7,6,1,5,0,5,4,0],
  [6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],[9,5,4,10,1,6,1,7,6,1,3,7],
  [1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],
  [4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],
  [7,6,10,7,10,8,5,4,10,4,8,10],[6,9,5,6,11,9,11,8,9],
  [3,6,11,0,6,3,0,5,6,0,9,5],[0,11,8,0,5,11,0,1,5,5,6,11],
  [6,11,3,6,3,5,5,3,1],[1,2,10,9,5,11,9,11,8,11,5,6],
  [0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],
  [11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],[6,11,3,6,3,5,2,10,3,10,5,3],
  [5,8,9,5,2,8,5,6,2,3,8,2],[9,5,6,9,6,0,0,6,2],
  [1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],[1,5,6,2,1,6],
  [1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],[10,1,0,10,0,6,9,5,0,5,6,0],
  [0,3,8,5,6,10],[10,5,6],[11,5,10,7,5,11],[11,5,10,11,7,5,8,3,0],
  [5,11,7,5,10,11,1,9,0],[10,7,5,10,11,7,9,8,1,8,3,1],
  [11,1,2,11,7,1,7,5,1],[0,8,3,1,2,7,1,7,5,7,2,11],
  [9,7,5,9,2,7,9,0,2,2,11,7],[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],
  [2,5,10,2,3,5,3,7,5],[8,2,0,8,5,2,8,7,5,10,2,5],
  [9,0,1,5,10,3,5,3,7,3,10,2],[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],
  [1,3,5,3,7,5],[0,8,7,0,7,1,1,7,5],[9,0,3,9,3,5,5,3,7],[9,8,7,5,9,7],
  [5,8,4,5,10,8,10,11,8],[5,0,4,5,11,0,5,10,11,11,3,0],
  [0,1,9,8,4,10,8,10,11,10,4,5],[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],
  [2,5,1,2,8,5,2,11,8,4,5,8],[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],
  [0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],[9,4,5,2,11,3],
  [2,5,10,3,5,2,3,4,5,3,8,4],[5,10,2,5,2,4,4,2,0],
  [3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],[5,10,2,5,2,4,1,9,2,9,4,2],
  [8,4,5,8,5,3,3,5,1],[0,4,5,1,0,5],[8,4,5,8,5,3,9,0,5,0,3,5],[9,4,5],
  [4,11,7,4,9,11,9,10,11],[0,8,3,4,9,7,9,11,7,9,10,11],
  [1,10,11,1,11,4,1,4,0,7,4,11],[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],
  [4,11,7,9,11,4,9,2,11,9,1,2],[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],
  [11,7,4,11,4,2,2,4,0],[11,7,4,11,4,2,8,3,4,3,2,4],
  [2,9,10,2,7,9,2,3,7,7,4,9],[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],
  [3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],[1,10,2,8,7,4],
  [4,9,1,4,1,7,7,1,3],[4,9,1,4,1,7,0,8,1,8,7,1],[4,0,3,7,4,3],
  [4,8,7],[9,10,8,10,11,8],[3,0,9,3,9,11,11,9,10],
  [0,1,10,0,10,8,8,10,11],[3,1,10,11,3,10],[1,2,11,1,11,9,9,11,8],
  [3,0,9,3,9,11,1,2,9,2,11,9],[0,2,11,8,0,11],[3,2,11],
  [2,3,8,2,8,10,10,8,9],[9,10,2,0,9,2],[2,3,8,2,8,10,0,1,8,1,10,8],
  [1,10,2],[1,3,8,9,1,8],[0,9,1],[0,3,8],[],
]

export interface VoxelCell {
  x0: number
  x1: number
  z0: number
  z1: number
  yTop: number
  yBot: number
}

export function buildBoxesMesh(cells: VoxelCell[]) {
  const positions: number[] = [], indices: number[] = []
  let vb = 0
  const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dw: number) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dw)
    indices.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3); vb += 4
  }
  for (const c of cells) {
    const yt = c.yTop, yb = c.yBot
    if (yt - yb < 1e-7) continue
    const { x0, x1, z0, z1 } = c
    quad(x0, yt, z0, x1, yt, z0, x1, yt, z1, x0, yt, z1)
    quad(x0, yb, z1, x1, yb, z1, x1, yb, z0, x0, yb, z0)
    quad(x0, yb, z0, x1, yb, z0, x1, yt, z0, x0, yt, z0)
    quad(x1, yb, z1, x0, yb, z1, x0, yt, z1, x1, yt, z1)
    quad(x0, yb, z1, x0, yb, z0, x0, yt, z0, x0, yt, z1)
    quad(x1, yb, z0, x1, yb, z1, x1, yt, z1, x1, yt, z0)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices); geo.computeVertexNormals()
  return geo
}

export function smooth3D(src: Float32Array, nx: number, ny: number, nz: number, passes: number) {
  let a: any = src, b: any = new Float32Array(src.length)
  const at = (arr: Float32Array, i: number, j: number, k: number) => {
    // 경계 밖 → 가장 가까운 경계 복셀 값을 반사(clamp)하여 외곽/꼭지점 수축 방지
    const ci = i < 0 ? 0 : i >= nx ? nx - 1 : i
    const cj = j < 0 ? 0 : j >= ny ? ny - 1 : j
    const ck = k < 0 ? 0 : k >= nz ? nz - 1 : k
    return arr[(ck * ny + cj) * nx + ci]
  }
  for (let p = 0; p < passes; p++) {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      b[(k * ny + j) * nx + i] = (at(a, i - 1, j, k) + at(a, i, j, k) + at(a, i + 1, j, k)) / 3
    let temp = a; a = b; b = temp
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      b[(k * ny + j) * nx + i] = (at(a, i, j - 1, k) + at(a, i, j, k) + at(a, i, j + 1, k)) / 3
    temp = a; a = b; b = temp
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      b[(k * ny + j) * nx + i] = (at(a, i, j, k - 1) + at(a, i, j, k) + at(a, i, j, k + 1)) / 3
    temp = a; a = b; b = temp
  }
  return a
}

export function marchingCubes(
  field: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  iso: number,
  nodeWorld: (i: number, j: number, l: number) => [number, number, number]
) {
  const positions: number[] = [], normals: number[] = []
  const OUTSIDE = -1e3
  const at = (i: number, j: number, k: number) => i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? OUTSIDE : field[(k * ny + j) * nx + i]
  const CO = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
  const EV = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
  for (let k = -1; k < nz; k++) for (let j = -1; j < ny; j++) for (let i = -1; i < nx; i++) {
    const cv: number[] = []; let ci = 0
    for (let c = 0; c < 8; c++) { const v = at(i + CO[c][0], j + CO[c][1], k + CO[c][2]); cv.push(v); if (v < iso) ci |= 1 << c }
    const tris = TRI_TABLE[ci]; if (!tris || !tris.length) continue
    const cache: Record<number, { p: number[]; n: number[] }> = {}
    const edgeVert = (e: number) => {
      if (cache[e]) return cache[e]
      const a0 = EV[e][0], b0 = EV[e][1], va = cv[a0], vb = cv[b0]
      let t = (iso - va) / ((vb - va) || 1e-9); if (t < 0) t = 0; else if (t > 1) t = 1
      const ca = CO[a0], cb = CO[b0], ai = i + ca[0], aj = j + ca[1], ak = k + ca[2], bi = i + cb[0], bj = j + cb[1], bk = k + cb[2]
      const pa = nodeWorld(ai, aj, ak), pb = nodeWorld(bi, bj, bk)
      const p = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]
      const gax = at(ai - 1, aj, ak) - at(ai + 1, aj, ak), gay = at(ai, aj - 1, ak) - at(ai, aj + 1, ak), gaz = at(ai, aj, ak - 1) - at(ai, aj, ak + 1)
      const gbx = at(bi - 1, bj, bk) - at(bi + 1, bj, bk), gby = at(bi, bj - 1, bk) - at(bi, bj + 1, bk), gbz = at(bi, bj, bk - 1) - at(bi, bj, bk + 1)
      let nxv = gax + (gbx - gax) * t, nyv = gay + (gby - gay) * t, nzv = gaz + (gbz - gaz) * t
      const len = Math.hypot(nxv, nyv, nzv) || 1
      cache[e] = { p, n: [nxv / len, nyv / len, nzv / len] }; return cache[e]
    }
    for (let t = 0; t < tris.length; t += 3) {
      const v0 = edgeVert(tris[t]), v1 = edgeVert(tris[t + 1]), v2 = edgeVert(tris[t + 2])
      positions.push(v0.p[0], v0.p[1], v0.p[2], v1.p[0], v1.p[1], v1.p[2], v2.p[0], v2.p[1], v2.p[2])
      normals.push(v0.n[0], v0.n[1], v0.n[2], v1.n[0], v1.n[1], v1.n[2], v2.n[0], v2.n[1], v2.n[2])
    }
  }
  return { positions, normals }
}

export function buildSurfaceMesh(
  grid: number[][],
  boxW: number,
  boxD: number,
  mScale: number,
  xGrid?: number[][] | null,
  zGrid?: number[][] | null,
  includeCell?: (i: number, j: number) => boolean,
  gy?: number[] | null,
  gx?: number[] | null,
) {
  const Ny = grid.length, Nx = grid[0].length
  const xAt = (i: number, j: number) => xGrid?.[j]?.[i] ?? (-boxW / 2 + (boxW * i) / (Nx - 1))
  const zAt = (j: number, i: number) => zGrid?.[j]?.[i] ?? (boxD / 2 - (boxD * j) / (Ny - 1))
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []

  let mY0 = 0, mYDiff = 1, useMercatorV = false
  if (gy && gy.length === Ny && Ny >= 2) {
    const mercY = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180)
      return Math.log((1 + s) / (1 - s))
    }
    mY0 = mercY(gy[0])
    const mY1 = mercY(gy[Ny - 1])
    mYDiff = mY1 - mY0
    if (Math.abs(mYDiff) > 1e-12) useMercatorV = true
  }

  let mX0 = 0, mXDiff = 1, useMercatorU = false
  if (gx && gx.length === Nx && Nx >= 2) {
    mX0 = gx[0]
    mXDiff = gx[Nx - 1] - mX0
    if (Math.abs(mXDiff) > 1e-12) useMercatorU = true
  }

  for (let j = 0; j < Ny; j++) {
    let v = j / (Ny - 1)
    if (useMercatorV && gy) {
      const s = Math.sin((gy[j] * Math.PI) / 180)
      v = (Math.log((1 + s) / (1 - s)) - mY0) / mYDiff
    }
    for (let i = 0; i < Nx; i++) {
      let u = i / (Nx - 1)
      if (useMercatorU && gx) {
        u = (gx[i] - mX0) / mXDiff
      }
      positions.push(xAt(i, j), grid[j][i] * mScale, zAt(j, i))
      uvs.push(u, v)
    }
  }
  for (let j = 0; j < Ny - 1; j++) for (let i = 0; i < Nx - 1; i++) {
    if (includeCell && !includeCell(i, j)) continue
    const a = j * Nx + i, b = j * Nx + i + 1, c = (j + 1) * Nx + i, d = (j + 1) * Nx + i + 1
    indices.push(a, b, d, a, d, c)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices); geo.computeVertexNormals()
  return geo
}

// [톱니 경계 완화] 핀치아웃(두 지층이 만나는 소멸 경계)은 마칭스퀘어가 셀 단위로
// 대각선 절단하므로 격자 해상도에서 톱니(지그재그)가 보인다. 두 상수를 올려 완화한다:
//   · SOLID_MESH_SUBDIVISIONS: 메쉬 격자를 더 잘게 재샘플 → 톱니 1개 크기 축소
//   · BOUNDARY_SMOOTH_PASSES : carving 부호장(두께)을 더 평활 → 윤곽이 유선형 곡선화
// 값을 더 올리면 더 매끄러우나 삼각형 수↑(빌드/메모리 비용). 과도한 평활은 얇은
// 렌즈를 침식하므로 4 안팎이 균형점. (필요 시 추가 조정)
export function buildMaskedSurfaceGeometryData(
  surfaceGrid: number[][],
  signedGrid: number[][],
  boxW: number,
  boxD: number,
  mScale: number,
  xGrid?: number[][] | Float32Array[] | any,
  zGrid?: number[][] | Float32Array[] | any,
  yOffsetM = -0.03,
) {
  surfaceGrid = resampleGridBilinear(surfaceGrid, SOLID_MESH_SUBDIVISIONS)
  signedGrid = resampleGridBilinear(signedGrid, SOLID_MESH_SUBDIVISIONS)
  xGrid = xGrid ? resampleGridBilinear(xGrid, SOLID_MESH_SUBDIVISIONS) : xGrid
  zGrid = zGrid ? resampleGridBilinear(zGrid, SOLID_MESH_SUBDIVISIONS) : zGrid

  const Ny = surfaceGrid.length, Nx = surfaceGrid[0].length
  const EPS = 0.001
  const xAt = (i: number, j: number) => {
    if (xGrid && xGrid[j]) return xGrid[j][i]
    return -boxW / 2 + (boxW * i) / (Nx - 1)
  }
  const zAt = (j: number, i: number) => {
    if (zGrid && zGrid[j]) return zGrid[j][i]
    return boxD / 2 - (boxD * j) / (Ny - 1)
  }

  const positions: number[] = []
  const indices: number[] = []
  const addVert = (j: number, i: number) => {
    const idx = positions.length / 3
    positions.push(xAt(i, j), (surfaceGrid[j][i] + yOffsetM) * mScale, zAt(j, i))
    return idx
  }

  for (let j = 0; j < Ny - 1; j++) {
    for (let i = 0; i < Nx - 1; i++) {
      const aOn = signedGrid[j][i] > EPS
      const bOn = signedGrid[j][i + 1] > EPS
      const cOn = signedGrid[j + 1][i] > EPS
      const dOn = signedGrid[j + 1][i + 1] > EPS

      if (aOn && bOn && dOn) {
        const a = addVert(j, i)
        const b = addVert(j, i + 1)
        const d = addVert(j + 1, i + 1)
        indices.push(a, b, d)
      }
      if (aOn && dOn && cOn) {
        const a = addVert(j, i)
        const d = addVert(j + 1, i + 1)
        const c = addVert(j + 1, i)
        indices.push(a, d, c)
      }
    }
  }

  return { positions, indices }
}

const SOLID_MESH_SUBDIVISIONS = 4
const BOUNDARY_SMOOTH_PASSES = 4

function resampleGridBilinear(grid: number[][], factor: number) {
  if (factor <= 1) return grid

  const sourceRows = grid.length
  const sourceCols = grid[0]?.length ?? 0
  if (sourceRows < 2 || sourceCols < 2) return grid

  const targetRows = (sourceRows - 1) * factor + 1
  const targetCols = (sourceCols - 1) * factor + 1

  return Array.from({ length: targetRows }, (_, j) => {
    const sy = j / factor
    const j0 = Math.min(Math.floor(sy), sourceRows - 2)
    const j1 = j0 + 1
    const ty = sy - j0

    return Array.from({ length: targetCols }, (__, i) => {
      const sx = i / factor
      const i0 = Math.min(Math.floor(sx), sourceCols - 2)
      const i1 = i0 + 1
      const tx = sx - i0
      const v00 = grid[j0][i0]
      const v10 = grid[j0][i1]
      const v01 = grid[j1][i0]
      const v11 = grid[j1][i1]
      return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    })
  })
}

function smoothGrid2D(grid: number[][], passes: number) {
  if (passes <= 0) return grid

  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (rows < 3 || cols < 3) return grid

  let current = grid.map((row) => row.slice())
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((row) => row.slice())
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const center = current[j][i]
        const left = current[j][Math.max(0, i - 1)]
        const right = current[j][Math.min(cols - 1, i + 1)]
        const up = current[Math.max(0, j - 1)][i]
        const down = current[Math.min(rows - 1, j + 1)][i]
        next[j][i] = center * 0.5 + (left + right + up + down) * 0.125
      }
    }
    current = next
  }
  return current
}

export function buildOpenLayerGeometryData(
  topGrid: number[][],
  bottomGrid: number[][],
  boxW: number,
  boxD: number,
  mScale: number,
  xGrid?: number[][] | Float32Array[] | any,
  zGrid?: number[][] | Float32Array[] | any,
) {
  topGrid = resampleGridBilinear(topGrid, SOLID_MESH_SUBDIVISIONS)
  bottomGrid = resampleGridBilinear(bottomGrid, SOLID_MESH_SUBDIVISIONS)
  xGrid = xGrid ? resampleGridBilinear(xGrid, SOLID_MESH_SUBDIVISIONS) : xGrid
  zGrid = zGrid ? resampleGridBilinear(zGrid, SOLID_MESH_SUBDIVISIONS) : zGrid

  const Ny = topGrid.length, Nx = topGrid[0].length
  const EPS = 0.001
  const xAt = (i: number, j: number) => {
    if (xGrid && xGrid[j]) return xGrid[j][i]
    return -boxW / 2 + (boxW * i) / (Nx - 1)
  }
  const zAt = (j: number, i: number) => {
    if (zGrid && zGrid[j]) return zGrid[j][i]
    return boxD / 2 - (boxD * j) / (Ny - 1)
  }
  const thick = (j: number, i: number) => topGrid[j][i] - bottomGrid[j][i]

  const positions: number[] = []
  const indices: number[] = []
  const cache = new Map<string, number>()
  const addVert = (key: string, x: number, y: number, z: number) => {
    let idx = cache.get(key)
    if (idx === undefined) {
      idx = positions.length / 3
      positions.push(x, y, z)
      cache.set(key, idx)
    }
    return idx
  }
  const node = (prefix: "t" | "b", j: number, i: number) => {
    const y = prefix === "t" ? topGrid[j][i] : bottomGrid[j][i]
    return addVert(`${prefix}${j}_${i}`, xAt(i, j), y * mScale, zAt(j, i))
  }
  const crossNode = (prefix: "t" | "b", ja: number, ia: number, jb: number, ib: number) => {
    const key = ja < jb || (ja === jb && ia < ib)
      ? `${prefix}c${ja}_${ia}_${jb}_${ib}`
      : `${prefix}c${jb}_${ib}_${ja}_${ia}`
    const ta = thick(ja, ia)
    const tb = thick(jb, ib)
    let t = (EPS - ta) / ((tb - ta) || 1e-12)
    t = Math.max(0, Math.min(1, t))
    const x = xAt(ia, ja) + (xAt(ib, jb) - xAt(ia, ja)) * t
    const z = zAt(ja, ia) + (zAt(jb, ib) - zAt(ja, ia)) * t
    const grid = prefix === "t" ? topGrid : bottomGrid
    const y = grid[ja][ia] + (grid[jb][ib] - grid[ja][ia]) * t
    return addVert(key, x, y * mScale, z)
  }
  const fan = (poly: number[], reverse: boolean) => {
    for (let k = 1; k + 1 < poly.length; k++) {
      const a = poly[0], b = poly[k], c = poly[k + 1]
      if (a === b || b === c || a === c) continue
      if (reverse) indices.push(a, c, b)
      else indices.push(a, b, c)
    }
  }
  for (let j = 0; j < Ny - 1; j++) {
    for (let i = 0; i < Nx - 1; i++) {
      const cs: [number, number][] = [[j, i], [j, i + 1], [j + 1, i + 1], [j + 1, i]]
      const pos = cs.map(([jj, ii]) => thick(jj, ii) > EPS)
      if (!pos.some(Boolean)) continue

      const polyT: number[] = []
      const polyB: number[] = []
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4
        const [j0, i0] = cs[k]
        const [j1, i1] = cs[k2]
        if (pos[k]) {
          polyT.push(node("t", j0, i0))
          polyB.push(node("b", j0, i0))
        }
        if (pos[k] !== pos[k2]) {
          const ct = crossNode("t", j0, i0, j1, i1)
          const cb = crossNode("b", j0, i0, j1, i1)
          polyT.push(ct)
          polyB.push(cb)
        }
      }
      if (polyT.length >= 3) {
        fan(polyT, false)
        fan(polyB, true)
      }
    }
  }

  return { positions, indices }
}

export function buildLayerSolidGeometryData(
  topGrid: number[][],
  bottomGrid: number[][],
  boxW: number,
  boxD: number,
  mScale: number,
  signedGrid?: number[][] | null,
  xGrid?: number[][] | Float32Array[] | any,
  zGrid?: number[][] | Float32Array[] | any,
  hardNegativeGrid?: number[][] | null,
) {
  // ── [v4.1] 핀치아웃 경계 서브셀 클리핑 (마칭 스퀘어) ─────────────────────
  // 기존: 두께>EPS 꼭짓점이 하나라도 있는 셀을 통째로 렌더 → 경계가 격자 셀
  // 단위 계단(지그재그)으로 잘림.
  // 개선: 두께=EPS 등고선과 셀 변의 교차점을 선형보간으로 구해 경계 셀의
  // 폴리곤을 등고선에서 잘라낸다. 두께장이 연속(TPS)이므로 잘린 면은 셀
  // 내부를 지나는 매끄러운 폴리라인이 된다. 교차점은 top=bottom(두께≈0)
  // 위치라 상·하면이 한 정점으로 용접되어 워터타이트가 유지된다.
  topGrid = resampleGridBilinear(topGrid, SOLID_MESH_SUBDIVISIONS)
  bottomGrid = resampleGridBilinear(bottomGrid, SOLID_MESH_SUBDIVISIONS)
  signedGrid = signedGrid ? resampleGridBilinear(signedGrid, SOLID_MESH_SUBDIVISIONS) : signedGrid
  hardNegativeGrid = hardNegativeGrid
    ? resampleGridBilinear(hardNegativeGrid, SOLID_MESH_SUBDIVISIONS)
    : hardNegativeGrid
  // [톱니 완화] 경계 윤곽 결정용 부호장. signed가 있으면(핀치아웃 카빙층) 그것을,
  // 없으면(배경암·연속층) 두께장(top−bottom) 자체를 평활해서 쓴다. 기존엔 null일 때
  // 원시 두께로 셀 단위 절단 → 두 지층이 만나는 소멸 경계가 톱니로 보였다. 두께장을
  // 평활하면 0-등고선(소멸 경계)이 유선형 곡선이 되어 매끄럽게 절단된다.
  const thicknessGrid = topGrid.map((row, j) => row.map((_, i) => topGrid[j][i] - bottomGrid[j][i]))
  let boundaryGrid = smoothGrid2D(signedGrid ?? thicknessGrid, BOUNDARY_SMOOTH_PASSES)
  // 평활화는 경계 모양만 다듬어야 하며, 실측 무토사공 주변의 하드 코어를
  // 침식해서는 안 된다. 코어 마스크를 마지막에 다시 적용한다.
  if (hardNegativeGrid) {
    boundaryGrid = boundaryGrid.map((row, j) =>
      row.map((value, i) => hardNegativeGrid![j][i] >= 0.5 ? Math.min(value, -1) : value),
    )
  }
  xGrid = xGrid ? resampleGridBilinear(xGrid, SOLID_MESH_SUBDIVISIONS) : xGrid
  zGrid = zGrid ? resampleGridBilinear(zGrid, SOLID_MESH_SUBDIVISIONS) : zGrid

  const Ny = topGrid.length, Nx = topGrid[0].length
  const EPS = 0.001
  const xAt = (i: number, j: number) => {
    if (xGrid && xGrid[j]) return xGrid[j][i]
    return -boxW / 2 + (boxW * i) / (Nx - 1)
  }
  const zAt = (j: number, i: number) => {
    if (zGrid && zGrid[j]) return zGrid[j][i]
    return boxD / 2 - (boxD * j) / (Ny - 1)
  }
  const th = (j: number, i: number) => topGrid[j][i] - bottomGrid[j][i]
  // 경계 보간용 부호 있는 두께: 클램프 전 원시장(외곽에서 음수)을 쓰면
  // 0두께 등고선의 셀 내부 위치를 정확히 복원할 수 있다. 없으면 실제 두께 사용
  const sg = (j: number, i: number) => (boundaryGrid ? boundaryGrid[j][i] : th(j, i))

  const positions: number[] = []
  const indices: number[] = []
  const cache = new Map<string, number>()

  const addVert = (key: string, x: number, y: number, z: number) => {
    let idx = cache.get(key)
    if (idx === undefined) {
      idx = positions.length / 3
      positions.push(x, y, z)
      cache.set(key, idx)
    }
    return idx
  }
  const topNode = (j: number, i: number) => addVert(`t${j}_${i}`, xAt(i, j), topGrid[j][i] * mScale, zAt(j, i))
  const botNode = (j: number, i: number) => addVert(`b${j}_${i}`, xAt(i, j), bottomGrid[j][i] * mScale, zAt(j, i))

  // 등고선(두께=EPS) 교차 정점 — 인접 셀이 같은 변을 공유하므로 캐시로 용접
  const crossVert = (ja: number, ia: number, jb: number, ib: number) => {
    const key = ja < jb || (ja === jb && ia < ib) ? `c${ja}_${ia}_${jb}_${ib}` : `c${jb}_${ib}_${ja}_${ia}`
    let idx = cache.get(key)
    if (idx === undefined) {
      // signed장에 부호 변화가 있으면 그것으로(서브셀 정확), 아니면 실제 두께로 보간
      const tha = sg(ja, ia), thb = sg(jb, ib)
      let t = (EPS - tha) / ((thb - tha) || 1e-12)
      t = Math.max(0, Math.min(1, t))
      const x = xAt(ia, ja) + (xAt(ib, jb) - xAt(ia, ja)) * t
      const z = zAt(ja, ia) + (zAt(jb, ib) - zAt(ja, ia)) * t
      const yTop = topGrid[ja][ia] + (topGrid[jb][ib] - topGrid[ja][ia]) * t
      const yBot = bottomGrid[ja][ia] + (bottomGrid[jb][ib] - bottomGrid[ja][ia]) * t
      idx = positions.length / 3
      positions.push(x, ((yTop + yBot) / 2) * mScale, z)
      cache.set(key, idx)
    }
    return idx
  }

  const fan = (poly: number[], reverse: boolean) => {
    for (let k = 1; k + 1 < poly.length; k++) {
      const a = poly[0], b = poly[k], c = poly[k + 1]
      if (a === b || b === c || a === c) continue
      if (reverse) indices.push(a, c, b)
      else indices.push(a, b, c)
    }
  }

  // ── 1. 셀 단위 상·하면 (경계 셀은 등고선 클리핑) ──────────────────────
  for (let j = 0; j < Ny - 1; j++) {
    for (let i = 0; i < Nx - 1; i++) {
      // 꼭짓점 순서: (j,i) → (j,i+1) → (j+1,i+1) → (j+1,i)  — 기존 와인딩 유지
      const cs: [number, number][] = [[j, i], [j, i + 1], [j + 1, i + 1], [j + 1, i]]
      const pos = cs.map(([jj, ii]) => sg(jj, ii) > EPS)
      if (!pos.some(Boolean)) continue

      const polyT: number[] = []
      const polyB: number[] = []
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4
        if (pos[k]) {
          polyT.push(topNode(cs[k][0], cs[k][1]))
          polyB.push(botNode(cs[k][0], cs[k][1]))
        }
        if (pos[k] !== pos[k2]) {
          const cv = crossVert(cs[k][0], cs[k][1], cs[k2][0], cs[k2][1])
          polyT.push(cv)
          polyB.push(cv)
        }
      }
      if (polyT.length >= 3) {
        fan(polyT, false) // 윗면
        fan(polyB, true)  // 아랫면
      }
    }
  }

  // ── 2. 모델 외곽 측면 벽 (경계 변도 교차점까지 부분 벽 생성) ──────────
  const pushQuad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    const tri = (p1: number, p2: number, p3: number) => {
      if (p1 === p2 || p2 === p3 || p1 === p3) return
      indices.push(p1, p2, p3)
    }
    if (flip) { tri(a, d, c); tri(a, c, b) }
    else      { tri(a, b, c); tri(a, c, d) }
  }
  const wallSeg = (jP: number, iP: number, jQ: number, iQ: number, flip: boolean) => {
    const pPos = sg(jP, iP) > EPS
    const qPos = sg(jQ, iQ) > EPS
    if (!pPos && !qPos) return
    // 사각형 (tP, bP, bQ, tQ) — 두께 0 쪽 끝은 교차 정점으로 수렴(삼각형화)
    const cv = pPos !== qPos ? crossVert(jP, iP, jQ, iQ) : -1
    const tP = pPos ? topNode(jP, iP) : cv
    const bP = pPos ? botNode(jP, iP) : cv
    const tQ = qPos ? topNode(jQ, iQ) : cv
    const bQ = qPos ? botNode(jQ, iQ) : cv
    pushQuad(tP, bP, bQ, tQ, flip)
  }
  for (let i = 0; i < Nx - 1; i++) {
    wallSeg(0, i, 0, i + 1, false)            // 상부 경계 (j = 0)
    wallSeg(Ny - 1, i, Ny - 1, i + 1, true)   // 하부 경계 (j = Ny-1)
  }
  for (let j = 0; j < Ny - 1; j++) {
    wallSeg(j, 0, j + 1, 0, true)             // 좌측 경계 (i = 0)
    wallSeg(j, Nx - 1, j + 1, Nx - 1, false)  // 우측 경계 (i = Nx-1)
  }

  return { positions, indices }
}
