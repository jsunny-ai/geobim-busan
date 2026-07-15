import assert from "node:assert/strict"
import test from "node:test"

import { createAuthoritativeTerrainGrid } from "../src/lib/authoritativeTerrain.ts"
import { coastalDisplayTerrainElevation } from "../src/lib/coastalDisplayTerrain.ts"
import { buildCoastalLandMask } from "../src/lib/coastalLandMask.ts"
import { buildWaterSurfaceGeometry, seaWaterElevationAt } from "../src/lib/waterSurfaceGeometry.ts"
import { buildWaterSurfaceMask } from "../src/lib/waterSurfaceMask.ts"

const terrain = createAuthoritativeTerrainGrid(
  [0, 1],
  [0, 1],
  [[100, 100], [100, 100]],
)

test("water mask returns configured water elevation only inside polygon", () => {
  const mask = buildWaterSurfaceMask([
    {
      geometry: {
        type: "Polygon",
        coordinates: [[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]]],
      },
      properties: { water_elevation_m: 97 },
    },
  ], terrain)
  assert.equal(mask.featureCount, 1)
  assert.equal(mask.capElevationAt(0.5, 0.5), 97)
  assert.equal(mask.capElevationAt(0.1, 0.1), null)
})

test("water mask falls back to authoritative terrain median", () => {
  const mask = buildWaterSurfaceMask([
    {
      geometry: {
        type: "Polygon",
        coordinates: [[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]]],
      },
      properties: { water_elevation_m: null },
    },
  ], terrain)
  assert.equal(mask.capElevationAt(0.5, 0.5), 100)
})

test("sea water surface is generated outside the coastal land mask", () => {
  const coastalMask = buildCoastalLandMask([
    {
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [0.45, 0], [0.45, 1], [0, 1], [0, 0]]],
      },
    },
  ], { status: "ok" })
  const emptyWaterMask = buildWaterSurfaceMask([], terrain)
  const { geometry, diagnostic } = buildWaterSurfaceGeometry(
    [0, 0, 1, 1],
    terrain,
    emptyWaterMask,
    coastalMask,
    2,
    8,
    0,
  )

  assert.equal(seaWaterElevationAt(coastalMask, 0.8, 0.5), 0)
  assert.equal(seaWaterElevationAt(coastalMask, 0.2, 0.5), null)
  assert.ok(diagnostic.seaCellCount > 0)
  assert.equal(diagnostic.inlandWaterCellCount, 0)
  assert.ok((geometry.getIndex()?.count ?? 0) > 0)
  geometry.dispose()
})

test("coastal display terrain lowers sea-side drape without changing land elevations", () => {
  const coastalMask = buildCoastalLandMask([
    {
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [0.45, 0], [0.45, 1], [0, 1], [0, 0]]],
      },
    },
  ], { status: "ok" })

  assert.equal(coastalDisplayTerrainElevation(0.2, 0.5, 12, coastalMask), 12)
  assert.ok(coastalDisplayTerrainElevation(0.8, 0.5, 12, coastalMask) < 0)
})
