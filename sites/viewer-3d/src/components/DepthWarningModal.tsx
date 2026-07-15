// [v4.2] 이상 심도 경고 모달 — 감지된 시추공 목록 + 데이터 확인 진입점
import React from "react"
import type { Borehole } from "@/lib/types"

const C = {
  border: "#e9e4da",
  text: "#1c1917",
  tertiary: "#78716c",
  warn: "#7c3aed",
  panel: "rgba(250,248,245,.99)",
} as const

type WarnBorehole = Borehole & { max_depth?: number; depth_warning?: boolean }

interface Props {
  warned: WarnBorehole[]
  onInspect: (b: WarnBorehole) => void
  onClose: () => void
}

export const DepthWarningModal: React.FC<Props> = ({ warned, onInspect, onClose }) => {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(28,25,23,.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Noto Sans KR',sans-serif",
      }}
    >
      <div style={{ width: 460, maxHeight: "70vh", background: C.panel, borderRadius: 10, border: `1px solid ${C.border}`, boxShadow: "0 8px 32px rgba(0,0,0,.25)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.warn }}>⚠️ 심도 이상 의심 시추공 {warned.length}개</div>
          <div style={{ fontSize: 11, color: C.tertiary, marginTop: 4, lineHeight: 1.5 }}>
            입력된 심도가 비정상적으로 깊습니다 (PDF 추출 단위 오류 가능).
            확인 전까지 해당 시추공은 지층 보간에서 제외됩니다.
            원본 PDF와 대조하여 데이터를 확인해 주세요.
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: C.tertiary, fontSize: 10 }}>
                <th style={{ textAlign: "left", padding: "4px 18px" }}>공명</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>표고(m)</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>심도(m)</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {warned.map((b) => (
                <tr key={b.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "7px 18px", fontWeight: 600, color: C.text }}>{b.name}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: C.tertiary }}>{b.elevation?.toFixed(1)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: C.warn, fontWeight: 700 }}>
                    {(b.max_depth ?? 0).toFixed(1)}
                  </td>
                  <td style={{ padding: "7px 12px", textAlign: "right" }}>
                    <button
                      onClick={() => onInspect(b)}
                      style={{
                        padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                        background: "rgba(124,58,237,.12)", color: C.warn,
                        border: `1px solid ${C.warn}`, borderRadius: 5,
                        fontFamily: "'Noto Sans KR',sans-serif",
                      }}
                    >
                      데이터 확인하기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 18px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px", fontSize: 12, cursor: "pointer",
              background: "transparent", color: C.tertiary,
              border: `1px solid ${C.border}`, borderRadius: 5,
              fontFamily: "'Noto Sans KR',sans-serif",
            }}
          >
            나중에 (테이블 심도 클릭으로 재진입)
          </button>
        </div>
      </div>
    </div>
  )
}
