import assert from "node:assert/strict"
import test from "node:test"

import {
  boreholeSelectionStorageKey,
  parseStoredBoreholeSelection,
  reconcileBoreholeSelection,
  serializeBoreholeSelection,
} from "../src/lib/boreholeSelection.ts"

test("stores borehole selections separately for each project", () => {
  assert.notEqual(boreholeSelectionStorageKey(10), boreholeSelectionStorageKey(11))
})

test("restores only saved boreholes that still exist", () => {
  const saved = parseStoredBoreholeSelection('["2","missing"]')
  assert.deepEqual([...reconcileBoreholeSelection(saved, ["1", "2", "3"])], ["2"])
})

test("selects every available borehole when no preference has been saved", () => {
  assert.deepEqual([...reconcileBoreholeSelection(null, ["1", "2"])], ["1", "2"])
})

test("preserves an explicitly empty selection", () => {
  const serialized = serializeBoreholeSelection(new Set())
  assert.deepEqual([...reconcileBoreholeSelection(parseStoredBoreholeSelection(serialized), ["1"])], [])
})
