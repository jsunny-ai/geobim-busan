import assert from "node:assert/strict"
import test from "node:test"

import {
  createVerticalPlane,
  getSectionAzimuth,
  getSectionLengthM,
  getSectionNormal,
  isValidSectionLine,
  modelOffsetFromMeters,
} from "../src/lib/sectionPlane.ts"
import { DEFAULT_SECTION_FLIPPED } from "../src/lib/sectionDefaults.ts"

const close = (actual: number, expected: number, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)

test("rejects a zero-length section", () => {
  assert.equal(isValidSectionLine({ x: 1, z: 2 }, { x: 1, z: 2 }), false)
  assert.equal(isValidSectionLine({ x: 0, z: 0 }, { x: 0.02, z: 0 }), true)
})

test("creates horizontal normals and flips them", () => {
  const normal = getSectionNormal({ x: 0, z: 0 }, { x: 1, z: 0 })
  close(normal.x, 0)
  close(normal.y, 0)
  close(normal.z, 1)

  const flipped = getSectionNormal({ x: 0, z: 0 }, { x: 1, z: 0 }, true)
  close(flipped.x, -normal.x)
  close(flipped.z, -normal.z)
})

test("uses the reversed clipping direction by default", () => {
  assert.equal(DEFAULT_SECTION_FLIPPED, true)
})

test("moves the clipping plane along its normal", () => {
  const plane = createVerticalPlane({ x: -1, z: 0 }, { x: 1, z: 0 }, 2)
  close(plane.distanceToPoint({ x: 0, y: 0, z: 2 } as any), 0)
})

test("reports cardinal azimuths", () => {
  close(getSectionAzimuth({ x: 0, z: 0 }, { x: 0, z: -1 }), 0)
  close(getSectionAzimuth({ x: 0, z: 0 }, { x: 1, z: 0 }), 90)
  close(getSectionAzimuth({ x: 0, z: 0 }, { x: 0, z: 1 }), 180)
  close(getSectionAzimuth({ x: 0, z: 0 }, { x: -1, z: 0 }), 270)
})

test("converts model distance and metre offsets", () => {
  close(getSectionLengthM({ x: 0, z: 0 }, { x: 2, z: 0 }, 0.01), 200)
  close(modelOffsetFromMeters(25, 0.01), 0.25)
})
