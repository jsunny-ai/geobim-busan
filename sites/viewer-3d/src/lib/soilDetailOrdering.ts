export type SoilDetailOccurrenceInput = {
  key: string
  detail: string
  observedMeanOrder: number
}

function occurrenceNumber(key: string): number {
  const match = key.match(/#(\d+)$/)
  return match ? Number(match[1]) : 1
}

/**
 * Orders project-wide soil-detail occurrences without inventing a sequence
 * that contradicts an observed borehole. Disconnected units use the canonical
 * geological order as a deterministic fallback.
 */
export function orderSoilDetailOccurrences(
  inputs: SoilDetailOccurrenceInput[],
  observedSequences: string[][],
  canonicalDetails: readonly string[],
): string[] {
  const byKey = new Map(inputs.map((input) => [input.key, input]))
  const outgoing = new Map(inputs.map((input) => [input.key, new Set<string>()]))
  const indegree = new Map(inputs.map((input) => [input.key, 0]))

  for (const sequence of observedSequences) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const upper = sequence[index]
      const lower = sequence[index + 1]
      if (upper === lower || !byKey.has(upper) || !byKey.has(lower)) continue
      const edges = outgoing.get(upper)!
      if (edges.has(lower)) continue
      edges.add(lower)
      indegree.set(lower, (indegree.get(lower) ?? 0) + 1)
    }
  }

  const canonicalRank = new Map(canonicalDetails.map((detail, index) => [detail, index]))
  const compare = (leftKey: string, rightKey: string) => {
    const left = byKey.get(leftKey)!
    const right = byKey.get(rightKey)!
    const rankDelta = (canonicalRank.get(left.detail) ?? canonicalDetails.length)
      - (canonicalRank.get(right.detail) ?? canonicalDetails.length)
    if (rankDelta !== 0) return rankDelta
    const occurrenceDelta = occurrenceNumber(leftKey) - occurrenceNumber(rightKey)
    if (occurrenceDelta !== 0) return occurrenceDelta
    return left.observedMeanOrder - right.observedMeanOrder || leftKey.localeCompare(rightKey)
  }

  const ready = inputs.filter((input) => indegree.get(input.key) === 0).map((input) => input.key).sort(compare)
  const ordered: string[] = []
  while (ready.length > 0) {
    const key = ready.shift()!
    ordered.push(key)
    for (const lower of outgoing.get(key) ?? []) {
      indegree.set(lower, (indegree.get(lower) ?? 0) - 1)
      if (indegree.get(lower) === 0) {
        ready.push(lower)
        ready.sort(compare)
      }
    }
  }

  // Conflicting boreholes can form a cycle. Keep every unit visible, but use
  // canonical order for the unresolved cycle instead of averaging a new order.
  if (ordered.length < inputs.length) {
    const emitted = new Set(ordered)
    ordered.push(...inputs.map((input) => input.key).filter((key) => !emitted.has(key)).sort(compare))
  }
  return ordered
}

export function unclassifiedSoilBottom(
  currentTop: number[][],
  soilBottom: number[][],
  minimumThickness: number,
): number[][] {
  return currentTop.map((row, j) => row.map((top, i) =>
    top - soilBottom[j][i] >= minimumThickness ? soilBottom[j][i] : top,
  ))
}
