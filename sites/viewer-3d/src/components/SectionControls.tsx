import type { VerticalSectionState } from "@/lib/types"

interface SectionControlsProps {
  state: VerticalSectionState
  azimuth: number
  lengthM: number
  maxOffsetM: number
  onChange: (patch: Partial<VerticalSectionState>) => void
  onRedraw: () => void
  onPreset: (axis: "x" | "z") => void
  onFocus: () => void
  onReset: () => void
}

const border = "#d6d3d1"
const buttonStyle: React.CSSProperties = {
  flex: 1,
  border: `1px solid ${border}`,
  borderRadius: 6,
  padding: "7px 8px",
  background: "#f5f5f4",
  color: "#1c1917",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'Noto Sans KR',sans-serif",
}

export function SectionControls({
  state,
  azimuth,
  lengthM,
  maxOffsetM,
  onChange,
  onRedraw,
  onPreset,
  onFocus,
  onReset,
}: SectionControlsProps) {
  const isReady = state.interactionMode === "editing" && !!state.start && !!state.end
  const status = state.interactionMode === "placing-start"
    ? "시작점을 선택하세요"
    : state.interactionMode === "placing-end"
      ? "끝점을 선택하세요"
      : "단면 편집 중"

  return (
    <div style={{
      position: "absolute", top: 14, left: 342, zIndex: 15, width: 248,
      boxSizing: "border-box", padding: 14, borderRadius: 10,
      border: `1px solid ${border}`, background: "rgba(250,248,245,.97)",
      boxShadow: "0 4px 18px rgba(0,0,0,.12)", color: "#1c1917",
      fontFamily: "'Noto Sans KR',sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 14, flex: 1 }}>수직 단면</strong>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0891b2" }} />
      </div>
      <div style={{ marginTop: 4, marginBottom: 12, color: "#78716c", fontSize: 11 }}>{status}</div>

      <div style={{ display: "flex", gap: 6 }}>
        <button style={buttonStyle} onClick={onRedraw}>다시 그리기</button>
        <button style={{ ...buttonStyle, opacity: isReady ? 1 : 0.45 }} disabled={!isReady} onClick={() => onChange({ flipped: !state.flipped })}>
          방향 반전 (F)
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button style={buttonStyle} onClick={() => onPreset("x")}>동–서 단면</button>
        <button style={buttonStyle} onClick={() => onPreset("z")}>남–북 단면</button>
      </div>

      {isReady && (
        <>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span>위치 이동</span><b>{state.offsetM.toFixed(1)} m</b>
            </div>
            <input
              type="range" min={-maxOffsetM} max={maxOffsetM} step={0.5}
              value={Math.max(-maxOffsetM, Math.min(maxOffsetM, state.offsetM))}
              onChange={(event) => onChange({ offsetM: Number(event.target.value) })}
              style={{ width: "100%", accentColor: "#0891b2" }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button style={buttonStyle} onClick={() => onChange({ offsetM: state.offsetM - 1 })}>− 1m</button>
              <button style={buttonStyle} onClick={() => onChange({ offsetM: 0 })}>0</button>
              <button style={buttonStyle} onClick={() => onChange({ offsetM: state.offsetM + 1 })}>+ 1m</button>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: "8px 0", borderTop: `1px solid ${border}`, borderBottom: `1px solid ${border}`, fontSize: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#78716c" }}>방위각</span><b>{azimuth.toFixed(1)}°</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}><span style={{ color: "#78716c" }}>절단선 길이</span><b>{lengthM.toFixed(1)} m</b></div>
          </div>

          <button style={{ ...buttonStyle, width: "100%", marginTop: 10, background: "rgba(8,145,178,.12)", borderColor: "#0891b2", color: "#0e7490" }} onClick={onFocus}>
            단면 정면 보기 (C)
          </button>
        </>
      )}

      <div style={{ marginTop: 12, display: "grid", gap: 7, fontSize: 11, color: "#57534e" }}>
        <label><input type="checkbox" checked={state.clipDrape} onChange={(event) => onChange({ clipDrape: event.target.checked })} /> 지표면 함께 절단</label>
        <label><input type="checkbox" checked={state.clipBoreholes} onChange={(event) => onChange({ clipBoreholes: event.target.checked })} /> 시추공 단면 투영</label>
      </div>

      <button style={{ ...buttonStyle, width: "100%", marginTop: 12, color: "#b91c1c" }} onClick={onReset}>
        단면 종료 (Esc)
      </button>
    </div>
  )
}
