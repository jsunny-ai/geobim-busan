import assert from "node:assert/strict"
import test from "node:test"

import {
  createExactGroundwaterSurface,
  groundwaterHeadElevation,
} from "../src/lib/groundwaterSurface.ts"
import { groundwaterObservationsFromBoreholes, meanDepthBelowGroundM } from "../src/lib/groundwaterData.ts"
import { buildGroundwaterGeometry } from "../src/lib/groundwaterGeometry.ts"
import { createLocalProjection } from "../src/lib/projection.ts"

test("groundwater head elevation uses collar elevation minus measured depth", () => {
  assert.equal(groundwaterHeadElevation(107.35, 4.2), 103.14999999999999)
})

test("authoritative surface passes exactly through every off-grid observation", () => {
  const anchors = [
    { x: 127.00123, y: 37.50117, headElevationM: 101.25 },
    { x: 127.00491, y: 37.50283, headElevationM: 97.8 },
    { x: 127.00307, y: 37.50649, headElevationM: 104.125 },
    { x: 127.00813, y: 37.50431, headElevationM: 99.45 },
  ]
  const surface = createExactGroundwaterSurface(anchors)

  for (const anchor of anchors) {
    assert.equal(surface.evaluate(anchor.x, anchor.y), anchor.headElevationM)
  }
  assert.deepEqual(surface.diagnose(), {
    observationCount: 4,
    maxAbsObservationErrorM: 0,
    meanAbsObservationErrorM: 0,
    constraintPassed: true,
    toleranceM: 1e-6,
  })
})

test("changing interpolation power never changes observation elevations", () => {
  const anchors = [
    { x: 0.13, y: 0.27, headElevationM: 12 },
    { x: 0.71, y: 0.62, headElevationM: 30 },
    { x: 0.46, y: 0.89, headElevationM: -4 },
  ]
  for (const power of [0.5, 1, 2, 4, 8]) {
    const surface = createExactGroundwaterSurface(anchors, power)
    for (const anchor of anchors) {
      assert.equal(surface.evaluate(anchor.x, anchor.y), anchor.headElevationM)
    }
  }
})

test("water cap can hold non-anchor groundwater at sea level instead of terrain clearance", () => {
  const geometry = buildGroundwaterGeometry(
    [
      { x: 0.1, y: 0.1, headElevationM: 10 },
      { x: 0.9, y: 0.1, headElevationM: 10 },
      { x: 0.5, y: 0.9, headElevationM: 10 },
    ],
    [0, 0, 1, 1],
    2,
    8,
    50,
    undefined,
    () => 5,
    0.05,
    (x) => x > 0.5 ? 0 : null,
  )
  assert.ok(geometry)
  assert.ok(geometry.constraintDiagnostic.waterSurfaceCapCount > 0)
})

test("groundwater remains continuous across the coastline while geology is masked separately", () => {
  const anchors = [
    { x: 0.2, y: 0.2, headElevationM: 10 },
    { x: 0.8, y: 0.2, headElevationM: 10 },
    { x: 0.5, y: 0.8, headElevationM: 10 },
  ]
  const continuous = buildGroundwaterGeometry(anchors, [0, 0, 1, 1], 2, 8)
  const incorrectlyCoastalClipped = buildGroundwaterGeometry(
    anchors,
    [0, 0, 1, 1],
    2,
    8,
    50,
    undefined,
    undefined,
    0.05,
    undefined,
    (lng) => lng < 0.5,
  )

  assert.ok(continuous)
  assert.ok(incorrectlyCoastalClipped)
  assert.equal(continuous.constraintDiagnostic.coastalExcludedCellCount, 0)
  assert.ok(continuous.topIndexCount > incorrectlyCoastalClipped.topIndexCount)
  assert.ok(incorrectlyCoastalClipped.constraintDiagnostic.coastalExcludedCellCount > 0)
})

test("equal duplicate XY is deduplicated without changing its hard value", () => {
  const surface = createExactGroundwaterSurface([
    { x: 1, y: 2, headElevationM: 3, observationId: 10 },
    { x: 1, y: 2, headElevationM: 3, observationId: 11 },
  ])
  assert.equal(surface.anchors.length, 1)
  assert.equal(surface.evaluate(1, 2), 3)
})

test("conflicting values at the same XY are rejected instead of averaged", () => {
  assert.throws(
    () => createExactGroundwaterSurface([
      { x: 1, y: 2, headElevationM: 3 },
      { x: 1, y: 2, headElevationM: 4 },
    ]),
    /Conflicting groundwater observations/,
  )
})

test("missing groundwater remains unobserved and never becomes a zero anchor", () => {
  const observations = groundwaterObservationsFromBoreholes([
    {
      id: "missing", project_id: "1", name: "BH-1", longitude: 127, latitude: 37,
      elevation: 100, strata: [{ soil_type: "soil", depth_top: 0, depth_bottom: 10, raw_text: "{'지하수위': 'N/A'}" }],
    },
    {
      id: "observed", project_id: "1", name: "BH-2", longitude: 127.1, latitude: 37.1,
      elevation: 105, groundwater_depth_bgl_m: 4,
      strata: [{ soil_type: "soil", depth_top: 0, depth_bottom: 10 }],
    },
  ])
  assert.equal(observations.length, 1)
  assert.equal(observations[0].boreholeId, "observed")
  assert.equal(observations[0].headElevationM, 101)
})

test("groundwater mesh reports zero anchor error and embeds anchor axes", () => {
  const anchors = [
    { x: 127.00123, y: 37.50117, headElevationM: 101.25 },
    { x: 127.00491, y: 37.50283, headElevationM: 97.8 },
    { x: 127.00307, y: 37.50649, headElevationM: 104.125 },
  ]
  const geometry = buildGroundwaterGeometry(anchors, [127, 37.5, 127.01, 37.51], 2, 12)
  assert.ok(geometry)
  assert.equal(geometry.diagnostic.maxAbsObservationErrorM, 0)
  assert.equal(geometry.diagnostic.constraintPassed, true)
  assert.ok(geometry.indices.length > 0)
  const projection = createLocalProjection([127, 37.5, 127.01, 37.51], 2)
  for (const anchor of anchors) {
    const expected = projection.lngLatToModel(anchor.x, anchor.y)
    let embedded = false
    for (let index = 0; index < geometry.positions.length; index += 3) {
      if (
        Math.abs(geometry.positions[index] - expected.x) < 1e-5 &&
        Math.abs(geometry.positions[index + 1] - anchor.headElevationM * projection.metersToModel) < 1e-5 &&
        Math.abs(geometry.positions[index + 2] - expected.z) < 1e-5
      ) {
        embedded = true
        break
      }
    }
    assert.equal(embedded, true, "every observation must be an explicit rendered mesh vertex")
  }
})

test("a terrain trend never changes anchor elevations", () => {
  const anchors = [
    { x: 0, y: 0, headElevationM: 10 },
    { x: 10, y: 0, headElevationM: 12 },
    { x: 0, y: 10, headElevationM: 8 },
  ]
  // Deliberately not flat/trivial, to make sure the exact branch really is
  // evaluated independently of the trend shape.
  const trendAt = (x: number, y: number) => 100 + x * 2 + y * 3
  const surface = createExactGroundwaterSurface(anchors, 2, trendAt)
  for (const anchor of anchors) {
    assert.equal(surface.evaluate(anchor.x, anchor.y), anchor.headElevationM)
  }
  assert.deepEqual(surface.diagnose(), {
    observationCount: 3,
    maxAbsObservationErrorM: 0,
    meanAbsObservationErrorM: 0,
    constraintPassed: true,
    toleranceM: 1e-6,
  })
})

test("far from every anchor, IDW settles on the trend plus the mean anchor residual", () => {
  // IDW's far-field limit is the trend plus the *average* anchor residual,
  // not the bare trend (weights become ~equal once distance dwarfs anchor
  // spacing, so it degenerates to a plain average of residuals). In
  // production, meanDepthBelowGroundM is deliberately chosen so this mean
  // residual is ~0 for the real data (see groundwaterData.ts); this test
  // uses an arbitrary flat trend, so the mean residual is not zero and must
  // be accounted for explicitly.
  const anchors = [
    { x: 0, y: 0, headElevationM: 10 },
    { x: 1, y: 0, headElevationM: 12 },
    { x: 0, y: 1, headElevationM: 8 },
  ]
  const trend = 500
  const trendAt = () => trend
  const surface = createExactGroundwaterSurface(anchors, 2, trendAt)
  const meanResidual = anchors.reduce((sum, a) => sum + (a.headElevationM - trend), 0) / anchors.length
  const far = surface.evaluate(100000, 100000)
  assert.ok(
    Math.abs(far - (trend + meanResidual)) < 0.01,
    `expected value near trend + mean residual (${trend + meanResidual}), got ${far}`,
  )
})

test("omitting the trend reproduces the original plain-IDW behavior exactly", () => {
  const anchors = [
    { x: 127.00123, y: 37.50117, headElevationM: 101.25 },
    { x: 127.00491, y: 37.50283, headElevationM: 97.8 },
    { x: 127.00307, y: 37.50649, headElevationM: 104.125 },
  ]
  const withoutTrendArg = createExactGroundwaterSurface(anchors, 2)
  const withUndefinedTrend = createExactGroundwaterSurface(anchors, 2, undefined)
  const probe = { x: 127.0035, y: 37.504 }
  assert.equal(withUndefinedTrend.evaluate(probe.x, probe.y), withoutTrendArg.evaluate(probe.x, probe.y))
})

test("a non-finite trend value is rejected instead of silently propagating NaN", () => {
  const anchors = [
    { x: 0, y: 0, headElevationM: 10 },
    { x: 1, y: 0, headElevationM: 12 },
    { x: 0, y: 1, headElevationM: 8 },
  ]
  const surface = createExactGroundwaterSurface(anchors, 2, () => NaN)
  assert.throws(() => surface.evaluate(5, 5), /finite elevation/)
})

test("meanDepthBelowGroundM averages the observed depth-to-water", () => {
  const observations = groundwaterObservationsFromBoreholes([
    {
      id: "a", project_id: "1", name: "BH-A", longitude: 127, latitude: 37,
      elevation: 100, groundwater_depth_bgl_m: 4, strata: [],
    },
    {
      id: "b", project_id: "1", name: "BH-B", longitude: 127.1, latitude: 37.1,
      elevation: 105, groundwater_depth_bgl_m: 6, strata: [],
    },
  ])
  assert.equal(meanDepthBelowGroundM(observations), 5)
})

test("meanDepthBelowGroundM returns 0 for an empty observation set", () => {
  assert.equal(meanDepthBelowGroundM([]), 0)
})

test("buildGroundwaterGeometry honors anchor elevations exactly even with a trend supplied", () => {
  const anchors = [
    { x: 127.001, y: 37.501, headElevationM: 100 },
    { x: 127.009, y: 37.501, headElevationM: 102 },
    { x: 127.005, y: 37.509, headElevationM: 98 },
  ]
  const bbox: [number, number, number, number] = [127, 37.5, 127.01, 37.51]
  const trendAt = (lng: number) => 50 + (lng - 127) * 1000
  const geometry = buildGroundwaterGeometry(anchors, bbox, 2, 12, 60, trendAt)
  assert.ok(geometry)
  assert.equal(geometry.diagnostic.maxAbsObservationErrorM, 0)
  assert.equal(geometry.diagnostic.constraintPassed, true)
})

test("the mesh now extends past the observations' convex hull (no hard hull clipping)", () => {
  const anchors = [
    // A tight triangle in the corner of a much larger bbox.
    { x: 127.001, y: 37.501, headElevationM: 100 },
    { x: 127.002, y: 37.501, headElevationM: 101 },
    { x: 127.0015, y: 37.502, headElevationM: 99 },
  ]
  const bbox: [number, number, number, number] = [126.9, 37.4, 127.1, 37.6]
  const geometry = buildGroundwaterGeometry(anchors, bbox, 2, 12)
  assert.ok(geometry)
  const projection = createLocalProjection(bbox, 2)
  const farCorner = projection.lngLatToModel(bbox[0], bbox[1])
  let foundNearFarCorner = false
  for (let index = 0; index < geometry.positions.length; index += 3) {
    if (
      Math.abs(geometry.positions[index] - farCorner.x) < 0.05 &&
      Math.abs(geometry.positions[index + 2] - farCorner.z) < 0.05
    ) {
      foundNearFarCorner = true
      break
    }
  }
  assert.equal(foundNearFarCorner, true, "mesh must cover area far outside the anchors' convex hull")
})

test("groundwater geometry is a closed solid down to the model base", () => {
  const anchors = [
    { x: 127.001, y: 37.501, headElevationM: 100 },
    { x: 127.009, y: 37.501, headElevationM: 102 },
    { x: 127.005, y: 37.509, headElevationM: 98 },
  ]
  const bbox: [number, number, number, number] = [127, 37.5, 127.01, 37.51]
  const depthBelowMSL = 60
  const geometry = buildGroundwaterGeometry(anchors, bbox, 2, 12, depthBelowMSL)
  assert.ok(geometry)

  const projection = createLocalProjection(bbox, 2)
  const bottomY = -depthBelowMSL * projection.metersToModel
  const yValues = Array.from(
    { length: geometry.positions.length / 3 },
    (_, index) => geometry.positions[index * 3 + 1],
  )
  const bottomVertices = yValues.filter((y) => Math.abs(y - bottomY) < 1e-5)

  assert.ok(bottomVertices.length > 2, "solid must contain a bottom cap")
  assert.ok(
    geometry.indices.length > bottomVertices.length * 3,
    "solid must contain top, bottom and boundary-side triangles",
  )
})

test("non-anchor groundwater vertices are capped below authoritative terrain", () => {
  const anchors = [
    { x: 0, y: 0, headElevationM: 95 },
    { x: 1, y: 0, headElevationM: 95 },
    { x: 0, y: 1, headElevationM: 95 },
  ]
  const terrainAt = () => 90
  const geometry = buildGroundwaterGeometry(
    anchors,
    [0, 0, 1, 1],
    2,
    8,
    60,
    undefined,
    terrainAt,
    0.05,
  )
  assert.ok(geometry)
  assert.ok(geometry.constraintDiagnostic.terrainCapCount > 0)
  assert.ok(geometry.constraintDiagnostic.maxTerrainExcessBeforeCapM > 0)
  assert.equal(geometry.constraintDiagnostic.anchorAboveTerrainCount, 3)

  const projection = createLocalProjection([0, 0, 1, 1], 2)
  const anchorModelPoints = anchors.map((anchor) => projection.lngLatToModel(anchor.x, anchor.y))
  const topVertexCount = geometry.positions.length / 6
  const capModelY = 89.95 * projection.metersToModel
  for (let index = 0; index < topVertexCount; index++) {
    const x = geometry.positions[index * 3]
    const z = geometry.positions[index * 3 + 2]
    const isAnchor = anchorModelPoints.some(
      (point) => Math.abs(x - point.x) < 1e-5 && Math.abs(z - point.z) < 1e-5,
    )
    if (!isAnchor) assert.ok(geometry.positions[index * 3 + 1] <= capModelY + 1e-5)
  }
})

test("display cap mode lowers above-terrain anchor vertices without changing diagnostics", () => {
  const anchors = [
    { x: 0, y: 0, headElevationM: 95 },
    { x: 1, y: 0, headElevationM: 95 },
    { x: 0, y: 1, headElevationM: 95 },
  ]
  const bbox: [number, number, number, number] = [0, 0, 1, 1]
  const geometry = buildGroundwaterGeometry(
    anchors,
    bbox,
    2,
    8,
    60,
    undefined,
    () => 90,
    0.05,
    undefined,
    undefined,
    true,
  )
  assert.ok(geometry)
  assert.equal(geometry.diagnostic.maxAbsObservationErrorM, 0)
  assert.equal(geometry.constraintDiagnostic.anchorAboveTerrainCount, 3)
  assert.equal(geometry.constraintDiagnostic.displayCappedAnchorCount, 3)

  const projection = createLocalProjection(bbox, 2)
  const capModelY = 89.95 * projection.metersToModel
  for (const anchor of anchors) {
    const expected = projection.lngLatToModel(anchor.x, anchor.y)
    let capped = false
    for (let index = 0; index < geometry.positions.length; index += 3) {
      if (
        Math.abs(geometry.positions[index] - expected.x) < 1e-5 &&
        Math.abs(geometry.positions[index + 1] - capModelY) < 1e-5 &&
        Math.abs(geometry.positions[index + 2] - expected.z) < 1e-5
      ) {
        capped = true
        break
      }
    }
    assert.equal(capped, true, "display geometry should cap protruding observation vertices")
  }
})
