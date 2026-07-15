import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { useUpdateBorehole } from "@/features/boreholes/hooks"
import type { Borehole, Stratum } from "@/lib/types"

const SOIL_TYPES = ["토사", "풍화암", "연암", "보통암", "경암"]

interface Props {
  borehole: Borehole
  projectId: number
  onClose: () => void
  onCancel?: () => void
  onPreviewChange?: (borehole: Borehole) => void
  onSaved?: (borehole: Borehole) => void
}

type DraftStratum = Omit<Stratum, "id">

export default function BoreholeEditorPanel({ borehole, projectId, onClose, onCancel, onPreviewChange, onSaved }: Props) {
  const update = useUpdateBorehole(borehole.id, projectId, Boolean(borehole.is_supplementary))

  const [lat, setLat] = useState(String(borehole.latitude))
  const [lng, setLng] = useState(String(borehole.longitude))
  const [elev, setElev] = useState(String(borehole.elevation ?? ""))
  const [strata, setStrata] = useState<DraftStratum[]>(
    borehole.strata.map(({ depth_top, depth_bottom, soil_type, order }) => ({
      depth_top,
      depth_bottom,
      soil_type,
      order,
    })),
  )

  function addStratum() {
    const lastBottom = strata[strata.length - 1]?.depth_bottom ?? 0
    setStrata([...strata, { order: strata.length, depth_top: lastBottom, depth_bottom: lastBottom + 1, soil_type: "토사" }])
  }

  function removeStratum(i: number) {
    setStrata(strata.filter((_, idx) => idx !== i))
  }

  function updateStratum(i: number, field: keyof DraftStratum, value: string | number) {
    setStrata(strata.map((s, idx) => {
      if (idx === i) return { ...s, [field]: value }
      if (field === "depth_bottom" && idx === i + 1) return { ...s, depth_top: Number(value) }
      if (field === "depth_top" && idx === i - 1) return { ...s, depth_bottom: Number(value) }
      return s
    }))
  }

  function buildPreviewBorehole(): Borehole {
    const latitude = parseFloat(lat)
    const longitude = parseFloat(lng)
    const elevation = elev ? parseFloat(elev) : undefined
    const nextStrata = strata.map((s, i) => ({
      ...s,
      id: borehole.strata[i]?.id ?? -(i + 1),
      order: i,
    }))

    return {
      ...borehole,
      latitude,
      longitude,
      elevation: elevation ?? null,
      strata: nextStrata,
    }
  }

  useEffect(() => {
    onPreviewChange?.(buildPreviewBorehole())
  }, [lat, lng, elev, strata])

  async function handleSave() {
    const preview = buildPreviewBorehole()

    await update.mutateAsync({
      latitude: preview.latitude,
      longitude: preview.longitude,
      elevation: preview.elevation ?? undefined,
      strata: strata.map((s, i) => ({ ...s, order: i })),
    })
    onSaved?.(preview)
    onClose()
  }

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto">
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">위도</Label>
          <Input value={lat} onChange={(e) => setLat(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">경도</Label>
          <Input value={lng} onChange={(e) => setLng(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">표고(m)</Label>
          <Input value={elev} onChange={(e) => setElev(e.target.value)} className="h-8 text-xs" />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium">지층</span>
          <Button size="sm" variant="outline" onClick={addStratum} className="h-6 text-xs px-2">
            + 지층 추가
          </Button>
        </div>

        <div className="space-y-1">
          {strata.map((s, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <Input
                value={s.depth_top}
                onChange={(e) => updateStratum(i, "depth_top", parseFloat(e.target.value) || 0)}
                className="h-9 text-xs w-16"
                placeholder="상심도"
              />
              <span className="text-xs text-muted-foreground">~</span>
              <Input
                value={s.depth_bottom}
                onChange={(e) => updateStratum(i, "depth_bottom", parseFloat(e.target.value) || 0)}
                className="h-9 text-xs w-16"
                placeholder="하심도"
              />
              <Select
                value={s.soil_type}
                onChange={(e) => updateStratum(i, "soil_type", e.target.value)}
                className="h-9 text-xs flex-1"
              >
                {SOIL_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => removeStratum(i)}
                className="h-9 w-8 text-destructive hover:text-destructive"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-2 border-t border-border">
        <Button
          onClick={handleSave}
          disabled={update.isPending}
          className="flex-1 h-8 text-xs"
        >
          {update.isPending ? "저장 중…" : "저장"}
        </Button>
        <Button variant="outline" onClick={onCancel ?? onClose} className="h-8 text-xs">
          취소
        </Button>
      </div>
    </div>
  )
}
