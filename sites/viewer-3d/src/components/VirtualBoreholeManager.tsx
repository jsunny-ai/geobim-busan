import { useCallback, useEffect, useMemo, useState } from "react"
import { apiUrl } from "@shared/urls"
import type { Borehole, VirtualBorehole } from "@/lib/types"
import { SOIL_DETAIL_TYPES, layerGroupForSoilType } from "@/lib/soilDetail"

type Row = { depth_top: number; depth_bottom: number; soil_type: string; strata_group?: string }

interface Props {
  projectId: number
  observed: Borehole[]
  virtualBoreholes: VirtualBorehole[]
  isPickingFromScene: boolean
  sceneCopySourceId: string | null
  onStartPickingFromScene: () => void
  onClose: () => void
  onChanged: () => void
}

const soilTypeOptions = [...SOIL_DETAIL_TYPES, "풍화암", "연암", "보통암", "경암", "미분류"]

const panel: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 100, background: "rgba(28,25,23,.42)",
  display: "flex", alignItems: "center", justifyContent: "center",
}
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid #d6d3d1",
  borderRadius: 5, padding: "6px 8px", fontSize: 12, background: "#fff",
}
const button: React.CSSProperties = {
  border: "1px solid #d6d3d1", borderRadius: 5, padding: "6px 10px",
  background: "#fff", cursor: "pointer", fontSize: 12,
}
const isProjectNewBorehole = (b: Borehole) =>
  (b as any).project_role ? (b as any).project_role === "new" : Boolean((b as any).is_supplementary)

export function VirtualBoreholeManager({
  projectId, observed, virtualBoreholes, isPickingFromScene, sceneCopySourceId,
  onStartPickingFromScene, onClose, onChanged,
}: Props) {
  const [selectedId, setSelectedId] = useState<number | "new">("new")
  const selected = useMemo(
    () => virtualBoreholes.find((row) => row.id === selectedId) ?? null,
    [selectedId, virtualBoreholes],
  )
  const [copySource, setCopySource] = useState("")
  const [name, setName] = useState("VBH-001")
  const [longitude, setLongitude] = useState("")
  const [latitude, setLatitude] = useState("")
  const [elevation, setElevation] = useState("")
  const [note, setNote] = useState("")
  const [purpose, setPurpose] = useState("")
  const [rows, setRows] = useState<Row[]>([{ depth_top: 0, depth_bottom: 10, soil_type: "토사", strata_group: "soil" }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const applyCopySource = useCallback((id: string) => {
    setCopySource(id)
    const source = observed.find((row) => String(row.id) === id)
    if (!source) {
      setError("선택한 시추공을 현재 프로젝트에서 찾을 수 없습니다.")
      return
    }
    setError("")
    setName(`V-${source.name}`)
    setLongitude(String(source.longitude))
    setLatitude(String(source.latitude))
    setElevation(String(source.elevation))
    setRows(source.strata.map((row) => ({
      depth_top: row.depth_top,
      depth_bottom: row.depth_bottom,
      soil_type: row.soil_type,
      strata_group: row.strata_group ?? undefined,
    })))
  }, [observed])

  useEffect(() => {
    if (selected || !sceneCopySourceId) return
    applyCopySource(sceneCopySourceId)
  }, [applyCopySource, sceneCopySourceId, selected])

  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setLongitude(String(selected.longitude))
    setLatitude(String(selected.latitude))
    setElevation(String(selected.elevation))
    setNote(selected.interpretation_note)
    setPurpose(selected.purpose ?? "")
    setRows(selected.strata.map((row) => ({
      depth_top: row.depth_top,
      depth_bottom: row.depth_bottom,
      soil_type: row.soil_type,
      strata_group: row.strata_group ?? undefined,
    })))
  }, [selected])

  const resetNew = () => {
    setSelectedId("new")
    setCopySource("")
    setName(`VBH-${String(virtualBoreholes.length + 1).padStart(3, "0")}`)
    setLongitude("")
    setLatitude("")
    setElevation("")
    setNote("")
    setPurpose("")
    setRows([{ depth_top: 0, depth_bottom: 10, soil_type: "토사", strata_group: "soil" }])
  }

  const save = async () => {
    setError("")
    const lng = Number(longitude)
    const lat = Number(latitude)
    const elev = Number(elevation)
    if (!name.trim() || !Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(elev) || !note.trim()) {
      setError("공명, 좌표, 표고와 해석 근거를 입력해주세요.")
      return
    }
    if (!rows.length) {
      setError("지층을 한 개 이상 입력해주세요.")
      return
    }
    const orderedRows = [...rows].sort((a, b) => a.depth_top - b.depth_top)
    if (Math.abs(orderedRows[0].depth_top) > 1e-6) {
      setError("첫 지층은 심도 0m에서 시작해야 합니다.")
      return
    }
    for (let index = 0; index < orderedRows.length; index += 1) {
      const row = orderedRows[index]
      if (row.depth_bottom <= row.depth_top) {
        setError(`${index + 1}번째 지층의 하단 심도는 상단 심도보다 커야 합니다.`)
        return
      }
      if (index > 0 && Math.abs(row.depth_top - orderedRows[index - 1].depth_bottom) > 1e-6) {
        setError(`${index}번째와 ${index + 1}번째 지층 사이에 공백 또는 중첩이 있습니다.`)
        return
      }
    }
    setSaving(true)
    try {
      let response: Response
      if (selected) {
        response = await fetch(apiUrl(`/api/v1/projects/${projectId}/virtual-boreholes/${selected.id}`), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name, longitude: lng, latitude: lat, elevation: elev,
            interpretation_note: note, purpose, strata: rows,
            change_reason: "3D 뷰어에서 가상 시추공 수정",
          }),
        })
      } else if (copySource) {
        response = await fetch(apiUrl(`/api/v1/projects/${projectId}/virtual-boreholes/copy`), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_borehole_id: Number(copySource), name,
            longitude: lng, latitude: lat, elevation: elev,
            interpretation_note: note, purpose,
          }),
        })
      } else {
        response = await fetch(apiUrl(`/api/v1/projects/${projectId}/virtual-boreholes`), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name, longitude: lng, latitude: lat, elevation: elev,
            interpretation_note: note, purpose, strata: rows,
          }),
        })
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${response.status}`)
      }
      onChanged()
      resetNew()
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (item: VirtualBorehole) => {
    setError("")
    const response = await fetch(apiUrl(`/api/v1/projects/${projectId}/virtual-boreholes/${item.id}`), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_enabled: !item.model_enabled,
        change_reason: item.model_enabled ? "모델 반영 해제" : "모델 반영 활성화",
      }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.detail || `상태 변경 실패: HTTP ${response.status}`)
      return
    }
    onChanged()
  }

  const remove = async (item: VirtualBorehole) => {
    if (!window.confirm(`${item.name} 가상 시추공을 삭제할까요?`)) return
    await fetch(apiUrl(`/api/v1/projects/${projectId}/virtual-boreholes/${item.id}`), { method: "DELETE" })
    onChanged()
    resetNew()
  }

  if (isPickingFromScene) return null

  const selectedCopySource = observed.find((row) => String(row.id) === copySource) ?? null

  return (
    <div style={panel}>
      <div style={{ width: 920, maxHeight: "90vh", overflow: "hidden", display: "grid", gridTemplateColumns: "280px 1fr", background: "#faf8f5", borderRadius: 10, boxShadow: "0 18px 60px rgba(0,0,0,.3)" }}>
        <aside style={{ borderRight: "1px solid #e7e5e4", padding: 16, overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <b>가상 시추공</b><button style={button} onClick={resetNew}>+ 추가</button>
          </div>
          <p style={{ fontSize: 11, color: "#78716c" }}>프로젝트 내부 해석자료 · 실제 시추공과 분리</p>
          {virtualBoreholes.map((item) => (
            <div key={item.id} onClick={() => setSelectedId(item.id)} style={{ padding: 9, marginTop: 6, borderRadius: 6, cursor: "pointer", border: selectedId === item.id ? "1px solid #7c3aed" : "1px solid #e7e5e4", background: item.model_enabled ? "#f3e8ff" : "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><b>{item.name}</b><span style={{ color: "#7c3aed", fontSize: 10 }}>{item.model_enabled ? "모델 반영" : item.status}</span></div>
              <div style={{ fontSize: 10, color: "#78716c", marginTop: 3 }}>심도 {item.total_depth.toFixed(1)}m · v{item.version}</div>
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                <button style={button} onClick={(event) => { event.stopPropagation(); toggle(item) }}>{item.model_enabled ? "해제" : "활성화"}</button>
                <button style={{ ...button, color: "#dc2626" }} onClick={(event) => { event.stopPropagation(); remove(item) }}>삭제</button>
              </div>
            </div>
          ))}
        </aside>
        <main style={{ padding: 18, overflowY: "auto", maxHeight: "90vh" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>{selected ? `${selected.name} 편집` : "가상 시추공 작성"}</h2>
            <button style={button} onClick={onClose}>닫기</button>
          </div>
          {!selected && (
            <div style={{ display: "block", marginTop: 14, fontSize: 12 }}>
              <div>실제 시추공 복사(선택)</div>
              <button
                type="button"
                style={{ ...button, width: "100%", marginTop: 6, borderColor: "#7c3aed", color: "#6d28d9", fontWeight: 700 }}
                onClick={onStartPickingFromScene}
              >
                3D 화면에서 원본 시추공 선택
              </button>
              <select style={{ ...input, marginTop: 4 }} value={copySource} onChange={(event) => {
                const id = event.target.value
                if (id) applyCopySource(id)
                else setCopySource("")
              }}>
                <option value="">빈 시추공 직접 작성</option>
                {observed.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.elevation?.toFixed(1)}m</option>)}
              </select>
              {selectedCopySource && (
                <div style={{ marginTop: 8, padding: 9, borderRadius: 6, border: "1px solid #ddd6fe", background: "#faf5ff", color: "#4c1d95", lineHeight: 1.55 }}>
                  <b>선택 원본: {selectedCopySource.name}</b>
                  <div>
                    {isProjectNewBorehole(selectedCopySource) ? "신규" : "기존"} ·
                    표고 {Number(selectedCopySource.elevation).toFixed(1)}m ·
                    총 심도 {Math.max(0, ...selectedCopySource.strata.map((row) => row.depth_bottom)).toFixed(1)}m ·
                    지층 {selectedCopySource.strata.length}개
                  </div>
                  <div style={{ marginTop: 3, color: "#b45309" }}>
                    원본과 같은 위치에서는 모델 반영이 제한될 수 있으므로 좌표를 변경해주세요.
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
            <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="공명" />
            <input style={input} value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="경도" />
            <input style={input} value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="위도" />
            <input style={input} value={elevation} onChange={(e) => setElevation(e.target.value)} placeholder="표고(m)" />
          </div>
          <input style={{ ...input, marginTop: 8 }} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="작성 목적" />
          <textarea style={{ ...input, marginTop: 8, minHeight: 58 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="해석 근거(필수)" />
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>해석 지층</h3>
          {rows.map((row, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr auto", gap: 6, marginBottom: 6 }}>
              <input type="number" style={input} value={row.depth_top} onChange={(e) => setRows((prev) => prev.map((r, i) => i === index ? { ...r, depth_top: Number(e.target.value) } : r))} />
              <input type="number" style={input} value={row.depth_bottom} onChange={(e) => setRows((prev) => prev.map((r, i) => i === index ? { ...r, depth_bottom: Number(e.target.value) } : r))} />
              <select style={input} value={row.soil_type} onChange={(e) => setRows((prev) => prev.map((r, i) => i === index ? { ...r, soil_type: e.target.value, strata_group: layerGroupForSoilType(e.target.value) } : r))}>
                {soilTypeOptions.map((name) => <option key={name}>{name}</option>)}
                {!soilTypeOptions.includes(row.soil_type as any) && <option value={row.soil_type}>{row.soil_type}</option>}
              </select>
              <button style={button} onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}>삭제</button>
            </div>
          ))}
          <button style={button} onClick={() => setRows((prev) => {
            const top = prev.length ? prev[prev.length - 1].depth_bottom : 0
            return [...prev, { depth_top: top, depth_bottom: top + 1, soil_type: "토사", strata_group: "soil" }]
          })}>+ 지층 추가</button>
          {error && <p style={{ color: "#dc2626", fontSize: 12 }}>{error}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
            <button style={{ ...button, background: "#7c3aed", color: "#fff", borderColor: "#7c3aed" }} disabled={saving} onClick={save}>{saving ? "저장 중..." : selected ? "변경 저장" : "초안 저장"}</button>
          </div>
        </main>
      </div>
    </div>
  )
}
