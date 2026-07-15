import { useEffect, useState } from "react"
import { apiUrl } from "@shared/urls"
import { buildCoastalLandMask, type CoastalLandMask } from "@/lib/coastalLandMask"
import type { Bbox } from "@/lib/projection"

const EMPTY_MASK = buildCoastalLandMask([], { status: "not_configured" })

export function useCoastalLandMask(bbox: Bbox | null) {
  const [mask, setMask] = useState<CoastalLandMask>(EMPTY_MASK)
  useEffect(() => {
    if (!bbox) {
      setMask(EMPTY_MASK)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(apiUrl(`/api/v1/coastal-boundaries?bbox=${bbox.join(",")}`))
        if (!response.ok) throw new Error(`coastal boundary response ${response.status}`)
        const payload = await response.json()
        if (cancelled) return
        setMask(buildCoastalLandMask(payload.features ?? [], {
          status: payload.status,
          source: payload.source,
          sourceDate: payload.source_date,
          verticalDatum: payload.vertical_datum,
        }))
      } catch {
        if (!cancelled) setMask(buildCoastalLandMask([], { status: "unavailable" }))
      }
    })()
    return () => { cancelled = true }
  }, [bbox])
  return mask
}
