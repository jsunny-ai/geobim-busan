// [v4.2] PDF 대조 패널 — 원본 PDF와 입력 데이터를 나란히 대조·수정·저장
//
// 원본 불변 원칙: 저장은 원본을 덮어쓰지 않고 새 버전(BoreholeRevision)으로
// 누적된다 (v1, v2, ...). 우측 하단의 버전 타임라인에서 모든 과거 버전을
// 열람하고, 어떤 버전으로든 '이력 보존형 복원'(새 버전 생성)이 가능하다.
import React, { useCallback, useEffect, useState } from "react"
import type { Borehole } from "@/lib/types"
import { apiUrl } from "@shared/urls"

const C = {
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  inner: "#f2ede6",
  active: "#D4D1CB",
  warn: "#7c3aed",
  red: "#dc2626",
  green: "#10b981",
  panel: "rgba(250,248,245,.99)",
} as const

interface StratumRow {
  depth_top: string
  depth_bottom: string
  soil_type: string
}

interface PdfInfo {
  job_id: number
  page_count: number
  file_name: string
}

interface RevisionEntry {
  version: number
  reason: string
  created_at: string | null
  restored_from?: number | null
  payload?: { elevation?: number | null; strata?: any[] }
}

interface Props {
  borehole: Borehole & { data_status?: string; revision_version?: number; max_depth?: number }
  onClose: () => void
  onSaved: () => void
}

const inputStyle: React.CSSProperties = {
  background: C.inner,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  color: C.text,
  padding: "3px 6px",
  fontSize: 11,
  outline: "none",
  width: "100%",
  fontFamily: "'Noto Sans KR',sans-serif",
}

export const PdfComparePanel: React.FC<Props> = ({ borehole, onClose, onSaved }) => {
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [rows, setRows] = useState<StratumRow[]>(() =>
    (borehole.strata || []).map((s) => ({
      depth_top: String(s.depth_top ?? ""),
      depth_bottom: String(s.depth_bottom ?? ""),
      soil_type: s.soil_type || "",
    })),
  )
  const [elevation, setElevation] = useState(String(borehole.elevation ?? ""))
  const [reason, setReason] = useState("")
  const [history, setHistory] = useState<RevisionEntry[]>([])
  const [currentVersion, setCurrentVersion] = useState<number>(0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ── 원본 PDF job 조회 ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetch(apiUrl(`/api/v1/boreholes/${borehole.id}/source-pdf`))
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({} as any))
          throw new Error(body?.detail || `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then((info) => { if (!cancelled) setPdfInfo(info) })
      .catch((e) => { if (!cancelled) setPdfError(String(e?.message || e)) })
    return () => { cancelled = true }
  }, [borehole.id])

  // ── 버전 타임라인 (v0 원본 포함) ──────────────────────────────────────
  const loadHistory = useCallback(() => {
    fetch(apiUrl(`/api/v1/boreholes/${borehole.id}/revisions`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setHistory(data.revisions ?? [])
        setCurrentVersion(data.current_version ?? 0)
      })
      .catch(() => setHistory([]))
  }, [borehole.id])
  useEffect(loadHistory, [loadHistory])

  const original = history.find((h) => h.version === 0)?.payload

  // ── 저장 (새 버전 생성 — 원본 불변) ───────────────────────────────────
  const save = async () => {
    if (!reason.trim()) {
      setErr("수정 사유는 필수입니다. PDF에서 확인한 내용을 적어주세요.")
      return
    }
    const strata = rows.map((r) => ({
      depth_top: parseFloat(r.depth_top),
      depth_bottom: parseFloat(r.depth_bottom),
      soil_type: r.soil_type.trim() || "미분류",
    }))
    if (strata.some((s) => !Number.isFinite(s.depth_top) || !Number.isFinite(s.depth_bottom) || s.depth_bottom <= s.depth_top)) {
      setErr("심도 값을 확인하세요 (하단 > 상단, 숫자만).")
      return
    }
    const elev = parseFloat(elevation)
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(apiUrl(`/api/v1/boreholes/${borehole.id}/revisions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevation: Number.isFinite(elev) ? elev : null,
          strata,
          reason: reason.trim(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any))
        throw new Error(body?.detail || `HTTP ${res.status}`)
      }
      onSaved()
    } catch (e: any) {
      setErr(`저장 실패: ${e?.message || e}`)
    } finally {
      setSaving(false)
    }
  }

  // ── 이력 보존형 복원 ──────────────────────────────────────────────────
  const restore = async (version: number) => {
    if (!window.confirm(`v${version}${version === 0 ? " (원본)" : ""} 상태로 복원할까요?\n복원도 새 버전으로 기록되어 이력이 보존됩니다.`)) return
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(apiUrl(`/api/v1/boreholes/${borehole.id}/restore`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any))
        throw new Error(body?.detail || `HTTP ${res.status}`)
      }
      onSaved()
    } catch (e: any) {
      setErr(`복원 실패: ${e?.message || e}`)
    } finally {
      setSaving(false)
    }
  }

  const setRow = (i: number, key: keyof StratumRow, value: string) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)))
  const addRow = () => setRows((prev) => [...prev, { depth_top: "", depth_bottom: "", soil_type: "" }])
  const delRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i))

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 110,
        background: "rgba(28,25,23,.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Noto Sans KR',sans-serif",
      }}
    >
      <div style={{ width: "min(1180px, 94vw)", height: "86vh", background: C.panel, borderRadius: 10, border: `1px solid ${C.border}`, boxShadow: "0 8px 32px rgba(0,0,0,.3)", display: "flex", flexDirection: "column" }}>
        {/* ── 헤더 ── */}
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>PDF 대조 검증 — {borehole.name}</span>
          <span style={{ fontSize: 11, color: C.tertiary }}>
            {pdfInfo ? `원본: ${pdfInfo.file_name}` : pdfError ? "원본 PDF 없음 (수기 입력)" : "PDF 확인 중..."}
          </span>
          <span style={{ fontSize: 10, color: currentVersion > 0 ? C.green : C.tertiary, marginLeft: "auto" }}>
            현재 v{currentVersion}{currentVersion > 0 ? " (수정됨 · 원본 보존)" : " (원본)"}
          </span>
          <button onClick={onClose} style={{ fontSize: 14, background: "transparent", border: "none", color: C.tertiary, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* ── 좌: PDF 페이지 이미지 ── */}
          <div style={{ flex: 1.2, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ padding: "6px 12px", display: "flex", gap: 6, alignItems: "center", borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
              {pdfInfo && (
                <>
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={{ ...inputStyle, width: 28, cursor: "pointer", textAlign: "center" }}>◀</button>
                  <span style={{ color: C.secondary }}>{page} / {pdfInfo.page_count}</span>
                  <button onClick={() => setPage((p) => Math.min(pdfInfo.page_count, p + 1))} disabled={page >= pdfInfo.page_count} style={{ ...inputStyle, width: 28, cursor: "pointer", textAlign: "center" }}>▶</button>
                  <span style={{ marginLeft: 12, color: C.tertiary }}>확대</span>
                  <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} style={{ ...inputStyle, width: 28, cursor: "pointer", textAlign: "center" }}>−</button>
                  <span style={{ color: C.secondary }}>{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} style={{ ...inputStyle, width: 28, cursor: "pointer", textAlign: "center" }}>＋</button>
                </>
              )}
            </div>
            <div style={{ flex: 1, overflow: "auto", background: "#e8e4dd", display: "flex", justifyContent: "center" }}>
              {pdfInfo ? (
                <img
                  src={apiUrl(`/api/v1/pdf-extraction/jobs/${pdfInfo.job_id}/pages/${page}.png`)}
                  alt={`PDF p.${page}`}
                  style={{ width: `${zoom * 100}%`, height: "fit-content", boxShadow: "0 2px 10px rgba(0,0,0,.2)", margin: 8 }}
                />
              ) : (
                <div style={{ alignSelf: "center", color: C.tertiary, fontSize: 12, padding: 24, textAlign: "center", lineHeight: 1.7 }}>
                  {pdfError
                    ? `원본 PDF를 표시할 수 없습니다.\n(${pdfError})\n우측에서 데이터만 수정할 수 있습니다.`
                    : "PDF 정보를 불러오는 중..."}
                </div>
              )}
            </div>
          </div>

          {/* ── 우: 데이터 대조·편집 ── */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
              {/* 원본 (v0) — 읽기 전용 */}
              <div style={{ fontSize: 11, fontWeight: 700, color: C.tertiary, marginBottom: 4 }}>원본 (v0 — 불변 보존)</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, marginBottom: 12, color: C.tertiary }}>
                <tbody>
                  <tr><td style={{ padding: "2px 4px" }}>표고</td><td style={{ textAlign: "right", padding: "2px 4px" }}>{original?.elevation ?? borehole.elevation}m</td><td /></tr>
                  {(original?.strata ?? []).map((s: any, i: number) => (
                    <tr key={i} style={{ borderTop: `1px dashed ${C.border}` }}>
                      <td style={{ padding: "2px 4px" }}>{s.soil_type}</td>
                      <td style={{ textAlign: "right", padding: "2px 4px" }}>{s.depth_top} ~ {s.depth_bottom}m</td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 수정 폼 */}
              <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                수정 데이터 <span style={{ fontWeight: 400, color: C.tertiary }}>(저장 시 새 버전 v{currentVersion + 1}로 기록)</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11 }}>
                <span style={{ color: C.secondary, whiteSpace: "nowrap" }}>표고(m)</span>
                <input type="number" step="0.01" value={elevation} onChange={(e) => setElevation(e.target.value)} style={{ ...inputStyle, width: 90 }} />
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ color: C.tertiary, fontSize: 10 }}>
                    <th style={{ textAlign: "left", padding: 2 }}>지층명</th>
                    <th style={{ textAlign: "left", padding: 2, width: 76 }}>상단(m)</th>
                    <th style={{ textAlign: "left", padding: 2, width: 76 }}>하단(m)</th>
                    <th style={{ width: 26 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ padding: 2 }}><input value={r.soil_type} onChange={(e) => setRow(i, "soil_type", e.target.value)} style={inputStyle} placeholder="예: 풍화암" /></td>
                      <td style={{ padding: 2 }}><input type="number" step="0.1" value={r.depth_top} onChange={(e) => setRow(i, "depth_top", e.target.value)} style={inputStyle} /></td>
                      <td style={{ padding: 2 }}><input type="number" step="0.1" value={r.depth_bottom} onChange={(e) => setRow(i, "depth_bottom", e.target.value)} style={inputStyle} /></td>
                      <td style={{ padding: 2 }}>
                        <button onClick={() => delRow(i)} title="행 삭제" style={{ background: "transparent", border: "none", color: C.red, cursor: "pointer", fontSize: 12 }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={addRow} style={{ ...inputStyle, width: "auto", marginTop: 4, cursor: "pointer", color: C.secondary }}>+ 지층 추가</button>

              {/* 수정 사유 (필수) */}
              <div style={{ fontSize: 11, fontWeight: 700, color: C.text, margin: "12px 0 4px" }}>
                수정 사유 <span style={{ color: C.red }}>*</span>
              </div>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="예: PDF p.3 주상도 확인 — 심도 2530은 25.30의 단위 오류"
                rows={2}
                style={{ ...inputStyle, resize: "vertical" }}
              />

              {/* 버전 타임라인 */}
              <div style={{ fontSize: 11, fontWeight: 700, color: C.text, margin: "14px 0 4px" }}>버전 이력 (모두 보존)</div>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 5 }}>
                {[...history].reverse().map((h) => (
                  <div key={h.version} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderBottom: `1px solid ${C.border}`, fontSize: 10.5 }}>
                    <span style={{ fontWeight: 700, color: h.version === currentVersion ? C.green : C.tertiary, width: 26 }}>v{h.version}</span>
                    <span style={{ flex: 1, color: C.secondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.reason}>
                      {h.restored_from != null ? `↩ v${h.restored_from} 복원 — ` : ""}{h.reason}
                    </span>
                    <span style={{ color: C.tertiary, fontSize: 9.5 }}>{h.created_at ? h.created_at.slice(0, 16).replace("T", " ") : ""}</span>
                    {h.version !== currentVersion && (
                      <button onClick={() => restore(h.version)} disabled={saving} style={{ fontSize: 9.5, padding: "2px 6px", cursor: "pointer", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 3, color: C.secondary, fontFamily: "'Noto Sans KR',sans-serif" }}>
                        이 버전으로 복원
                      </button>
                    )}
                  </div>
                ))}
                {history.length === 0 && <div style={{ padding: 8, fontSize: 10.5, color: C.tertiary }}>이력을 불러오는 중...</div>}
              </div>
            </div>

            {/* ── 하단 액션 ── */}
            <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}` }}>
              {err && <div style={{ fontSize: 11, color: C.red, marginBottom: 6 }}>{err}</div>}
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button onClick={onClose} disabled={saving} style={{ padding: "6px 14px", fontSize: 12, cursor: "pointer", background: "transparent", color: C.tertiary, border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: "'Noto Sans KR',sans-serif" }}>
                  닫기
                </button>
                <button onClick={save} disabled={saving} style={{ padding: "6px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: C.active, color: C.text, border: `1px solid ${C.active}`, borderRadius: 5, fontFamily: "'Noto Sans KR',sans-serif" }}>
                  {saving ? "저장 중..." : `수정 저장 (새 버전 v${currentVersion + 1})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
