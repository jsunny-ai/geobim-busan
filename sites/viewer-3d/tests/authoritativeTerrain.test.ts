import assert from "node:assert/strict"
import test from "node:test"

import { createAuthoritativeTerrainGrid } from "../src/lib/authoritativeTerrain.ts"

test("authoritative terrain evaluates grid nodes and bilinear interior exactly", () => {
  const terrain = createAuthoritativeTerrainGrid(
    [127, 128],
    [37, 38],
    [
      [100, 110],
      [120, 130],
    ],
  )
  assert.equal(terrain.elevationAt(127, 37), 100)
  assert.equal(terrain.elevationAt(128, 38), 130)
  assert.equal(terrain.elevationAt(127.5, 37.5), 115)
})

test("authoritative terrain snapshot is isolated from worker array mutation", () => {
  const gx = [0, 1]
  const gy = [0, 1]
  const elevations = [[10, 20], [30, 40]]
  const terrain = createAuthoritativeTerrainGrid(gx, gy, elevations)
  elevations[0][0] = 999
  gx[0] = -10
  assert.equal(terrain.elevationAt(0, 0), 10)
})
