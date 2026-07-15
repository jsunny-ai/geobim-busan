import assert from "node:assert/strict"
import test from "node:test"

import {
  effectiveSoilThickness,
  soilAbsenceRadii,
  soilPresenceWeightFromSigned,
} from "../src/lib/soilPinchout.ts"

test("confirmed no-soil produces an exact zero shared-contact thickness", () => {
  assert.equal(soilPresenceWeightFromSigned(-1), 0)
  assert.equal(soilPresenceWeightFromSigned(0), 0)
  assert.equal(effectiveSoilThickness(24, -1), 0)
  assert.equal(effectiveSoilThickness(24, 0), 0)
})

test("soil transition is smooth, monotonic, and returns to full thickness", () => {
  const signed = [0, 0.25, 0.5, 0.75, 1]
  const weights = signed.map(soilPresenceWeightFromSigned)
  assert.deepEqual(weights, [0, 0.15625, 0.5, 0.84375, 1])
  for (let index = 1; index < weights.length; index++) {
    assert.ok(weights[index] > weights[index - 1])
  }
  assert.equal(effectiveSoilThickness(18, 1), 18)
})

test("project 9708 BH-3 keeps a local exposure core before the nearest soil hole", () => {
  // BH-3: weathered rock GL 0-24 m; nearest soil-bearing hole: 39.6 m.
  const nearestSoilM = 39.6
  const radii = soilAbsenceRadii(nearestSoilM, 80, 3.6)
  assert.ok(Math.abs(radii.coreRadiusM - 11.88) < 1e-9)
  assert.ok(Math.abs(radii.transitionRadiusM - 19.8) < 1e-9)
  assert.ok(radii.coreRadiusM < radii.transitionRadiusM)
  assert.ok(radii.transitionRadiusM < nearestSoilM)
})
