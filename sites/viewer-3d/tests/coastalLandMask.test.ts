import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { buildCoastalLandMask } from "../src/lib/coastalLandMask.ts"

test("coastal land mask fails open when not configured", () => {
  const mask = buildCoastalLandMask([], { status: "not_configured" })
  assert.equal(mask.configured, false)
  assert.equal(mask.contains(129, 35), true)
})

test("coastal land mask supports polygon holes and multipolygons", () => {
  const mask = buildCoastalLandMask([
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
            [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
          ],
        },
      },
      {
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
          ],
        },
      },
  ], { status: "ok", source: "KHOA" })

  assert.equal(mask.polygonCount, 2)
  assert.equal(mask.contains(3, 3), true)
  assert.equal(mask.contains(1.5, 1.5), false)
  assert.equal(mask.contains(10.5, 10.5), true)
  assert.equal(mask.contains(8, 8), false)
  assert.equal(mask.containsWithBuffer(4.00002, 3, 5), true)
  assert.equal(mask.containsWithBuffer(4.001, 3, 5), false)
})

test("production Busan mask keeps known land and excludes known water", () => {
  const payload = JSON.parse(
    fs.readFileSync("../../backend/data/coastal/busan_land_epsg4326.geojson", "utf-8"),
  )
  const mask = buildCoastalLandMask(payload.features, { status: "ok", source: "KHOA" })

  assert.equal(mask.polygonCount, 1706)
  assert.equal(mask.contains(129.039, 35.115), true, "Busan Station")
  assert.equal(mask.contains(129.158, 35.158), true, "Haeundae")
  assert.equal(mask.contains(129.068, 35.091), true, "Yeongdo")
  assert.equal(mask.contains(128.83, 35.0), true, "Gadeokdo")
  assert.equal(mask.contains(129.3, 35.0), false, "open sea")
  assert.equal(mask.contains(129.05, 35.10), false, "Busan harbor water")
})
