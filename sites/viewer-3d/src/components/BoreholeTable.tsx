import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Borehole } from "@/lib/types"
import { LAYER_LABEL, layerColorHex, type LayerColorOverrides } from "@/lib/layerColors"

const C = {
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  inner: "#f2ede6",
  active: "#D4D1CB",
  warnOr: "#d97706",
  warnRd: "#dc2626",
  warnCr: "#991b1b",
} as const

const tablePanelStyle: React.CSSProperties = {
  width: 320,
  height: "100%",
  background: "rgba(250,248,245,.99)",
  borderLeft: `1px solid ${C.border}`,
  color: C.text,
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Noto Sans KR',sans-serif",
  zIndex: 10,
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 6px",
  color: C.tertiary,
  fontWeight: 600,
  borderBottom: `1px solid ${C.border}`,
}
const thNumStyle: React.CSSProperties = { ...thStyle, textAlign: "right", padding: "6px 3px" }

const tdStyle: React.CSSProperties = {
  padding: "3px 6px",
  color: C.secondary,
  height: 28,
  lineHeight: "18px",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
}
const tdNumStyle: React.CSSProperties = { ...tdStyle, textAlign: "right", padding: "3px 3px" }

interface BoreholeTableProps {
  boreholes: (Borehole & { dem_elevation?: number })[]
  selectedBh: string | null
  setSelectedBh: (id: string | null) => void
  focusBorehole: (id: string) => void
  onUpdateElevation?: (bhId: string, newElev: number) => Promise<void>
  onEditData?: (b: Borehole & { dem_elevation?: number }) => void
  onManageVirtual?: () => void
  onInspectData?: (b: Borehole & { dem_elevation?: number }) => void // [v4.2] PDF 대조 패널 열기
  layerColorOverrides?: LayerColorOverrides
  enabledBoreholeIds?: Set<string>
  onToggleBoreholeEnabled?: (id: string, enabled: boolean) => void
  onSetBoreholesEnabled?: (ids: string[], enabled: boolean) => void
}

export const BoreholeTable: React.FC<BoreholeTableProps> = ({
  boreholes,
  selectedBh,
  setSelectedBh,
  focusBorehole,
  onUpdateElevation,
  onInspectData,
  onEditData,
  onManageVirtual,
  layerColorOverrides,
  enabledBoreholeIds,
  onToggleBoreholeEnabled,
  onSetBoreholesEnabled,
}) => {
  const [filterMode, setFilterMode] = useState<"all" | "existing" | "new" | "virtual" | "warn" | "edited">("all")
  const [editingBhId, setEditingBhId] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // 3D 클릭으로 selectedBh가 바뀌면 필터를 "전체"로 전환 후 해당 행으로 스크롤
  // ※ requestAnimationFrame은 React 재렌더링 전에 실행될 수 있어 setTimeout(50) 사용
  useEffect(() => {
    if (selectedBh === null || !scrollContainerRef.current) return
    setFilterMode("all")
    const timer = setTimeout(() => {
      // Number·String 혼재 대응: 양측을 String으로 통일하여 비교
      const row = scrollContainerRef.current?.querySelector(`tr[data-bhid="${selectedBh}"]`)
      row?.scrollIntoView({ block: "center", behavior: "smooth" })
    }, 50)
    return () => clearTimeout(timer)
  }, [selectedBh])
  const [editVal, setEditVal] = useState<string>("")
  const [isSaving, setIsSaving] = useState(false)
  const [editLogs, setEditLogs] = useState<Record<string, { original: number; modified: number; time: string }>>({})

  const maxDepth = useCallback((b: Borehole) => {
    if (!b.strata?.length) return 0
    return Math.max(...b.strata.map((s) => s.depth_bottom ?? 0))
  }, [])

  // 1. 개별 오차 및 심각도 판정 헬퍼
  const getElevationInfo = useCallback((b: Borehole & { dem_elevation?: number }) => {
    const dem = b.dem_elevation ?? b.elevation
    const delta = b.elevation - dem
    const diff = Math.abs(delta)
    
    let severity: "normal" | "minor" | "major" | "critical" = "normal"
    if (diff >= 2.0) severity = "critical"
    else if (diff >= 1.0) severity = "major"
    else if (diff >= 0.5) severity = "minor"
    
    return { dem, delta, diff, severity }
  }, [])

  // [v4.2] 이상 심도·개정 상태 헬퍼
  const isDepthWarn = (b: Borehole) => Boolean((b as any).depth_warning)
  const isRevised = (b: Borehole) => (b as any).data_status === "revised"
  const isProjectNew = (b: Borehole) =>
    (b as any).project_role ? (b as any).project_role === "new" : Boolean((b as any).is_supplementary)
  const isVirtual = (b: Borehole) => Boolean((b as any).is_virtual)

  // 2. 필터링 대상 시추공 분류
  const filteredBoreholes = boreholes.filter((b) => {
    const { diff } = getElevationInfo(b)
    if (filterMode === "existing") return !isVirtual(b) && !isProjectNew(b)
    if (filterMode === "new") return !isVirtual(b) && isProjectNew(b)
    if (filterMode === "virtual") return isVirtual(b)
    if (filterMode === "warn") return !isVirtual(b) && (diff >= 0.5 || isDepthWarn(b))
    if (filterMode === "edited") return !isVirtual(b) && (editLogs[b.id] !== undefined || isRevised(b))
    return !isVirtual(b)
  })

  const warnCount = boreholes.filter((b) => getElevationInfo(b).diff >= 0.5 || isDepthWarn(b)).length

  const groupedBoreholes = useMemo(() => {
    const map = new Map<string, { key: string; label: string; items: (Borehole & { dem_elevation?: number })[]; isVirtual: boolean }>()
    for (const borehole of filteredBoreholes) {
      const key = groupKey(borehole)
      const current = map.get(key)
      if (current) {
        current.items.push(borehole)
      } else {
        map.set(key, {
          key,
          label: groupLabel(borehole),
          items: [borehole],
          isVirtual: isVirtual(borehole),
        })
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1
      return a.label.localeCompare(b.label, "ko")
    })
  }, [filteredBoreholes])

  useEffect(() => {
    setExpandedGroups((previous) => {
      const next = { ...previous }
      for (const group of groupedBoreholes) {
        if (next[group.key] === undefined) next[group.key] = true
      }
      return next
    })
  }, [groupedBoreholes])

  const handleStartEdit = (b: Borehole & { dem_elevation?: number }, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingBhId(b.id)
    setEditVal(b.elevation.toFixed(2))
  }

  const handleSaveEdit = async (b: Borehole & { dem_elevation?: number }) => {
    const num = parseFloat(editVal)
    if (isNaN(num)) return
    
    try {
      setIsSaving(true)
      if (onUpdateElevation) {
        await onUpdateElevation(b.id, num)
      }
      // 수정 이력 로그 업데이트
      setEditLogs((prev) => ({
        ...prev,
        [b.id]: {
          original: b.elevation,
          modified: num,
          time: new Date().toLocaleTimeString(),
        },
      }))
      setEditingBhId(null)
    } catch (err) {
      alert("표고 보정 실패: " + err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div style={tablePanelStyle}>
      {/* A. 상단 타이틀 영역 */}
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>시추공 데이터</span>
          {warnCount > 0 && (
            <span style={{ fontSize: 10, background: "rgba(239,68,68,.18)", color: C.warnRd, padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
              ⚠️ 경고 {warnCount}개
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: C.tertiary, marginTop: 2 }}>
          실제 {boreholes.filter((b) => !(b as any).is_virtual).length}개
          {" · "}가상 {boreholes.filter((b) => Boolean((b as any).is_virtual)).length}개
        </div>
      </div>

      {/* B. 필터링 버튼 바 */}
      <div style={{ display: "flex", padding: "6px 10px", gap: 4, borderBottom: `1px solid ${C.border}`, background: "rgba(242,237,230,.6)" }}>
        {(["all", "existing", "new", "virtual", "warn", "edited"] as const).map((mode) => {
          const active = filterMode === mode
          const label = mode === "all" ? "전체" : mode === "existing" ? "기존" : mode === "new" ? "신규" : mode === "warn" ? "경고" : "보정"
          const labels = { all: "전체", warn: "경고대상", edited: "보정이력" }
          const displayLabel = mode === "virtual" ? "가상" : label
          return (
            <button
              key={mode}
              onClick={() => {
                setFilterMode(mode)
                if (mode === "all" || mode === "existing" || mode === "new") {
                  window.dispatchEvent(new CustomEvent("geobim:model-source-change", { detail: mode }))
                }
              }}
              style={{
                flex: 1,
                fontSize: 10,
                padding: "3px 0",
                cursor: "pointer",
                border: `1px solid ${active ? C.border : "transparent"}`,
                borderRadius: 4,
                background: active ? "rgba(160,155,148,.18)" : "transparent",
                color: active ? "#1c1917" : C.tertiary,
                fontWeight: active ? 600 : 400,
                fontFamily: "'Noto Sans KR',sans-serif",
              }}
            >
              {displayLabel}
            </button>
          )
        })}
      </div>

      {/* C. 테이블 뷰포트 */}
      <div ref={scrollContainerRef} style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        <table style={{ width: "100%", maxWidth: "100%", borderCollapse: "collapse", fontSize: 11, tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 120 }} />
            <col style={{ width: 39 }} />
            <col style={{ width: 39 }} />
            <col style={{ width: 96 }} />
          </colgroup>
          <thead>
            <tr style={{ position: "sticky", top: 0, background: C.inner, zIndex: 5 }}>
              <th style={thStyle}>공명</th>
              <th style={thNumStyle}>표고(m)</th>
              <th style={thNumStyle}>심도(m)</th>
              <th style={thStyle}>지층</th>
            </tr>
          </thead>
          <tbody>
            {groupedBoreholes.map((group) => {
              const rowIds = group.items.filter((row) => !isVirtual(row)).map((row) => String(row.id))
              const selectedCount = rowIds.filter((id) => enabledBoreholeIds?.has(id) ?? true).length
              const allSelected = rowIds.length > 0 && selectedCount === rowIds.length
              const partiallySelected = selectedCount > 0 && selectedCount < rowIds.length
              const expanded = expandedGroups[group.key] !== false
              return (
                <React.Fragment key={group.key}>
                  <tr
                    onClick={() => setExpandedGroups((previous) => ({ ...previous, [group.key]: !expanded }))}
                    style={{ borderBottom: `1px solid ${C.border}`, background: "rgba(242,237,230,.72)", cursor: "pointer" }}
                  >
                    <td colSpan={4} style={{ padding: "6px 8px", color: C.text, fontWeight: 700, height: 30 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span style={{ width: 12, color: C.tertiary, fontSize: 12 }}>{expanded ? "v" : ">"}</span>
                        {!group.isVirtual && (
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(element) => {
                              if (element) element.indeterminate = partiallySelected
                            }}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              onSetBoreholesEnabled?.(rowIds, event.currentTarget.checked)
                              if (!event.currentTarget.checked && selectedBh && rowIds.includes(String(selectedBh))) setSelectedBh(null)
                            }}
                            style={{ width: 13, height: 13, margin: 0, accentColor: "#78716c", cursor: "pointer" }}
                          />
                        )}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{group.label}</span>
                        <span style={{ flex: "0 0 auto", border: `1px solid ${C.border}`, borderRadius: 999, padding: "1px 6px", color: C.tertiary, background: "rgba(250,248,245,.9)", fontSize: 10, fontWeight: 500 }}>
                          {group.items.length}개
                        </span>
                      </div>
                    </td>
                  </tr>
                  {expanded && group.items.map((b) => {
              const depth = maxDepth(b)
              // Number(selectedBh) vs String(b.id) 혼재 대응: String으로 통일
              const sel = selectedBh !== null && String(selectedBh) === String(b.id)
              const { dem, diff, severity } = getElevationInfo(b)
              const isEdited = editLogs[b.id] !== undefined
              
              // 심각도 아이콘 점 렌더링
              let badgeDot = null
              if (isDepthWarn(b)) {
                badgeDot = <span title={`⚠️ 심도 이상 의심: ${depth.toFixed(1)}m — 심도 클릭 시 PDF 대조 확인`} style={{ display: "inline-block", width: 8, height: 8, background: "#7c3aed", borderRadius: "50%", marginRight: 5, animation: "pulse 1.5s infinite" }} />
              } else if (severity === "critical") {
                badgeDot = <span title={`🚨 표고 심각한 오차: ${diff.toFixed(2)}m (DEM: ${dem.toFixed(1)}m)`} style={{ display: "inline-block", width: 8, height: 8, background: C.warnCr, borderRadius: "50%", marginRight: 5, animation: "pulse 1.5s infinite" }} />
              } else if (severity === "major") {
                badgeDot = <span title={`🔴 표고 요주의 오차: ${diff.toFixed(2)}m (DEM: ${dem.toFixed(1)}m)`} style={{ display: "inline-block", width: 7, height: 7, background: C.warnRd, borderRadius: "50%", marginRight: 5 }} />
              } else if (severity === "minor") {
                badgeDot = <span title={`🟡 표고 경미한 오차: ${diff.toFixed(2)}m (DEM: ${dem.toFixed(1)}m)`} style={{ display: "inline-block", width: 7, height: 7, background: C.warnOr, borderRadius: "50%", marginRight: 5 }} />
              } else if (isEdited) {
                badgeDot = <span title="✅ 표고 수동 보정 완료" style={{ display: "inline-block", width: 7, height: 7, background: "#10b981", borderRadius: "50%", marginRight: 5 }} />
              }

              return (
                <React.Fragment key={b.id}>
                  <tr
                    data-bhid={b.id}
                    onClick={() => {
                      if (sel) setSelectedBh(null)
                      else focusBorehole(b.id)
                    }}
                    style={{
                      borderBottom: `1px solid ${C.border}`,
                      cursor: "pointer",
                      background: sel ? "rgba(160,155,148,.15)" : "transparent",
                    }}
                  >
                    <td style={{ ...tdStyle, padding: "3px 4px", fontWeight: sel ? 700 : 400, display: "flex", alignItems: "center", gap: 3, minWidth: 0, overflow: "hidden" }}>
                      {!isVirtual(b) && (
                        <input
                          type="checkbox"
                          checked={enabledBoreholeIds?.has(String(b.id)) ?? true}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            onToggleBoreholeEnabled?.(String(b.id), event.currentTarget.checked)
                            if (!event.currentTarget.checked && sel) setSelectedBh(null)
                          }}
                          style={{ width: 12, height: 12, margin: 0, flex: "0 0 auto", accentColor: "#78716c", cursor: "pointer" }}
                        />
                      )}
                      {badgeDot}
                      <span title={b.name} style={{ textDecoration: isEdited ? "underline" : "none", overflow: "visible", whiteSpace: "nowrap", fontSize: 10.5 }}>{b.name}</span>
                      {isRevised(b) && (
                        <span title={`✎ 수정됨 (v${(b as any).revision_version ?? "?"}) — 원본 보존`} style={{ color: "#10b981", marginLeft: 3, fontSize: 10 }}>✎</span>
                      )}
                    </td>
                    <td style={tdNumStyle}>
                      <span
                        onClick={(e) => handleStartEdit(b, e)}
                        title="클릭 시 표고 인라인 보정 팝오버 활성화"
                        style={{
                          borderBottom: diff >= 0.5 ? `1px dashed ${severity === "critical" ? C.warnCr : severity === "major" ? C.warnRd : C.warnOr}` : "none",
                          color: isEdited ? "#10b981" : diff >= 0.5 ? (severity === "critical" ? "#ff7b7b" : C.warnOr) : C.secondary,
                          padding: "2px 4px",
                          borderRadius: 3,
                          background: diff >= 0.5 ? "rgba(255,255,255,0.03)" : "transparent",
                        }}
                      >
                        {b.elevation?.toFixed(1)}
                      </span>
                    </td>
                    <td style={tdNumStyle}>
                      {isDepthWarn(b) && onInspectData ? (
                        <span
                          onClick={(e) => { e.stopPropagation(); onInspectData(b) }}
                          title="심도 이상 의심 — 클릭하여 원본 PDF와 대조 확인"
                          style={{ color: "#7c3aed", borderBottom: "1px dashed #7c3aed", cursor: "pointer", fontWeight: 700 }}
                        >
                          {depth.toFixed(1)}
                        </span>
                      ) : (
                        depth.toFixed(1)
                      )}
                    </td>
                    <td style={{ ...tdStyle, overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 1, overflow: "hidden", flexWrap: "nowrap", minWidth: 0 }}>
                      {uniqueLayerGroups(b).map((grp, i) => {
                        const col = layerColorHex(grp, layerColorOverrides)
                        const lbl = LAYER_LABEL[grp as keyof typeof LAYER_LABEL] ?? grp
                        return (
                          <span
                            key={`${grp}-${i}`}
                            title={lbl}
                            style={{
                              display: "inline-block",
                                  width: 8,
                                  height: 8,
                              flex: "0 0 auto",
                              borderRadius: 1,
                              background: col,
                            }}
                          />
                        )
                      })}
                        </div>
                      {onEditData && !isVirtual(b) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onEditData(b) }}
                          title="지층 데이터 편집"
                          style={{
                            flex: "0 0 auto",
                            padding: "1px 3px",
                            borderRadius: 3,
                            border: `1px solid ${C.border}`,
                            background: "transparent",
                            color: C.secondary,
                            cursor: "pointer",
                            fontSize: 10,
                            fontFamily: "'Noto Sans KR',sans-serif",
                          }}
                        >
                          편집
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>

                  {/* D. 인라인 표고 보정 팝오버 편집 폼 */}
                  {editingBhId === b.id && (
                    <tr style={{ background: "rgba(242,237,230,.95)" }}>
                      <td colSpan={4} style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}` }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", color: C.tertiary }}>
                            <span>지형(DEM) 표고: <strong>{dem.toFixed(2)}m</strong></span>
                            <span style={{ color: diff >= 0.5 ? C.warnRd : C.tertiary }}>
                              차이: <strong>{(b.elevation - dem).toFixed(2)}m</strong>
                            </span>
                          </div>
                          
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input
                              type="number"
                              step="0.01"
                              value={editVal}
                              onChange={(e) => setEditVal(e.target.value)}
                              disabled={isSaving}
                              style={{
                                flex: 1,
                                background: C.inner,
                                border: `1px solid ${C.border}`,
                                borderRadius: 4,
                                color: "#fff",
                                padding: "4px 8px",
                                fontSize: 11,
                                outline: "none",
                              }}
                            />
                            
                            <button
                              onClick={() => setEditVal(dem.toFixed(2))}
                              disabled={isSaving}
                              title="DEM 표고값으로 자동 매핑"
                              style={{
                                padding: "4px 8px",
                                background: "rgba(245,158,11,.15)",
                                border: `1px solid ${C.warnOr}`,
                                borderRadius: 4,
                                color: C.warnOr,
                                fontSize: 10,
                                cursor: "pointer",
                                fontFamily: "'Noto Sans KR',sans-serif",
                              }}
                            >
                              DEM자동보정
                            </button>
                          </div>

                          {isEdited && (
                            <div style={{ fontSize: 9, color: "#10b981" }}>
                              이력: {editLogs[b.id].original.toFixed(2)}m → {editLogs[b.id].modified.toFixed(2)}m ({editLogs[b.id].time})
                            </div>
                          )}

                          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 4 }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); setEditingBhId(null); }}
                              disabled={isSaving}
                              style={{
                                padding: "3px 8px",
                                background: "transparent",
                                border: `1px solid ${C.border}`,
                                borderRadius: 3,
                                color: C.tertiary,
                                cursor: "pointer",
                                fontSize: 10,
                              }}
                            >
                              취소
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleSaveEdit(b); }}
                              disabled={isSaving}
                              style={{
                                padding: "3px 8px",
                                background: C.active,
                                border: `1px solid ${C.active}`,
                                borderRadius: 3,
                                color: "#fff",
                                cursor: "pointer",
                                fontSize: 10,
                                fontWeight: 600,
                              }}
                            >
                              {isSaving ? "보정 중..." : "보정 완료"}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
                  })}
                </React.Fragment>
              )
            })}
            {filteredBoreholes.length === 0 && (
              <tr>
                <td colSpan={4} style={{ ...tdStyle, color: "#6a7a98", textAlign: "center", padding: 20 }}>
                  해당 조건의 시추공이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function uniqueLayerGroups(b: Borehole) {
  const groups: string[] = []
  for (const s of b.strata || []) {
    const group = s.strata_group || "unknown"
    if (!groups.includes(group)) groups.push(group)
  }
  return groups
}

function groupKey(b: Borehole) {
  if ((b as any).is_virtual) return "virtual"
  const jobId = (b as any).registered_from_job_id
  if (jobId !== undefined && jobId !== null) return `job:${jobId}`
  const sourceFile = String((b as any).source_file || "").trim()
  return sourceFile ? `file:${sourceFile}` : "file:unknown"
}

function groupLabel(b: Borehole) {
  if ((b as any).is_virtual) return "가상 시추공"
  const jobId = (b as any).registered_from_job_id
  if (jobId !== undefined && jobId !== null) return `CSV 업로드 #${jobId}`
  const sourceFile = String((b as any).source_file || "").trim()
  if (!sourceFile) return "업로드 파일 미상"
  const parts = sourceFile.split(/[\\/]/)
  return parts[parts.length - 1] || sourceFile
}
