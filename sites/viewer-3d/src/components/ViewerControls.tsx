import React from "react"
import { MAP_URL } from "@shared/urls"
import { soilDetailSwatchStyle } from "@/lib/soilDetail"
import {
  LAYER_LABEL,
  STRATA_LAYER_KEYS,
  layerColorHex,
  normalizeHexColor,
  type LayerColorKey,
  type LayerColorOverrides,
} from "@/lib/layerColors"

export type Basemap = "Satellite" | "Hybrid" | "Base"

const C = {
  panel: "rgba(250,248,245,.97)",
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  btnActive: "#D4D1CB",
  btnBorder: "#BEBAB3",
  btnIdle: "#f2ede6",
  btnIdleBd: "#e9e4da",
  input: "#f2ede6",
  red: "#dc2626",
} as const

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  background: C.panel,
  padding: "14px 16px",
  borderRadius: 10,
  border: `1px solid ${C.border}`,
  boxShadow: "0 4px 18px rgba(0,0,0,.12)",
  minWidth: 250,
  maxHeight: "calc(100vh - 28px)",
  overflowY: "auto",
  zIndex: 10,
  color: C.text,
  fontFamily: "'Noto Sans KR',-apple-system,sans-serif",
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  background: C.input,
  color: C.text,
  border: `1px solid ${C.btnIdleBd}`,
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
  fontFamily: "'Noto Sans KR',sans-serif",
}

const btnBase: React.CSSProperties = {
  padding: "7px 9px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  transition: "all .15s",
  fontFamily: "'Noto Sans KR',sans-serif",
}

const segActive: React.CSSProperties = {
  flex: 1,
  ...btnBase,
  background: C.btnActive,
  color: C.text,
  border: `1px solid ${C.btnBorder}`,
  fontWeight: 600,
}

const segIdle: React.CSSProperties = {
  flex: 1,
  ...btnBase,
  background: C.btnIdle,
  color: C.secondary,
  border: `1px solid ${C.btnIdleBd}`,
}

const LANDFILL_PARENT = "매립토"
const LANDFILL_CHILDREN = ["매립 점토", "매립 사질토", "매립 자갈"]
const SEDIMENT_PARENT = "퇴적토"
const SEDIMENT_CHILDREN = ["퇴적점토", "퇴적 사질토", "퇴적자갈"]
const SOIL_DETAIL_GROUPS = [
  { kind: "landfill", parent: LANDFILL_PARENT, children: LANDFILL_CHILDREN },
  { kind: "sediment", parent: SEDIMENT_PARENT, children: SEDIMENT_CHILDREN },
] as const

interface ViewerControlsProps {
  basemap: Basemap
  setBasemap: (map: Basemap) => void
  showDrape: boolean
  setShowDrape: React.Dispatch<React.SetStateAction<boolean>>
  renderMode: "smooth" | "voxel"
  setRenderMode: (mode: "smooth" | "voxel") => void
  verticalExag: number
  setVerticalExag: (exag: number) => void
  depthBelowMSL: number
  setDepthBelowMSL: (depth: number) => void
  visibility: Record<string, boolean>
  setVisibility: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  showColumns: boolean
  setShowColumns: React.Dispatch<React.SetStateAction<boolean>>
  soilDetailLegend: string[]
  soilDetailVisibility: Record<string, boolean>
  setSoilDetailVisibility: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  layerColorOverrides: LayerColorOverrides
  setLayerColorOverride: (key: LayerColorKey, color: string | null) => void
  showGroundwater: boolean
  setShowGroundwater: React.Dispatch<React.SetStateAction<boolean>>
  groundwaterOpacity: number
  setGroundwaterOpacity: React.Dispatch<React.SetStateAction<number>>
  groundwaterObservationCount: number
  groundwaterCanBuildSurface: boolean
  groundwaterTerrainCapCount: number
  groundwaterAboveTerrainAnchorCount: number
  groundwaterWaterSurfaceCapCount: number
  groundwaterWaterFeatureCount: number
  groundwaterWaterSurfaceStatus: string
  coastalMaskStatus: string
  coastalPolygonCount: number
  basementMode: "extend" | "unknown"
  setBasementMode: (mode: "extend" | "unknown") => void
  onOpenExport: () => void
  sectionEnabled: boolean
  onToggleSection: () => void
}

export const ViewerControls: React.FC<ViewerControlsProps> = ({
  basemap,
  setBasemap,
  showDrape,
  setShowDrape,
  renderMode,
  setRenderMode,
  verticalExag,
  setVerticalExag,
  depthBelowMSL,
  setDepthBelowMSL,
  visibility,
  setVisibility,
  showColumns,
  setShowColumns,
  soilDetailLegend,
  soilDetailVisibility,
  setSoilDetailVisibility,
  layerColorOverrides,
  setLayerColorOverride,
  showGroundwater,
  setShowGroundwater,
  groundwaterOpacity,
  setGroundwaterOpacity,
  groundwaterObservationCount,
  groundwaterCanBuildSurface,
  groundwaterTerrainCapCount,
  groundwaterAboveTerrainAnchorCount,
  groundwaterWaterSurfaceCapCount,
  groundwaterWaterFeatureCount,
  groundwaterWaterSurfaceStatus,
  coastalMaskStatus,
  coastalPolygonCount,
  basementMode,
  setBasementMode,
  onOpenExport,
  sectionEnabled,
  onToggleSection,
}) => {
  const [editingColorKey, setEditingColorKey] = React.useState<LayerColorKey | null>(null)
  const [draftColor, setDraftColor] = React.useState("#8B7355")

  const openColorEditor = (key: LayerColorKey, event: React.MouseEvent) => {
    event.stopPropagation()
    setEditingColorKey(key)
    setDraftColor(layerColorHex(key, layerColorOverrides))
  }

  const closeColorEditor = () => setEditingColorKey(null)
  const editingLabel = editingColorKey
    ? editingColorKey.startsWith("soil_detail:")
      ? editingColorKey.slice("soil_detail:".length)
      : LAYER_LABEL[editingColorKey as keyof typeof LAYER_LABEL]
    : ""

  const soilDetailEntries = React.useMemo(() => {
    const entries: Array<{ type: "detail"; detail: string } | { type: "group"; group: typeof SOIL_DETAIL_GROUPS[number] }> = []
    const insertedGroups = new Set<string>()
    for (const detail of soilDetailLegend) {
      const group = SOIL_DETAIL_GROUPS.find((candidate) => candidate.parent === detail || candidate.children.includes(detail))
      if (group) {
        if (!insertedGroups.has(group.kind)) {
          entries.push({ type: "group", group })
          insertedGroups.add(group.kind)
        }
        continue
      }
      entries.push({ type: "detail", detail })
    }
    return entries
  }, [soilDetailLegend])

  const renderColorButton = (key: LayerColorKey, disabled = false) => {
    const color = layerColorHex(key, layerColorOverrides)
    const label = key.startsWith("soil_detail:")
      ? key.slice("soil_detail:".length)
      : LAYER_LABEL[key as keyof typeof LAYER_LABEL]
    return (
      <button
        type="button"
        aria-label={`${label || "지층"} 색상 편집`}
        title="색상 편집"
        disabled={disabled}
        onClick={(event) => openColorEditor(key, event)}
        style={{
          width: 20,
          height: 20,
          borderRadius: 4,
          border: `1px solid ${C.btnBorder}`,
          background: color,
          cursor: disabled ? "default" : "pointer",
          marginLeft: "auto",
          padding: 0,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,.28)",
          flexShrink: 0,
        }}
      />
    )
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontSize: 12, color: C.tertiary }}>KH Geo · 2단계</div>
      <h1 style={{ margin: "2px 0 4px 0", fontSize: 16, fontWeight: 700 }}>3D 지질 뷰어</h1>
      <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 10 }}>
        Three.js 기반 지층 형상 뷰어
      </div>

      <button
        onClick={() => {
          window.location.href = MAP_URL
        }}
        style={{
          width: "100%",
          padding: "7px 0",
          borderRadius: 6,
          background: "rgba(232,83,58,.15)",
          border: `1px solid ${C.red}`,
          color: C.red,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          fontFamily: "'Noto Sans KR',sans-serif",
          marginBottom: 6,
        }}
      >
        1단계 지도로 돌아가기
      </button>

      <button
        onClick={onOpenExport}
        style={{
          width: "100%",
          padding: "7px 0",
          borderRadius: 6,
          background: "rgba(160,155,148,.15)",
          border: "1px solid #BEBAB3",
          color: C.text,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          fontFamily: "'Noto Sans KR',sans-serif",
          marginBottom: 12,
        }}
      >
        데이터 내보내기
      </button>

      <button
        onClick={onToggleSection}
        style={{
          width: "100%",
          padding: "7px 0",
          borderRadius: 6,
          background: sectionEnabled ? "rgba(8,145,178,.18)" : C.btnIdle,
          border: `1px solid ${sectionEnabled ? "#0891b2" : C.btnIdleBd}`,
          color: sectionEnabled ? "#0e7490" : C.secondary,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          fontFamily: "'Noto Sans KR',sans-serif",
          marginBottom: 12,
        }}
      >
        {sectionEnabled ? "수직 단면 편집" : "수직 단면"}
      </button>

      <div
        onClick={() => setShowDrape((s) => !s)}
        style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          fontSize: 12,
          cursor: "pointer",
          userSelect: "none",
          opacity: showDrape ? 1 : 0.5,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            width: 13,
            height: 13,
            borderRadius: 3,
            marginRight: 8,
            background: showDrape ? C.btnActive : C.btnIdle,
            border: "1px solid rgba(255,255,255,.2)",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        표면 지도 표시
        <span style={{ marginLeft: "auto", fontSize: 10, color: C.tertiary }}>{showDrape ? "켬" : "끔"}</span>
      </div>
      <select value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)} style={selectStyle} disabled={!showDrape}>
        <option value="Base">일반지도 (VWorld)</option>
        <option value="Satellite">항공사진</option>
        <option value="Hybrid">항공사진 + 라벨</option>
      </select>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>렌더 방식</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setRenderMode("smooth")} style={renderMode === "smooth" ? segActive : segIdle}>
            매끄러운 면
          </button>
          <button onClick={() => setRenderMode("voxel")} style={renderMode === "voxel" ? segActive : segIdle}>
            복셀
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>수직 과장 배율: {verticalExag}배</div>
        <input
          type="range"
          min={1}
          max={20}
          step={1}
          value={verticalExag}
          onChange={(e) => setVerticalExag(Number(e.target.value))}
          style={{ width: "100%", accentColor: C.btnActive }}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 12 }}>모델 바닥 깊이 (m):</span>
          <input
            type="number"
            min={10}
            max={100}
            step={1}
            value={depthBelowMSL}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) setDepthBelowMSL(Math.max(10, Math.min(100, v)))
            }}
            style={{
              width: 50,
              background: C.input,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              color: C.text,
              fontSize: 11,
              textAlign: "center",
              padding: "1px 3px",
              outline: "none",
            }}
          />
        </div>
        <input
          type="range"
          min={10}
          max={100}
          step={2}
          value={depthBelowMSL}
          onChange={(e) => setDepthBelowMSL(Number(e.target.value))}
          style={{ width: "100%", accentColor: C.btnActive }}
        />
        <div
          onClick={() => setShowColumns((s) => !s)}
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            fontSize: 12,
            cursor: "pointer",
            userSelect: "none",
            opacity: showColumns ? 1 : 0.5,
          }}
        >
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 3,
              marginRight: 8,
              background: showColumns ? C.btnActive : C.btnIdle,
              border: `1px solid ${C.btnIdleBd}`,
              flexShrink: 0,
            }}
          />
          시추공 기둥 표시
          <span style={{ marginLeft: "auto", fontSize: 10, color: C.tertiary }}>{showColumns ? "켬" : "끔"}</span>
        </div>
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 6 }}>지층 표시 제어</div>
        {STRATA_LAYER_KEYS.map((key) => {
          const on = visibility[key]
          const disabled = key === "unknown" && basementMode === "extend"
          return (
            <React.Fragment key={key}>
              <div
                onClick={disabled ? undefined : () => setVisibility((v) => ({ ...v, [key]: !v[key] }))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  fontSize: 12,
                  margin: "3px 0",
                  padding: "2px 4px",
                  borderRadius: 4,
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.22 : on ? 1 : 0.38,
                  userSelect: "none",
                }}
              >
                <span
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 3,
                    marginRight: 8,
                    background: layerColorHex(key, layerColorOverrides),
                    border: "1px solid rgba(255,255,255,.2)",
                    flexShrink: 0,
                  }}
                />
                {LAYER_LABEL[key]}
                {renderColorButton(key, disabled)}
              </div>
              {key === "soil" && soilDetailLegend.length > 0 && (
                <div style={{ margin: "2px 0 6px 21px", display: "grid", gap: 3 }}>
                  {soilDetailEntries.map((entry) => {
                    if (entry.type === "group") {
                      const { parent, children, kind } = entry.group
                      const availableChildren = children.filter((detail) => soilDetailLegend.includes(detail))
                      const groupDetails = [
                        ...(soilDetailLegend.includes(parent) ? [parent] : []),
                        ...availableChildren,
                      ]
                      const groupOn = groupDetails.some((detail) => soilDetailVisibility[detail] !== false)
                      const groupAllOn = groupDetails.every((detail) => soilDetailVisibility[detail] !== false)
                      const parentColorKey = `soil_detail:${parent}` as LayerColorKey
                      return (
                        <React.Fragment key={`${kind}-group`}>
                          <div
                            onClick={on ? () => setSoilDetailVisibility((value) => {
                              const next = { ...value }
                              const nextOn = !groupAllOn
                              for (const detail of groupDetails) next[detail] = nextOn
                              return next
                            }) : undefined}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              minWidth: 0,
                              fontSize: 11,
                              color: C.secondary,
                              cursor: on ? "pointer" : "default",
                              opacity: on ? (groupOn ? 1 : 0.38) : 0.22,
                              userSelect: "none",
                              fontWeight: 600,
                            }}
                          >
                            <span
                              style={{
                                width: 12,
                                height: 12,
                                borderRadius: 3,
                                marginRight: 7,
                                ...soilDetailSwatchStyle(parent, layerColorHex(parentColorKey, layerColorOverrides)),
                                border: `1px solid ${C.btnIdleBd}`,
                                flexShrink: 0,
                              }}
                            />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parent}</span>
                            {renderColorButton(parentColorKey, !on)}
                          </div>
                          {availableChildren.map((detail) => {
                            const detailOn = soilDetailVisibility[detail] !== false
                            const detailColorKey = `soil_detail:${detail}` as LayerColorKey
                            return (
                              <div
                                key={detail}
                                onClick={on ? () => setSoilDetailVisibility((value) => ({ ...value, [detail]: !detailOn })) : undefined}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  minWidth: 0,
                                  marginLeft: 16,
                                  fontSize: 11,
                                  color: C.secondary,
                                  cursor: on ? "pointer" : "default",
                                  opacity: on ? (detailOn ? 1 : 0.38) : 0.22,
                                  userSelect: "none",
                                }}
                              >
                                <span
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 3,
                                    marginRight: 7,
                                    ...soilDetailSwatchStyle(detail, layerColorHex(detailColorKey, layerColorOverrides)),
                                    border: `1px solid ${C.btnIdleBd}`,
                                    flexShrink: 0,
                                  }}
                                />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
                                {renderColorButton(detailColorKey, !on)}
                              </div>
                            )
                          })}
                        </React.Fragment>
                      )
                    }
                    const detail = entry.detail
                    const detailOn = soilDetailVisibility[detail] !== false
                    const detailColorKey = `soil_detail:${detail}` as LayerColorKey
                    return (
                      <div
                        key={detail}
                        onClick={on ? () => setSoilDetailVisibility((value) => ({ ...value, [detail]: !detailOn })) : undefined}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          minWidth: 0,
                          fontSize: 11,
                          color: C.secondary,
                          cursor: on ? "pointer" : "default",
                          opacity: on ? (detailOn ? 1 : 0.38) : 0.22,
                          userSelect: "none",
                        }}
                      >
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: 3,
                            marginRight: 7,
                            ...soilDetailSwatchStyle(detail, layerColorHex(detailColorKey, layerColorOverrides)),
                            border: `1px solid ${C.btnIdleBd}`,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
                        {renderColorButton(detailColorKey, !on)}
                      </div>
                    )
                  })}
                </div>
              )}
            </React.Fragment>
          )
        })}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>미분류 구간 처리</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              onClick={() => setBasementMode("extend")}
              style={{
                ...(basementMode === "extend" ? segActive : segIdle),
                lineHeight: "1.2",
                padding: "4px 2px",
                fontSize: 11,
                flex: 1,
              }}
            >
              연장
            </button>
            <button
              onClick={() => setBasementMode("unknown")}
              style={{
                ...(basementMode === "unknown" ? segActive : segIdle),
                lineHeight: "1.2",
                padding: "4px 2px",
                fontSize: 11,
                flex: 1,
              }}
            >
              미분류 유지
            </button>
          </div>
        </div>
        {editingColorKey && (
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: "rgba(255,255,255,.72)",
              boxShadow: "0 6px 16px rgba(28,25,23,.12)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{editingLabel} 색상</span>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  background: draftColor,
                  border: `1px solid ${C.btnBorder}`,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,.35)",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="color"
                value={normalizeHexColor(draftColor) ?? layerColorHex(editingColorKey, layerColorOverrides)}
                onChange={(event) => setDraftColor(event.target.value.toUpperCase())}
                style={{ width: 34, height: 28, padding: 0, border: `1px solid ${C.border}`, background: "transparent", cursor: "pointer" }}
              />
              <input
                value={draftColor}
                onChange={(event) => setDraftColor(event.target.value.toUpperCase())}
                onBlur={() => setDraftColor(normalizeHexColor(draftColor) ?? layerColorHex(editingColorKey, layerColorOverrides))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 28,
                  boxSizing: "border-box",
                  background: C.input,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  color: C.text,
                  fontSize: 11,
                  padding: "4px 6px",
                  outline: "none",
                  fontFamily: "'Noto Sans KR',sans-serif",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setLayerColorOverride(editingColorKey, null)
                  setDraftColor(layerColorHex(editingColorKey))
                }}
                style={{ ...segIdle, flex: 1, padding: "5px 4px", fontSize: 11 }}
              >
                기본값
              </button>
              <button type="button" onClick={closeColorEditor} style={{ ...segIdle, flex: 1, padding: "5px 4px", fontSize: 11 }}>
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  setLayerColorOverride(editingColorKey, normalizeHexColor(draftColor))
                  closeColorEditor()
                }}
                style={{ ...segActive, flex: 1, padding: "5px 4px", fontSize: 11 }}
              >
                적용
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 6 }}>수리 정보</div>
        <div
          onClick={() => setShowGroundwater((value) => !value)}
          style={{ display: "flex", alignItems: "center", fontSize: 12, cursor: "pointer", opacity: showGroundwater ? 1 : 0.45 }}
        >
          <span style={{ width: 13, height: 13, borderRadius: 3, marginRight: 8, background: "#22b8cf", border: "1px solid #0891b2" }} />
          지하수 포화영역
          <span style={{ marginLeft: "auto", fontSize: 10, color: C.tertiary }}>{showGroundwater ? "켬" : "끔"}</span>
        </div>
        <div
          style={{ marginTop: 7, fontSize: 11, color: groundwaterCanBuildSurface ? C.secondary : C.red, cursor: "help" }}
          title={`지표 제한: ${groundwaterTerrainCapCount}점 · 수면 제한: ${groundwaterWaterSurfaceCapCount}점 · 수계: ${groundwaterWaterFeatureCount}개 (${groundwaterWaterSurfaceStatus}) · 지표 초과: ${groundwaterAboveTerrainAnchorCount}점 · 해안 마스크: ${coastalMaskStatus} (${coastalPolygonCount}개)`}
        >
          실측 {groundwaterObservationCount}개 · {groundwaterCanBuildSurface ? "솔리드 정상" : "3개 미만: 솔리드 불가"}
        </div>
        <div style={{ marginTop: 7, fontSize: 11, color: C.tertiary }}>
          투명도 {Math.round(groundwaterOpacity * 100)}%
        </div>
        <input
          type="range"
          min={0.15}
          max={0.8}
          step={0.05}
          value={groundwaterOpacity}
          disabled={!showGroundwater}
          onChange={(event) => setGroundwaterOpacity(Number(event.target.value))}
          style={{ width: "100%", accentColor: "#0891b2" }}
        />
      </div>
    </div>
  )
}
