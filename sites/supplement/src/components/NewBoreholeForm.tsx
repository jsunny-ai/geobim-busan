import { useState, useCallback } from "react"
import type { Borehole, Stratum } from "@/lib/types"
import { getStrataColor, normalizeStrataGroup, STRATA_LEGEND } from "@shared/strataColor"

const C = {
  border:    "#e9e4da",
  text:      "#1c1917",
  secondary: "#44403c",
  tertiary:  "#78716c",
  inner:     "#f2ede6",
  panel:     "rgba(250,248,245,.97)",
  btnActive: "#D4D1CB",
  btnBorder: "#BEBAB3",
  btnIdle:   "#f2ede6",
  btnIdleBd: "#e9e4da",
  red:       "#dc2626",
  green:     "#D4D1CB",
  greenBd:   "#BEBAB3",
} as const

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  background: C.inner, color: C.text,
  border: `1px solid ${C.btnIdleBd}`,
  borderRadius: 6, padding: "6px 9px",
  fontSize: 13, fontFamily: "'Noto Sans KR',sans-serif",
  outline: "none",
}

const labelStyle: React.CSSProperties = {
  fontSize: 11, color: C.tertiary, marginBottom: 3, display: "block",
}

const SOIL_OPTIONS = [
  "토사", "매립토", "퇴적토", "풍화토", "풍화암", "연암", "보통암", "리핑암", "경암", "발파암",
]

type DraftStratum = Omit<Stratum, "id">

interface Props {
  newBhs: Borehole[]
  onAdd: (bh: Borehole) => void
  onRemove: (id: number) => void
}

export default function NewBoreholeForm({ newBhs, onAdd, onRemove }: Props) {
  const [name, setName]   = useState("")
  const [lat,  setLat]    = useState("")
  const [lng,  setLng]    = useState("")
  const [elev, setElev]   = useState("")
  const [strata, setStrata] = useState<DraftStratum[]>([
    { order: 0, depth_top: 0, depth_bottom: 5, soil_type: "토사" },
  ])
  const [formErr, setFormErr] = useState<string | null>(null)

  function addStratum() {
    const lastBot = strata[strata.length - 1]?.depth_bottom ?? 0
    setStrata([...strata, {
      order: strata.length, depth_top: lastBot, depth_bottom: lastBot + 5, soil_type: "풍화암",
    }])
  }

  function removeStratum(i: number) {
    setStrata(strata.filter((_, idx) => idx !== i))
  }

  function updateStratum(i: number, field: keyof DraftStratum, value: string | number) {
    setStrata(strata.map((s, idx) => idx === i ? { ...s, [field]: value } : s))
  }

  const handleAdd = useCallback(() => {
    setFormErr(null)
    const latitude  = parseFloat(lat)
    const longitude = parseFloat(lng)
    const elevation = elev ? parseFloat(elev) : null

    if (!name.trim())        return setFormErr("시추공 이름을 입력하세요.")
    if (isNaN(latitude))     return setFormErr("위도를 올바르게 입력하세요.")
    if (isNaN(longitude))    return setFormErr("경도를 올바르게 입력하세요.")
    if (strata.length === 0) return setFormErr("지층 정보를 1개 이상 입력하세요.")

    for (const s of strata) {
      if (s.depth_bottom <= s.depth_top) return setFormErr("지층 바닥 깊이는 상단 깊이보다 커야 합니다.")
    }

    onAdd({
      id: 0, // SupplementPage에서 Date.now()로 덮어씀
      name: name.trim(),
      latitude, longitude,
      elevation,
      strata: strata.map((s, i) => ({
        ...s, order: i,
        strata_group: normalizeStrataGroup(s.soil_type),
      })),
      isNew: true,
    })

    // 폼 초기화
    setName(""); setLat(""); setLng(""); setElev("")
    setStrata([{ order: 0, depth_top: 0, depth_bottom: 5, soil_type: "토사" }])
  }, [name, lat, lng, elev, strata, onAdd])

  return (
    <div>
      <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 2 }}>추가 시추공</div>
      <h2 style={{ margin: "0 0 16px 0", fontSize: 14, fontWeight: 700 }}>
        신규 시추공 입력
      </h2>

      {/* ── 입력 폼 ── */}
      <div style={{
        background: C.panel, border: `1px solid ${C.border}`,
        borderRadius: 9, padding: "16px 18px", marginBottom: 16,
      }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px", marginBottom: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>시추공 이름 *</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="예) BH-A1" />
          </div>
          <div>
            <label style={labelStyle}>위도 (Latitude) *</label>
            <input style={inputStyle} value={lat} onChange={e => setLat(e.target.value)} placeholder="37.123456" />
          </div>
          <div>
            <label style={labelStyle}>경도 (Longitude) *</label>
            <input style={inputStyle} value={lng} onChange={e => setLng(e.target.value)} placeholder="126.123456" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>지표면 표고 (m, 선택)</label>
            <input style={inputStyle} value={elev} onChange={e => setElev(e.target.value)} placeholder="예) 24.5" />
          </div>
        </div>

        {/* 지층 테이블 */}
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 6 }}>지층 정보 *</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          {strata.map((s, i) => {
            const col = getStrataColor(s.soil_type)
            return (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "80px 1fr 1fr auto",
                gap: 6, alignItems: "center",
                background: C.inner, borderRadius: 6,
                padding: "7px 9px", border: `1px solid ${C.border}`,
              }}>
                <select
                  value={s.soil_type}
                  onChange={e => updateStratum(i, "soil_type", e.target.value)}
                  style={{
                    ...inputStyle, padding: "4px 6px", fontSize: 12,
                    borderColor: `${col}55`,
                  }}
                >
                  {SOIL_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 11, color: C.tertiary, whiteSpace: "nowrap" }}>상단</span>
                  <input
                    type="number" step="0.1"
                    value={s.depth_top}
                    onChange={e => updateStratum(i, "depth_top", parseFloat(e.target.value))}
                    style={{ ...inputStyle, padding: "4px 6px", fontSize: 12 }}
                  />
                  <span style={{ fontSize: 11, color: C.tertiary }}>m</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 11, color: C.tertiary, whiteSpace: "nowrap" }}>하단</span>
                  <input
                    type="number" step="0.1"
                    value={s.depth_bottom}
                    onChange={e => updateStratum(i, "depth_bottom", parseFloat(e.target.value))}
                    style={{ ...inputStyle, padding: "4px 6px", fontSize: 12 }}
                  />
                  <span style={{ fontSize: 11, color: C.tertiary }}>m</span>
                </div>
                <button
                  onClick={() => removeStratum(i)}
                  style={{
                    background: "transparent", border: "none", color: C.red,
                    fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px",
                  }}
                  title="지층 삭제"
                >×</button>
              </div>
            )
          })}
        </div>

        <button
          onClick={addStratum}
          style={{
            width: "100%", padding: "6px", borderRadius: 6,
            background: C.btnIdle, border: `1px solid ${C.btnIdleBd}`,
            color: C.secondary, fontSize: 12, cursor: "pointer", marginBottom: 10,
          }}
        >+ 지층 추가</button>

        {formErr && (
          <p style={{ fontSize: 12, color: C.red, margin: "4px 0 8px 0" }}>{formErr}</p>
        )}

        <button
          onClick={handleAdd}
          style={{
            width: "100%", padding: "9px", borderRadius: 7,
            background: C.green, border: `1px solid ${C.greenBd}`,
            color: "#1c1917", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}
        >시추공 목록에 추가</button>
      </div>

      {/* ── 추가된 신규 시추공 목록 ── */}
      {newBhs.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 8 }}>
            추가된 신규 시추공 ({newBhs.length}개)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {newBhs.map((bh) => (
              <div key={bh.id} style={{
                background: "rgba(160,155,148,.10)",
                border: "1px solid rgba(160,155,148,.35)",
                borderRadius: 7, padding: "9px 11px",
                display: "flex", justifyContent: "space-between", alignItems: "flex-start",
              }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{bh.name}</span>
                    <span style={{
                      fontSize: 10, padding: "1px 6px", borderRadius: 10,
                      background: "rgba(160,155,148,.20)", color: "#1c1917",
                      border: "1px solid rgba(160,155,148,.40)",
                    }}>신규</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.tertiary }}>
                    {bh.latitude.toFixed(6)}, {bh.longitude.toFixed(6)}
                    {bh.elevation != null ? ` · 표고 ${bh.elevation.toFixed(2)}m` : ""}
                  </div>
                  <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {bh.strata.map((s, i) => {
                      const col = getStrataColor(s.soil_type ?? "")
                      return (
                        <span key={i} style={{
                          fontSize: 10, padding: "1px 5px", borderRadius: 4,
                          background: `${col}22`, border: `1px solid ${col}55`, color: col,
                        }}>
                          {s.soil_type} {s.depth_bottom?.toFixed(1)}m
                        </span>
                      )
                    })}
                  </div>
                </div>
                <button
                  onClick={() => onRemove(bh.id)}
                  style={{
                    background: "transparent", border: "none",
                    color: C.red, fontSize: 18, cursor: "pointer",
                    lineHeight: 1, padding: "0 4px", flexShrink: 0,
                  }}
                  title="삭제"
                >×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {newBhs.length === 0 && (
        <div style={{
          textAlign: "center", padding: "32px 0",
          fontSize: 12, color: C.tertiary,
          border: `1px dashed ${C.border}`, borderRadius: 8,
        }}>
          위 폼에서 추가 시추공을 입력하세요.<br />
          <span style={{ fontSize: 11, marginTop: 4, display: "block" }}>
            추가 데이터가 없으면 기존 시추공만으로 내보내기가 실행됩니다.
          </span>
        </div>
      )}
    </div>
  )
}