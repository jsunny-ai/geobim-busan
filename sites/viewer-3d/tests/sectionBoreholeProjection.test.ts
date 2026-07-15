import assert from "node:assert/strict"
import test from "node:test"

import {
  projectPointToSection,
  SECTION_BOREHOLE_RIBBON_DEPTH_TEST,
  shouldShowOriginalBoreholeChild,
} from "../src/lib/sectionBoreholeProjection.ts"

const base = {
  start: { x: 0, z: 0 },
  end: { x: 10, z: 0 },
  planeNormal: { x: 0, z: 1 },
  planeConstant: 0,
  maxDistanceModel: 2,
}

test("renders section borehole intervals independently of section-cap depth", () => {
  assert.equal(SECTION_BOREHOLE_RIBBON_DEPTH_TEST, false)
})

test("orthogonally projects a nearby borehole onto the section", () => {
  const projected = projectPointToSection({ ...base, point: { x: 4, y: 3, z: 1.5 } })
  assert.ok(projected)
  assert.deepEqual(projected.point, { x: 4, y: 3, z: 0 })
  assert.equal(projected.signedDistanceModel, 1.5)
  assert.equal(projected.chainageModel, 4)
})

test("rejects a borehole outside the projection distance", () => {
  assert.equal(projectPointToSection({ ...base, point: { x: 4, y: 3, z: 2.01 } }), null)
})

test("rejects a borehole beyond the finite section endpoints", () => {
  assert.equal(projectPointToSection({ ...base, point: { x: 11, y: 3, z: 0 } }), null)
})

test("allows a radius-sized margin at the section endpoints", () => {
  const projected = projectPointToSection({
    ...base,
    point: { x: 10.1, y: 3, z: 0 },
    chainageMarginModel: 0.2,
  })
  assert.ok(projected)
})

test("restores every original borehole child outside section mode", () => {
  assert.equal(shouldShowOriginalBoreholeChild({
    boreholeColumnsVisible: true,
    sectionActive: false,
    clipBoreholes: true,
    isSectionBorehole: false,
    isLabel: false,
    signedDistanceModel: 1,
  }), true)
})

test("shows only retained-side names for non-intersecting boreholes in section mode", () => {
  const baseVisibility = {
    boreholeColumnsVisible: true,
    sectionActive: true,
    clipBoreholes: true,
    isSectionBorehole: false,
    signedDistanceModel: 1,
  }
  assert.equal(shouldShowOriginalBoreholeChild({ ...baseVisibility, isLabel: true }), true)
  assert.equal(shouldShowOriginalBoreholeChild({ ...baseVisibility, isLabel: false }), false)
  assert.equal(shouldShowOriginalBoreholeChild({ ...baseVisibility, isLabel: true, signedDistanceModel: -1 }), false)
})

test("hides originals for a borehole rendered on the section", () => {
  assert.equal(shouldShowOriginalBoreholeChild({
    boreholeColumnsVisible: true,
    sectionActive: true,
    clipBoreholes: true,
    isSectionBorehole: true,
    isLabel: true,
    signedDistanceModel: 0,
  }), false)
})
