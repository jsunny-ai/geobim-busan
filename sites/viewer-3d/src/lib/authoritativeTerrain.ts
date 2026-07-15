export interface AuthoritativeTerrainGrid {
  gx: number[]
  gy: number[]
  elevationsM: number[][]
  elevationAt(lng: number, lat: number): number
}

function axisSegment(axis: number[], value: number) {
  if (axis.length < 2) return { index: 0, t: 0 }
  if (value <= axis[0]) return { index: 0, t: 0 }
  if (value >= axis[axis.length - 1]) return { index: axis.length - 2, t: 1 }
  let low = 0
  let high = axis.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (axis[middle] <= value) low = middle
    else high = middle
  }
  const span = axis[low + 1] - axis[low]
  return { index: low, t: span === 0 ? 0 : (value - axis[low]) / span }
}

export function createAuthoritativeTerrainGrid(
  gx: number[],
  gy: number[],
  elevationsM: number[][],
): AuthoritativeTerrainGrid {
  if (gx.length < 2 || gy.length < 2 || elevationsM.length !== gy.length) {
    throw new Error("Authoritative terrain grid dimensions are invalid.")
  }
  const gridX = [...gx]
  const gridY = [...gy]
  const gridElevations = elevationsM.map((row) => [...row])
  const elevationAt = (lng: number, lat: number) => {
    const sx = axisSegment(gridX, lng)
    const sy = axisSegment(gridY, lat)
    const z00 = gridElevations[sy.index][sx.index]
    const z10 = gridElevations[sy.index][sx.index + 1]
    const z01 = gridElevations[sy.index + 1][sx.index]
    const z11 = gridElevations[sy.index + 1][sx.index + 1]
    const upper = z00 * (1 - sx.t) + z10 * sx.t
    const lower = z01 * (1 - sx.t) + z11 * sx.t
    return upper * (1 - sy.t) + lower * sy.t
  }
  return {
    gx: gridX,
    gy: gridY,
    elevationsM: gridElevations,
    elevationAt,
  }
}
