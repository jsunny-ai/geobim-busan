import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCreateBorehole } from "@/features/boreholes/hooks"

const SOIL_OPTIONS = [
  "토사", "매립토", "퇴적토", "풍화토", "풍화암", "연암", "보통암", "리핑암", "경암", "발파암",
]

interface StratumDraft {
  depth_top: number
  depth_bottom: number
  soil_type: string
}

interface Props {
  projectId: number
  onSuccess: () => void
}

export default function ManualBoreholeForm({ projectId, onSuccess }: Props) {
  const create = useCreateBorehole(projectId)

  const [name, setName]   = useState("")
  const [lat,  setLat]    = useState("")
  const [lng,  setLng]    = useState("")
  const [elev, setElev]   = useState("")
  const [strata, setStrata] = useState<StratumDraft[]>([
    { depth_top: 0, depth_bottom: 5, soil_type: "토사" },
  ])
  const [formErr, setFormErr] = useState<string | null>(null)

  function addRow() {
    const lastBot = strata[strata.length - 1]?.depth_bottom ?? 0
    setStrata([...strata, { depth_top: lastBot, depth_bottom: lastBot + 5, soil_type: "풍화암" }])
  }

  function removeRow(i: number) {
    setStrata(strata.filter((_, idx) => idx !== i))
  }

  function updateRow(i: number, field: keyof StratumDraft, value: string | number) {
    setStrata(strata.map((s, idx) => idx === i ? { ...s, [field]: value } : s))
  }

  async function handleSave() {
    setFormErr(null)
    const latitude  = parseFloat(lat)
    const longitude = parseFloat(lng)

    if (!name.trim())     return setFormErr("시추공 이름을 입력하세요.")
    if (isNaN(latitude))  return setFormErr("위도를 올바르게 입력하세요.")
    if (isNaN(longitude)) return setFormErr("경도를 올바르게 입력하세요.")
    if (strata.length === 0) return setFormErr("지층 정보를 1개 이상 입력하세요.")

    for (const s of strata) {
      if (s.depth_bottom <= s.depth_top) return setFormErr("지층 하단 심도는 상단 심도보다 커야 합니다.")
    }

    try {
      await create.mutateAsync({
        project_id: projectId,
        name: name.trim(),
        latitude,
        longitude,
        elevation: elev ? parseFloat(elev) : undefined,
        source_crs: "EPSG:4326",
        is_supplementary: true,   // 직접 입력은 항상 신규 보완
        strata: strata.map(s => ({
          depth_top: s.depth_top,
          depth_bottom: s.depth_bottom,
          soil_type: s.soil_type,
        })),
      })
      // 폼 초기화
      setName(""); setLat(""); setLng(""); setElev("")
      setStrata([{ depth_top: 0, depth_bottom: 5, soil_type: "토사" }])
      onSuccess()
    } catch (e: any) {
      setFormErr(e?.response?.data?.detail ?? e?.message ?? "저장 실패")
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        위치 정보와 지층 구조를 직접 입력하여 시추공을 등록합니다.
      </p>

      {/* 기본 정보 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-muted-foreground font-medium mb-1">시추공 이름 *</label>
          <input
            value={name} onChange={e => setName(e.target.value)}
            placeholder="예) BH-A1"
            className="w-full h-9 rounded-md border border-input bg-background/50 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground font-medium mb-1">위도 *</label>
          <input
            value={lat} onChange={e => setLat(e.target.value)}
            placeholder="37.123456"
            className="w-full h-9 rounded-md border border-input bg-background/50 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground font-medium mb-1">경도 *</label>
          <input
            value={lng} onChange={e => setLng(e.target.value)}
            placeholder="126.123456"
            className="w-full h-9 rounded-md border border-input bg-background/50 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-muted-foreground font-medium mb-1">지표면 표고 (m, 선택)</label>
          <input
            value={elev} onChange={e => setElev(e.target.value)}
            placeholder="예) 24.5"
            className="w-full h-9 rounded-md border border-input bg-background/50 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* 지층 테이블 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">지층 정보 *</span>
          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1 text-xs text-stone-600 hover:text-stone-700 transition-colors"
          >
            <Plus className="h-3 w-3" /> 지층 추가
          </button>
        </div>

        <div className="rounded-lg border border-border/60 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">토질명</th>
                <th className="px-3 py-2 text-left font-medium">상단 (m)</th>
                <th className="px-3 py-2 text-left font-medium">하단 (m)</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {strata.map((s, i) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="px-2 py-1.5">
                    <select
                      value={s.soil_type}
                      onChange={e => updateRow(i, "soil_type", e.target.value)}
                      className="w-full h-7 rounded border border-input bg-background/50 px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {SOIL_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number" step="0.1"
                      value={s.depth_top}
                      onChange={e => updateRow(i, "depth_top", parseFloat(e.target.value))}
                      className="w-full h-7 rounded border border-input bg-background/50 px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number" step="0.1"
                      value={s.depth_bottom}
                      onChange={e => updateRow(i, "depth_bottom", parseFloat(e.target.value))}
                      className="w-full h-7 rounded border border-input bg-background/50 px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {formErr && (
        <p className="text-xs text-destructive">{formErr}</p>
      )}

      <Button
        className="w-full bg-stone-300 hover:bg-stone-400 text-stone-800 font-semibold"
        disabled={create.isPending}
        onClick={handleSave}
      >
        {create.isPending ? "저장 중..." : "시추공 등록"}
      </Button>
    </div>
  )
}
