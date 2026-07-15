import assert from "node:assert/strict"
import test from "node:test"

import {
  orderSoilDetailOccurrences,
  unclassifiedSoilBottom,
} from "../src/lib/soilDetailOrdering.ts"

const canonical = ["퇴적 사질토", "풍화토"]

test("keeps an observed sandy-soil to weathered-soil sequence", () => {
  const ordered = orderSoilDetailOccurrences([
    { key: "풍화토#1", detail: "풍화토", observedMeanOrder: 0 },
    { key: "퇴적 사질토#1", detail: "퇴적 사질토", observedMeanOrder: 3 },
  ], [["퇴적 사질토#1", "풍화토#1"]], canonical)

  assert.deepEqual(ordered, ["퇴적 사질토#1", "풍화토#1"])
})

test("uses canonical order for units that never coexist in a borehole", () => {
  const ordered = orderSoilDetailOccurrences([
    { key: "풍화토#1", detail: "풍화토", observedMeanOrder: 0 },
    { key: "퇴적 사질토#1", detail: "퇴적 사질토", observedMeanOrder: 4 },
  ], [["풍화토#1"], ["퇴적 사질토#1"]], canonical)

  assert.deepEqual(ordered, ["퇴적 사질토#1", "풍화토#1"])
})

test("leaves unclaimed parent-soil thickness for an unclassified fallback", () => {
  assert.deepEqual(
    unclassifiedSoilBottom([[10, 5]], [[7, 4.98]], 0.05),
    [[7, 5]],
  )
})
