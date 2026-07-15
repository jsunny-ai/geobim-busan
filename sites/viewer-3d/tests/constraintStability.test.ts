import assert from "node:assert/strict"
import test from "node:test"

import {
  analyzeConstraintStability,
  applyConstraintsAtGridNodes,
} from "../src/lib/constraintStability.ts"

test("flags sub-metre constraints for the stable interpolation path", () => {
  const assessment = analyzeConstraintStability([
    { x: 129.0439000, y: 35.1145000, z: 3.7 },
    { x: 129.04390005, y: 35.1145000, z: 3.66 },
    { x: 129.0450000, y: 35.1160000, z: 4.1 },
  ])

  assert.equal(assessment.nearPairCount, 1)
  assert.equal(assessment.conflictingNearPairCount, 1)
  assert.equal(assessment.requiresStableFallback, true)
  assert.ok((assessment.minSeparationM ?? 1) < 0.01)
})

test("reports conflicting constraints at an identical coordinate", () => {
  const assessment = analyzeConstraintStability([
    { x: 129.04, y: 35.11, z: 2 },
    { x: 129.04, y: 35.11, z: 3 },
  ])

  assert.equal(assessment.exactPairCount, 1)
  assert.equal(assessment.conflictingExactPairCount, 1)
})

test("stable fallback preserves every distinct constrained grid node", () => {
  const gx = [129.04, 129.040001, 129.05]
  const gy = [35.11, 35.12]
  const result = applyConstraintsAtGridNodes(
    [[0, 0, 0], [0, 0, 0]],
    gx,
    gy,
    [
      { x: gx[0], y: gy[0], z: 2.5 },
      { x: gx[1], y: gy[0], z: 3.5 },
    ],
  )

  assert.equal(result[0][0], 2.5)
  assert.equal(result[0][1], 3.5)
})
