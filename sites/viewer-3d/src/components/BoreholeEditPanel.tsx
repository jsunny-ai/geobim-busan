import React, { useEffect, useMemo, useState } from "react"
import type { Borehole } from "@/lib/types"
import { SOIL_DETAIL_TYPES } from "@/lib/soilDetail"
import { apiUrl } from "@shared/urls"

const C = {
  panel: "rgba(250,248,245,.99)",
  border: "#e9e4da",
  inner: "#f2ede6",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  active: "#D4D1CB",
  danger: "#dc2626",
} as const

const soilTypes = [...SOIL_DETAIL_TYPES, "풍화암", "연암", "보통암", "경암", "미분류"]

type DraftStratum = {
  depth_top: number
  depth_bottom: number
  soil_type: string
  raw_text?: string | null
  n_value?: number | null
  uscs_code?: string | null
}

interface Props {
  borehole: Borehole & { revision_version?: number }
  onClose: () => void
  onPreviewChange?: (borehole: Borehole) => void
  onSaved: (borehole: Borehole) => void
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.inner,
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  color: C.text,
  padding: "6px 8px",
  fontSize: 12,
  outline: "none",
  fontFamily: "'Noto Sans KR',sans-serif",
}

const smallButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  color: C.secondary,
  cursor: "pointer",
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: "'Noto Sans KR',sans-serif",
}

export const BoreholeEditPanel: React.FC<Props> = ({ borehole, onClose, onPreviewChange, onSaved }) => {
  const [latitude, setLatitude] = useState(String(borehole.latitude ?? ""))
  const [longitude, setLongitude] = useState(String(borehole.longitude ?? ""))
  const [elevation, setElevation] = useState(String(borehole.elevation ?? ""))
  const [groundwaterDepth, setGroundwaterDepth] = useState(String(borehole.groundwater_depth_bgl_m ?? ""))
  const [reason, setReason] = useState("3D 지질 뷰어에서 지층 데이터 수정")
  const [strata, setStrata] = useState<DraftStratum[]>(() => toDraftStrata(borehole))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLatitude(String(borehole.latitude ?? ""))
    setLongitude(String(borehole.longitude ?? ""))
    setElevation(String(borehole.elevation ?? ""))
    setGroundwaterDepth(String(borehole.groundwater_depth_bgl_m ?? ""))
    setStrata(toDraftStrata(borehole))
  }, [borehole.id])

  const preview = useMemo<Borehole>(() => ({
    ...borehole,
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    elevation: parseFloat(elevation),
    groundwater_depth_bgl_m: groundwaterDepth.trim() === "" ? null : parseFloat(groundwaterDepth),
    groundwater_head_elevation_m: groundwaterDepth.trim() === "" ? null : parseFloat(elevation) - parseFloat(groundwaterDepth),
    strata: strata.map((s, index) => ({
      ...s,
      id: borehole.strata?.[index]?.id ?? -(index + 1),
      borehole_id: borehole.id,
    })),
  }), [borehole, elevation, groundwaterDepth, latitude, longitude, strata])

  useEffect(() => {
    onPreviewChange?.(preview)
  }, [onPreviewChange, preview])

  const setRow = (index: number, key: keyof DraftStratum, value: string | number | null) => {
    setStrata((prev) => prev.map((row, rowIndex) => {
      if (rowIndex === index) return { ...row, [key]: value }
      if (key === "depth_bottom" && rowIndex === index + 1) return { ...row, depth_top: Number(value) }
      if (key === "depth_top" && rowIndex === index - 1) return { ...row, depth_bottom: Number(value) }
      return row
    }))
  }

  const splitRow = (index: number) => {
    setStrata((prev) => {
      const target = prev[index]
      if (!target) return prev
      const top = Number(target.depth_top)
      const bottom = Number(target.depth_bottom)
      if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return prev
      const splitDepth = Math.round(((top + bottom) / 2) * 10) / 10
      if (splitDepth <= top || splitDepth >= bottom) return prev
      return [
        ...prev.slice(0, index),
        { ...target, depth_bottom: splitDepth },
        { ...target, depth_top: splitDepth },
        ...prev.slice(index + 1),
      ]
    })
  }

  const removeRow = (index: number) => {
    setStrata((prev) => prev.filter((_, rowIndex) => rowIndex !== index))
  }

  const save = async () => {
    const lat = parseFloat(latitude)
    const lng = parseFloat(longitude)
    const elev = parseFloat(elevation)
    const gwDepth = groundwaterDepth.trim() === "" ? null : parseFloat(groundwaterDepth)
    const normalized = strata.map((row) => ({
      depth_top: Number(row.depth_top),
      depth_bottom: Number(row.depth_bottom),
      soil_type: row.soil_type?.trim() || "미분류",
      raw_text: row.raw_text ?? null,
      n_value: row.n_value ?? null,
      uscs_code: row.uscs_code ?? null,
    }))

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(elev)) {
      setError("위도, 경도, 표고는 숫자로 입력해야 합니다.")
      return
    }
    if (gwDepth !== null && (!Number.isFinite(gwDepth) || gwDepth < 0)) {
      setError("지하수위는 비워두거나 0 이상의 숫자로 입력해야 합니다.")
      return
    }
    if (normalized.some((row) => !Number.isFinite(row.depth_top) || !Number.isFinite(row.depth_bottom) || row.depth_bottom <= row.depth_top)) {
      setError("지층 심도는 숫자이며 하단 심도가 상단 심도보다 커야 합니다.")
      return
    }
    if (!reason.trim()) {
      setError("수정 사유를 입력해 주세요.")
      return
    }

    setSaving(true)
    setError(null)
    try {
      if (lat !== borehole.latitude || lng !== borehole.longitude) {
        const coordRes = await fetch(apiUrl(`/api/v1/boreholes/${borehole.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ latitude: lat, longitude: lng }),
        })
        if (!coordRes.ok) throw new Error(await readApiError(coordRes))
      }

      const revisionRes = await fetch(apiUrl(`/api/v1/boreholes/${borehole.id}/revisions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elevation: elev, groundwater_depth_bgl_m: gwDepth, strata: normalized, reason: reason.trim() }),
      })
      if (!revisionRes.ok) throw new Error(await readApiError(revisionRes))

      onSaved({
        ...preview,
        latitude: lat,
        longitude: lng,
        elevation: elev,
        groundwater_depth_bgl_m: gwDepth,
        groundwater_head_elevation_m: gwDepth === null ? null : elev - gwDepth,
        strata: normalized.map((row, index) => ({
          ...row,
          id: preview.strata[index]?.id ?? -(index + 1),
          borehole_id: borehole.id,
        })),
      })
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside style={{
      position: "absolute",
      top: 14,
      left: 14,
      bottom: 14,
      width: 380,
      zIndex: 30,
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      boxShadow: "0 8px 24px rgba(0,0,0,.16)",
      color: C.text,
      fontFamily: "'Noto Sans KR',sans-serif",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{borehole.name ?? borehole.id}</div>
          <div style={{ fontSize: 11, color: C.tertiary, marginTop: 2 }}>
            지층 편집 {borehole.revision_version ? `· 현재 v${borehole.revision_version}` : ""}
          </div>
        </div>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.tertiary, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>x</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
          <Field label="위도" value={latitude} onChange={setLatitude} />
          <Field label="경도" value={longitude} onChange={setLongitude} />
          <Field label="표고(m)" value={elevation} onChange={setElevation} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <Field label="지하수위 GL(-) m" value={groundwaterDepth} onChange={setGroundwaterDepth} />
          <label style={{ fontSize: 11, color: C.tertiary }}>
            지하수위 EL(m)
            <input
              type="text"
              value={
                groundwaterDepth.trim() === "" || !Number.isFinite(parseFloat(elevation)) || !Number.isFinite(parseFloat(groundwaterDepth))
                  ? "-"
                  : String(Math.round((parseFloat(elevation) - parseFloat(groundwaterDepth)) * 1000) / 1000)
              }
              readOnly
              style={{ ...inputStyle, marginTop: 4, color: C.tertiary }}
            />
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>지층</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {strata.map((row, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "58px 58px 1fr 24px 24px", gap: 5, alignItems: "center" }}>
              <input
                type="number"
                step="0.1"
                value={row.depth_top}
                onChange={(e) => setRow(index, "depth_top", parseFloat(e.target.value) || 0)}
                style={inputStyle}
                title="상단 심도"
              />
              <input
                type="number"
                step="0.1"
                value={row.depth_bottom}
                onChange={(e) => setRow(index, "depth_bottom", parseFloat(e.target.value) || 0)}
                style={inputStyle}
                title="하단 심도"
              />
              <select
                value={row.soil_type}
                onChange={(e) => setRow(index, "soil_type", e.target.value)}
                style={inputStyle}
                title="지층명"
              >
                {soilTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                {!soilTypes.includes(row.soil_type) && <option value={row.soil_type}>{row.soil_type}</option>}
              </select>
              <button onClick={() => splitRow(index)} style={{ ...smallButtonStyle, padding: "5px 0" }} title="현재 지층을 중간에서 분할">+</button>
              <button onClick={() => removeRow(index)} style={{ ...smallButtonStyle, color: C.danger, padding: "5px 0" }} title="삭제">x</button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>수정 사유</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
        </div>

        <div style={{ marginTop: 10, padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.inner, fontSize: 11, color: C.secondary, lineHeight: 1.5 }}>
          저장 시 전역 개정본으로 기록되어 프로젝트 상세, 지도, 3D 뷰어의 모든 조회에 같은 값이 적용됩니다.
        </div>
      </div>

      <div style={{ padding: 14, borderTop: `1px solid ${C.border}` }}>
        {error && <div style={{ color: C.danger, fontSize: 11, marginBottom: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...smallButtonStyle, flex: 1, background: C.active, color: C.text, fontWeight: 700 }}>
            {saving ? "저장 중..." : "저장"}
          </button>
          <button onClick={onClose} disabled={saving} style={{ ...smallButtonStyle, width: 76 }}>닫기</button>
        </div>
      </div>
    </aside>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label style={{ fontSize: 11, color: C.tertiary }}>
      {label}
      <input type="number" step="0.000001" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
    </label>
  )
}

function toDraftStrata(borehole: Borehole): DraftStratum[] {
  return [...(borehole.strata || [])]
    .sort((a, b) => a.depth_top - b.depth_top)
    .map((s) => ({
      depth_top: s.depth_top,
      depth_bottom: s.depth_bottom,
      soil_type: s.soil_type,
      raw_text: s.raw_text,
      n_value: s.n_value,
      uscs_code: s.uscs_code,
    }))
}

async function readApiError(response: Response) {
  const body = await response.json().catch(() => null)
  return body?.detail || `HTTP ${response.status}`
}
