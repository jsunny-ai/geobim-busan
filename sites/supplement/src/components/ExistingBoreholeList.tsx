import type { Borehole } from "@/lib/types"
import { normalizeStrataGroup, getStrataColor, STRATA_LEGEND } from "@shared/strataColor"

const C = {
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  inner: "#f2ede6",
  red: "#dc2626",
} as const

interface Props {
  boreholes: Borehole[]
  loadState: "idle" | "loading" | "done" | "error"
  loadErr: string | null
}

function isProjectNew(borehole: Borehole) {
  return borehole.project_role ? borehole.project_role === "new" : Boolean(borehole.is_supplementary)
}

export default function ExistingBoreholeList({ boreholes, loadState, loadErr }: Props) {
  const existingCount = boreholes.filter((b) => !isProjectNew(b)).length
  const newCount = boreholes.filter(isProjectNew).length

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 2 }}>프로젝트 시추공</div>
      <h2 style={{ margin: "0 0 8px 0", fontSize: 14, fontWeight: 700 }}>
        적용 데이터 ({boreholes.length}개)
      </h2>
      <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 12 }}>
        기존 {existingCount}개 · 신규 {newCount}개
      </div>

      {loadState === "loading" && (
        <p style={{ fontSize: 12, color: C.tertiary }}>불러오는 중...</p>
      )}
      {loadState === "error" && (
        <p style={{ fontSize: 12, color: C.red }}>{loadErr}</p>
      )}

      {boreholes.length === 0 && loadState === "done" && (
        <p style={{ fontSize: 12, color: C.tertiary }}>해당 프로젝트에 시추공이 없습니다.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {boreholes.map((bh) => {
          const isNew = isProjectNew(bh)
          return (
            <div
              key={bh.id}
              style={{
                background: C.inner,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                padding: "9px 11px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, wordBreak: "break-word" }}>{bh.name}</span>
                <span style={{
                  flexShrink: 0,
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 10,
                  background: isNew ? "rgba(220,38,38,.10)" : "rgba(160,155,148,.18)",
                  color: isNew ? "#b91c1c" : C.text,
                  border: `1px solid ${isNew ? "rgba(220,38,38,.30)" : "rgba(160,155,148,.35)"}`,
                }}>
                  {isNew ? "신규" : "기존"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: C.tertiary, marginTop: 3 }}>
                {bh.latitude.toFixed(6)}, {bh.longitude.toFixed(6)}
              </div>
              {bh.elevation != null && (
                <div style={{ fontSize: 11, color: C.tertiary }}>표고 {bh.elevation.toFixed(2)} m</div>
              )}
              {bh.strata && bh.strata.length > 0 && (
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {bh.strata.map((s, i) => {
                    const grp = normalizeStrataGroup(s.soil_type ?? s.strata_group ?? "")
                    const col = getStrataColor(s.soil_type ?? s.strata_group ?? "")
                    return (
                      <span key={i} style={{
                        fontSize: 10,
                        padding: "1px 5px",
                        borderRadius: 4,
                        background: `${col}22`,
                        border: `1px solid ${col}55`,
                        color: col,
                      }}>
                        {s.soil_type ?? grp} {s.depth_bottom?.toFixed(1)}m
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {boreholes.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 6 }}>지층 범례</div>
          {STRATA_LEGEND.map((entry) => (
            <div key={entry.group} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <span style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                flexShrink: 0,
                background: entry.color,
              }} />
              <span style={{ fontSize: 11, color: C.secondary }}>{entry.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
