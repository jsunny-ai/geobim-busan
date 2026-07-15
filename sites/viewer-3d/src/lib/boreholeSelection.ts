const STORAGE_PREFIX = "geobim:viewer3d:enabled-boreholes"

export const boreholeSelectionStorageKey = (projectId: number | null) =>
  `${STORAGE_PREFIX}:${projectId === null ? "standalone" : `project:${projectId}`}`

export const parseStoredBoreholeSelection = (value: string | null): Set<string> | null => {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0))
  } catch {
    return null
  }
}

export const serializeBoreholeSelection = (ids: ReadonlySet<string>) =>
  JSON.stringify([...ids].sort())

export const reconcileBoreholeSelection = (
  saved: ReadonlySet<string> | null,
  availableIds: readonly string[],
) => {
  if (saved === null) return new Set(availableIds)
  return new Set(availableIds.filter((id) => saved.has(id)))
}
