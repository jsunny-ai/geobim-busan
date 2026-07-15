import { useCallback, useRef, useState, useEffect, useMemo } from "react"
import { BoreholeTable } from "../components/BoreholeTable"
import { BoreholeEditPanel } from "../components/BoreholeEditPanel"
import { DepthWarningModal } from "../components/DepthWarningModal"
import { PdfComparePanel } from "../components/PdfComparePanel"
import { DataExportModal } from "../components/DataExportModal"
import { VirtualBoreholeManager } from "../components/VirtualBoreholeManager"
import { ViewerControls, type Basemap } from "../components/ViewerControls"
import { SectionControls } from "../components/SectionControls"
import { useBoreholeData } from "../hooks/useBoreholeData"
import { useGeoModel, type GeoModelSettings } from "../hooks/useGeoModel"
import { useGroundwaterModel } from "../hooks/useGroundwaterModel"
import { useWaterSurfaceModel } from "../hooks/useWaterSurfaceModel"
import { useCoastalLandMask } from "../hooks/useCoastalLandMask"
import { useSectionPlane } from "../hooks/useSectionPlane"
import { useThreeScene } from "../hooks/useThreeScene"
import { parseUrlParams } from "@/lib/parseUrl"
import { DEFAULT_VERTICAL_SECTION_STATE, type Borehole } from "@/lib/types"
import { normalizeSoilDetailName, SOIL_DETAIL_TYPES } from "@/lib/soilDetail"
import { colorStorageKey, normalizeHexColor, type LayerColorKey, type LayerColorOverrides } from "@/lib/layerColors"
import {
  boreholeSelectionStorageKey,
  parseStoredBoreholeSelection,
  reconcileBoreholeSelection,
  serializeBoreholeSelection,
} from "@/lib/boreholeSelection"
import type { Bbox } from "@/lib/projection"
import { MAP_URL, apiUrl } from "@shared/urls"

const C = {
  bg: "#faf8f5",
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  red: "#dc2626",
} as const

const statusBar: React.CSSProperties = {
  position: "absolute",
  bottom: 14,
  // 좌측 설정 패널(14px + 약 282px)의 오른쪽에서 시작해
  // 수리 정보 토글과 불투명도 슬라이더를 가리지 않는다.
  left: 310,
  right: 330,
  background: "rgba(250,248,245,.93)",
  padding: "8px 13px",
  borderRadius: 7,
  fontSize: 11,
  color: C.secondary,
  border: `1px solid ${C.border}`,
  zIndex: 10,
  fontFamily: "'Noto Sans KR',sans-serif",
  maxWidth: "none",
  maxHeight: 36,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  boxSizing: "border-box",
}

const hint: React.CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  width: 260,
  boxSizing: "border-box",
  background: "rgba(250,248,245,.88)",
  padding: "9px 12px",
  borderRadius: 6,
  fontSize: 11,
  color: C.tertiary,
  border: `1px solid ${C.border}`,
  zIndex: 10,
  fontFamily: "'Noto Sans KR',sans-serif",
}

type ModelSourceMode = "all" | "existing" | "new"

const modelSourceLabels: Record<ModelSourceMode, string> = {
  all: "전체",
  existing: "기존",
  new: "신규",
}

const isProjectNewBorehole = (b: Borehole) =>
  (b as any).project_role ? (b as any).project_role === "new" : Boolean((b as any).is_supplementary)

export default function Viewer3DPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const bhPosRef = useRef<Record<string, { x: number; y: number; z: number }>>({})

  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null)
  const [polygon, setPolygon] = useState<any[] | null>(null)
  const [boreholeIds, setBoreholeIds] = useState<number[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoadingProject, setIsLoadingProject] = useState(true)

  const [status, setStatus] = useState("초기화 중...")
  const [selectedBh, setSelectedBh] = useState<string | null>(null)
  const [verticalExag, setVerticalExag] = useState(1)
  const [depthBelowMSL, setDepthBelowMSL] = useState(50)
  const [basemap, setBasemap] = useState<Basemap>("Base")
  const [showColumns, setShowColumns] = useState(true)
  const [soilDetailVisibility, setSoilDetailVisibility] = useState<Record<string, boolean>>({})
  const [layerColorOverrides, setLayerColorOverrides] = useState<LayerColorOverrides>({})
  const [showDrape, setShowDrape] = useState(true)
  const [showGroundwater, setShowGroundwater] = useState(true)
  const [groundwaterOpacity, setGroundwaterOpacity] = useState(0.42)
  const [showWaterSurface] = useState(false)
  const [renderMode, setRenderMode] = useState<"smooth" | "voxel">("smooth")
  const [modelSourceMode, setModelSourceMode] = useState<ModelSourceMode>("all")
  const [enabledBoreholeIds, setEnabledBoreholeIds] = useState<Set<string>>(new Set())
  const [hydratedSelectionKey, setHydratedSelectionKey] = useState<string | null>(null)
  const [basementMode, setBasementMode] = useState<"extend" | "unknown">("unknown") // 최초 진입/새로고침 시 시추 한계 아래를 미분류 솔리드로 유지한다.
  // [v4.2] 이상 심도 검증 워크플로우
  const [reloadKey, setReloadKey] = useState(0)
  const [compareBh, setCompareBh] = useState<(Borehole & { dem_elevation?: number }) | null>(null)
  const [editingBh, setEditingBh] = useState<(Borehole & { dem_elevation?: number }) | null>(null)
  const [isExportOpen, setIsExportOpen] = useState(false)
  const [isVirtualManagerOpen, setIsVirtualManagerOpen] = useState(false)
  const [isVirtualCopyPicking, setIsVirtualCopyPicking] = useState(false)
  const [virtualCopySourceId, setVirtualCopySourceId] = useState<string | null>(null)
  const [virtualCopyPickError, setVirtualCopyPickError] = useState("")
  const [depthModalDismissed, setDepthModalDismissed] = useState(false)
  const [visibility, setVisibility] = useState<Record<string, boolean>>({
    soil: true,
    weathered_rock: true,
    soft_rock: true,
    normal_rock: true,
    hard_rock: true,
    unknown: true,
  })
  const [sectionState, setSectionState] = useState(DEFAULT_VERTICAL_SECTION_STATE)

  const { sceneRef, rendererRef, cameraRef, controlsRef } = useThreeScene(containerRef)
  const { boreholes, virtualBoreholes, fetchStatus, fetchErr } = useBoreholeData(bbox, polygon, boreholeIds, projectId, reloadKey)
  const [bhState, setBhState] = useState<(Borehole & { dem_elevation?: number })[]>([])

  const virtualDisplayBoreholes = useMemo(() => virtualBoreholes.map((row) => ({
    ...row,
    id: `virtual:${row.id}`,
    project_id: String(row.project_id),
    name: `◆ ${row.name}`,
  } as unknown as Borehole & { dem_elevation?: number; is_virtual: true; virtual_id: number; model_enabled: boolean })), [virtualBoreholes])

  const modelBoreholes = useMemo(() => {
    const observed = modelSourceMode === "existing"
      ? bhState.filter((b) => !isProjectNewBorehole(b))
      : modelSourceMode === "new"
        ? bhState.filter((b) => isProjectNewBorehole(b))
        : bhState
    const enabledObserved = observed.filter((b) => enabledBoreholeIds.has(String(b.id)))
    return [...enabledObserved, ...virtualDisplayBoreholes.filter((row) => row.model_enabled)]
  }, [bhState, enabledBoreholeIds, modelSourceMode, virtualDisplayBoreholes])

  const tableBoreholes = useMemo(
    () => [...bhState, ...virtualDisplayBoreholes],
    [bhState, virtualDisplayBoreholes],
  )

  const soilDetailLegend = useMemo(() => {
    const details = new Set<string>()
    for (const borehole of tableBoreholes) {
      for (const stratum of borehole.strata || []) {
        const detail = normalizeSoilDetailName(stratum.soil_type)
        if (detail) details.add(detail)
      }
    }
    return [...details].sort((a, b) => {
      const ai = SOIL_DETAIL_TYPES.indexOf(a as any)
      const bi = SOIL_DETAIL_TYPES.indexOf(b as any)
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.localeCompare(b, "ko")
    })
  }, [tableBoreholes])

  useEffect(() => {
    setSoilDetailVisibility((previous) => {
      const next = { ...previous }
      for (const detail of soilDetailLegend) {
        if (next[detail] === undefined) next[detail] = true
      }
      return next
    })
  }, [soilDetailLegend])

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(colorStorageKey(projectId))
      if (!stored) {
        setLayerColorOverrides({})
        return
      }
      const parsed = JSON.parse(stored) as Record<string, string>
      const next: LayerColorOverrides = {}
      for (const [key, value] of Object.entries(parsed)) {
        const normalized = normalizeHexColor(value)
        if (normalized) next[key as LayerColorKey] = normalized
      }
      setLayerColorOverrides(next)
    } catch {
      setLayerColorOverrides({})
    }
  }, [projectId])

  const setLayerColorOverride = useCallback((key: LayerColorKey, color: string | null) => {
    const normalized = normalizeHexColor(color)
    setLayerColorOverrides((previous) => {
      const next = { ...previous }
      if (normalized) next[key] = normalized
      else delete next[key]
      try {
        window.localStorage.setItem(colorStorageKey(projectId), JSON.stringify(next))
      } catch {
        // localStorage 저장 실패 시에도 현재 세션의 색상 변경은 유지한다.
      }
      return next
    })
  }, [projectId])

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const projId = sp.get("projectId") || sp.get("project_id")

    if (projId) {
      setProjectId(Number(projId))
      setIsLoadingProject(true)
      ;(async () => {
        try {
          const res = await fetch(apiUrl(`/api/v1/projects/${projId}`))
          if (!res.ok) throw new Error("프로젝트를 불러오지 못했습니다.")
          const proj = await res.json()
          if (proj.bbox && typeof proj.bbox === "object") {
            const { bbox: rectBbox, polygon: rectPoly, borehole_ids: bhIds } = proj.bbox
            setBbox(rectBbox)
            setPolygon(rectPoly)
            setBoreholeIds(bhIds || [])
            setError(null)
          } else {
            throw new Error("프로젝트에 저장된 영역 정보가 없습니다.")
          }
        } catch (err: any) {
          setError(err.message || String(err))
        } finally {
          setIsLoadingProject(false)
        }
      })()
    } else {
      setProjectId(null)
      setIsLoadingProject(false)
      const parsed = parseUrlParams()
      if (parsed.error) {
        setError(parsed.error)
      } else {
        setBbox(parsed.bbox)
        setPolygon(parsed.polygon)
        setBoreholeIds(parsed.boreholeIds)
      }
    }
  }, [])

  useEffect(() => {
    if (boreholes && boreholes.length > 0) {
      setBhState(boreholes)
    }
  }, [boreholes])

  useEffect(() => {
    const currentIds = bhState.map((b) => String(b.id))
    if (currentIds.length === 0) return
    const storageKey = boreholeSelectionStorageKey(projectId)

    if (hydratedSelectionKey !== storageKey) {
      let saved: Set<string> | null = null
      try {
        saved = parseStoredBoreholeSelection(window.localStorage.getItem(storageKey))
      } catch {
        // localStorage를 사용할 수 없는 환경에서는 기존처럼 전체 선택으로 시작한다.
      }
      setEnabledBoreholeIds(reconcileBoreholeSelection(saved, currentIds))
      setHydratedSelectionKey(storageKey)
      return
    }

    setEnabledBoreholeIds((previous) => reconcileBoreholeSelection(previous, currentIds))
  }, [bhState, hydratedSelectionKey, projectId])

  useEffect(() => {
    const storageKey = boreholeSelectionStorageKey(projectId)
    if (hydratedSelectionKey !== storageKey) return
    try {
      window.localStorage.setItem(storageKey, serializeBoreholeSelection(enabledBoreholeIds))
    } catch {
      // 저장 실패 시에도 현재 세션의 선택 상태는 유지한다.
    }
  }, [enabledBoreholeIds, hydratedSelectionKey, projectId])

  useEffect(() => {
    const onModelSourceChange = (event: Event) => {
      const mode = (event as CustomEvent<ModelSourceMode>).detail
      if (mode === "all" || mode === "existing" || mode === "new") {
        setModelSourceMode(mode)
        setSelectedBh(null)
      }
    }
    window.addEventListener("geobim:model-source-change", onModelSourceChange)
    return () => window.removeEventListener("geobim:model-source-change", onModelSourceChange)
  }, [])

  const handleUpdateElevation = async (bhId: string, newElev: number) => {
    const target = bhState.find((b) => String(b.id) === String(bhId))
    const response = await fetch(apiUrl(`/api/v1/boreholes/${bhId}/revisions`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elevation: newElev,
        strata: target?.strata ?? [],
        reason: "3D 지질 뷰어에서 표고 보정",
      }),
    })
    if (!response.ok) {
      throw new Error("표고 서버 반영 실패: " + response.statusText)
    }

    setBhState((prev) =>
      prev.map((b) => (Number(b.id) === Number(bhId) ? { ...b, elevation: newElev } : b))
    )
  }

  const handleVirtualCopyPick = useCallback((id: string) => {
    if (id.startsWith("virtual:")) {
      setVirtualCopyPickError("가상 시추공은 복사 원본으로 선택할 수 없습니다. 기존 또는 신규 시추공을 선택해주세요.")
      return
    }
    const source = bhState.find((row) => String(row.id) === id)
    if (!source) {
      setVirtualCopyPickError("선택한 시추공을 현재 프로젝트 데이터에서 찾을 수 없습니다.")
      return
    }
    if (!source.strata?.length) {
      setVirtualCopyPickError(`${source.name}에는 복사할 지층 데이터가 없습니다.`)
      return
    }
    setVirtualCopySourceId(id)
    setSelectedBh(id)
    setVirtualCopyPickError("")
    setIsVirtualCopyPicking(false)
  }, [bhState])

  const startVirtualCopyPicking = useCallback(() => {
    setVirtualCopyPickError("")
    setVirtualCopySourceId(null)
    setIsVirtualCopyPicking(true)
    setShowColumns(true)
    setModelSourceMode("all")
  }, [])

  const cancelVirtualCopyPicking = useCallback(() => {
    setIsVirtualCopyPicking(false)
    setVirtualCopyPickError("")
  }, [])

  useEffect(() => {
    if (!isVirtualCopyPicking) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelVirtualCopyPicking()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [cancelVirtualCopyPicking, isVirtualCopyPicking])

  const modelSettings: GeoModelSettings = {
    verticalExag,
    depthBelowMSL,
    basemap,
    visibility,
    showColumns,
    soilDetailVisibility,
    layerColorOverrides,
    showDrape,
    renderMode,
    basementMode,
    selectedBh,
    setSelectedBh,
    pickMode: isVirtualCopyPicking ? "virtual-copy" : sectionState.enabled ? "section" : "normal",
    onBoreholePick: handleVirtualCopyPick,
    setStatus,
    bhPosRef,
  }

  const coastalLandMask = useCoastalLandMask(bbox as Bbox | null)

  const {
    focusBorehole,
    dimsRef,
    smoothMeshRef,
    voxelMeshRef,
    drapeRef,
    bhGroupRef,
    markerRef,
    stratumGroupRef,
    authoritativeTerrain,
  } = useGeoModel(sceneRef, rendererRef, cameraRef, controlsRef, modelBoreholes, bbox, polygon, modelSettings, containerRef, coastalLandMask)

  const waterSurfaceModel = useWaterSurfaceModel(
    sceneRef,
    bbox,
    authoritativeTerrain,
    coastalLandMask,
    {
      visible: false,
      opacity: 0.36,
      verticalExag,
    },
  )

  const groundwaterModel = useGroundwaterModel(
    sceneRef,
    modelBoreholes,
    bbox,
    polygon,
    authoritativeTerrain,
    coastalLandMask,
    {
      visible: showGroundwater,
      opacity: groundwaterOpacity,
      verticalExag,
      depthBelowMSL,
    },
  )

  const sectionController = useSectionPlane({
    sceneRef,
    rendererRef,
    cameraRef,
    controlsRef,
    containerRef,
    targets: {
      dimsRef,
      smoothMeshRef,
      voxelMeshRef,
      drapeRef,
      bhGroupRef,
      markerRef,
      stratumGroupRef,
      groundwaterGroupRef: groundwaterModel.groundwaterGroupRef,
    },
    state: sectionState,
    setState: setSectionState,
    verticalExag,
    boreholeColumnsVisible: showColumns,
    groundwaterVisible: showGroundwater,
    setStatus,
  })

  const maxSectionOffsetM = Math.max(
    10,
    Math.hypot(dimsRef.current.lngWidthM, dimsRef.current.latWidthM) / 2,
  )

  // ── 항상 viewport div를 DOM에 유지 ──────────────────────────────────────
  // useThreeScene의 effect 의존성이 [containerRef](ref 객체)라서
  // isLoadingProject/error 상태에 따라 viewport div를 조건부 제거하면
  // containerRef.current 가 null인 채로 effect가 1회 실행 후 재실행 안 됨 →
  // sceneRef.current = null 고착 → useGeoModel 조기 반환 → "초기화 중..." 고착
  // 해결: viewport div는 항상 렌더링하고, loading/error는 오버레이로 처리

  const showLoadingOverlay = isLoadingProject
  const showErrorOverlay   = !isLoadingProject && !!(error || !polygon || !bbox)

  return (
    <div style={{ position: "relative", height: "100vh", display: "flex", background: C.bg, overflow: "hidden", userSelect: "none" }}>
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        {/* Three.js 컨테이너 — 항상 DOM에 유지해야 scene 초기화 보장 */}
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

        {/* ── 로딩 오버레이 ── */}
        {showLoadingOverlay && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: C.bg, color: C.text, fontSize: 14,
            fontFamily: "'Noto Sans KR',sans-serif",
          }}>
            <p>프로젝트 지질 데이터 로딩 중…</p>
          </div>
        )}

        {/* ── 에러 오버레이 ── */}
        {showErrorOverlay && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexDirection: "column", gap: 16,
            background: C.bg, color: C.text,
            fontFamily: "'Noto Sans KR',sans-serif",
          }}>
            <p style={{ fontSize: 13, color: C.red }}>{error ?? "영역 정보가 없습니다."}</p>
            <a href={MAP_URL} style={{ fontSize: 12, color: C.tertiary, textDecoration: "underline" }}>
              1단계 지도로 돌아가기
            </a>
          </div>
        )}

        {/* ── 정상 UI (loading/error 아닐 때만 표시) ── */}
        {!showLoadingOverlay && !showErrorOverlay && (
          <>
            <ViewerControls
              basemap={basemap}
              setBasemap={setBasemap}
              showDrape={showDrape}
              setShowDrape={setShowDrape}
              renderMode={renderMode}
              setRenderMode={setRenderMode}
              verticalExag={verticalExag}
              setVerticalExag={setVerticalExag}
              depthBelowMSL={depthBelowMSL}
              setDepthBelowMSL={setDepthBelowMSL}
              visibility={visibility}
              setVisibility={setVisibility}
              showColumns={showColumns}
              setShowColumns={setShowColumns}
              soilDetailLegend={soilDetailLegend}
              soilDetailVisibility={soilDetailVisibility}
              setSoilDetailVisibility={setSoilDetailVisibility}
              layerColorOverrides={layerColorOverrides}
              setLayerColorOverride={setLayerColorOverride}
              showGroundwater={showGroundwater}
              setShowGroundwater={setShowGroundwater}
              groundwaterOpacity={groundwaterOpacity}
              setGroundwaterOpacity={setGroundwaterOpacity}
              groundwaterObservationCount={groundwaterModel.observationCount}
              groundwaterCanBuildSurface={groundwaterModel.canBuildSurface}
              groundwaterTerrainCapCount={groundwaterModel.constraintDiagnostic.terrainCapCount}
              groundwaterAboveTerrainAnchorCount={groundwaterModel.constraintDiagnostic.anchorAboveTerrainCount}
              groundwaterWaterSurfaceCapCount={groundwaterModel.constraintDiagnostic.waterSurfaceCapCount}
              groundwaterWaterFeatureCount={groundwaterModel.constraintDiagnostic.waterFeatureCount}
              groundwaterWaterSurfaceStatus={groundwaterModel.constraintDiagnostic.waterSurfaceStatus}
              coastalMaskStatus={coastalLandMask.status}
              coastalPolygonCount={coastalLandMask.polygonCount}
              basementMode={basementMode}
              setBasementMode={setBasementMode}
              onOpenExport={() => setIsExportOpen(true)}
              sectionEnabled={sectionState.enabled}
              onToggleSection={() => {
                if (isVirtualCopyPicking) cancelVirtualCopyPicking()
                if (sectionState.enabled) sectionController.resetSection()
                else sectionController.redrawSection()
              }}
            />

            {sectionState.enabled && (
              <SectionControls
                state={sectionState}
                azimuth={sectionController.metrics.azimuth}
                lengthM={sectionController.metrics.lengthM}
                maxOffsetM={maxSectionOffsetM}
                onChange={(patch) => setSectionState((previous) => ({ ...previous, ...patch }))}
                onRedraw={sectionController.redrawSection}
                onPreset={(axis) => {
                  const { boxW, boxD } = dimsRef.current
                  setSectionState((previous) => ({
                    ...previous,
                    enabled: true,
                    interactionMode: "editing",
                    start: axis === "x" ? { x: -boxW / 2, z: 0 } : { x: 0, z: -boxD / 2 },
                    end: axis === "x" ? { x: boxW / 2, z: 0 } : { x: 0, z: boxD / 2 },
                    offsetM: 0,
                    flipped: DEFAULT_VERTICAL_SECTION_STATE.flipped,
                  }))
                  setStatus(axis === "x" ? "동–서 수직 단면을 생성했습니다." : "남–북 수직 단면을 생성했습니다.")
                }}
                onFocus={sectionController.focusSection}
                onReset={sectionController.resetSection}
              />
            )}

            <div style={{ position: "absolute", top: 14, right: 14, width: 260, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ ...hint, position: "relative", top: "auto", right: "auto", width: "100%" }}>
                <div>마우스 좌클릭 + 드래그 = 3D 회전</div>
                <div>Shift + 마우스 드래그 = 시점 이동</div>
                <div>마우스 휠 = 카메라 줌 인/아웃</div>
              </div>

              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 4,
                width: "100%",
                boxSizing: "border-box",
                padding: 4,
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: "rgba(250,248,245,.9)",
                fontFamily: "'Noto Sans KR',sans-serif",
              }}>
                {(["all", "existing", "new"] as ModelSourceMode[]).map((mode) => {
                  const count = mode === "existing"
                    ? bhState.filter((b) => !isProjectNewBorehole(b)).length
                    : mode === "new"
                      ? bhState.filter((b) => isProjectNewBorehole(b)).length
                      : bhState.length
                  const active = modelSourceMode === mode
                  return (
                    <button
                      key={mode}
                      onClick={() => {
                        setModelSourceMode(mode)
                        setSelectedBh(null)
                      }}
                      title={`${modelSourceLabels[mode]} 데이터만으로 지층 형상 생성`}
                      style={{
                        width: "100%",
                        minWidth: 0,
                        padding: "5px 4px",
                        borderRadius: 4,
                        border: `1px solid ${active ? "#a8a29e" : "transparent"}`,
                        background: active ? "rgba(168,162,158,.28)" : "transparent",
                        color: active ? C.text : C.tertiary,
                        cursor: "pointer",
                        fontSize: 11,
                        fontWeight: active ? 700 : 500,
                        fontFamily: "'Noto Sans KR',sans-serif",
                        textAlign: "center",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {modelSourceLabels[mode]} {count}
                    </button>
                  )
                })}
              </div>

              {!showLoadingOverlay && !showErrorOverlay && projectId && (
                <button
                  onClick={() => setIsVirtualManagerOpen(true)}
                  style={{ width: "100%", border: "1px solid #7c3aed", borderRadius: 5, padding: "6px 10px", background: "#f3e8ff", color: "#6d28d9", fontSize: 11, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 8px rgba(124,58,237,.15)", boxSizing: "border-box" }}
                >
                  가상 시추공 관리 ({virtualBoreholes.length})
                </button>
              )}
            </div>

            {fetchStatus === "loading" && (
              <div style={{
                position: "absolute", bottom: 50, left: "50%",
                transform: "translateX(-50%)", zIndex: 20,
                background: "rgba(0,0,0,0.8)", color: C.text,
                fontSize: 12, padding: "6px 16px", borderRadius: 20,
                fontFamily: "'Noto Sans KR',sans-serif",
              }}>
                시추공 데이터를 불러오는 중...
              </div>
            )}
            {fetchStatus === "error" && (
              <div style={{
                position: "absolute", bottom: 50, left: "50%",
                transform: "translateX(-50%)", zIndex: 20,
                background: "rgba(127,29,29,0.8)", color: "#fca5a5",
                fontSize: 12, padding: "6px 16px", borderRadius: 20,
                fontFamily: "'Noto Sans KR',sans-serif",
              }}>
                {fetchErr}
              </div>
            )}

            <div style={statusBar}>{status}</div>
          </>
        )}
      </div>

      {!showLoadingOverlay && !showErrorOverlay && (
        <BoreholeTable
          boreholes={tableBoreholes}
          selectedBh={selectedBh}
          setSelectedBh={setSelectedBh}
          focusBorehole={(id) => {
            if (isVirtualCopyPicking) handleVirtualCopyPick(String(id))
            else focusBorehole(String(id))
          }}
          onUpdateElevation={handleUpdateElevation}
          onInspectData={(b) => setCompareBh(b)}
          onEditData={(b) => {
            if ((b as any).is_virtual) {
              setIsVirtualManagerOpen(true)
              return
            }
            setEditingBh(b)
            setSelectedBh(String(b.id))
          }}
          layerColorOverrides={layerColorOverrides}
          enabledBoreholeIds={enabledBoreholeIds}
          onToggleBoreholeEnabled={(id, enabled) => {
            setEnabledBoreholeIds((previous) => {
              const next = new Set(previous)
              if (enabled) next.add(id)
              else next.delete(id)
              return next
            })
          }}
          onSetBoreholesEnabled={(ids, enabled) => {
            setEnabledBoreholeIds((previous) => {
              const next = new Set(previous)
              for (const id of ids) {
                if (enabled) next.add(id)
                else next.delete(id)
              }
              return next
            })
          }}
        />
      )}



      {isVirtualManagerOpen && projectId && (
        <VirtualBoreholeManager
          projectId={projectId}
          observed={bhState}
          virtualBoreholes={virtualBoreholes}
          isPickingFromScene={isVirtualCopyPicking}
          sceneCopySourceId={virtualCopySourceId}
          onStartPickingFromScene={startVirtualCopyPicking}
          onClose={() => {
            cancelVirtualCopyPicking()
            setIsVirtualManagerOpen(false)
          }}
          onChanged={() => setReloadKey((key) => key + 1)}
        />
      )}

      {isVirtualManagerOpen && isVirtualCopyPicking && (
        <div style={{
          position: "absolute", top: 18, left: "50%", transform: "translateX(-50%)",
          zIndex: 110, minWidth: 420, padding: "12px 14px", borderRadius: 8,
          background: "rgba(76,29,149,.95)", color: "#fff",
          boxShadow: "0 8px 24px rgba(0,0,0,.25)", fontSize: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <b style={{ flex: 1 }}>복사할 기존 또는 신규 시추공을 3D 화면에서 선택하세요.</b>
            <button onClick={cancelVirtualCopyPicking} style={{ border: "1px solid #ddd6fe", borderRadius: 5, padding: "5px 9px", background: "#fff", color: "#6d28d9", cursor: "pointer" }}>
              선택 취소 (Esc)
            </button>
          </div>
          {virtualCopyPickError && <div style={{ marginTop: 7, color: "#fecaca" }}>{virtualCopyPickError}</div>}
        </div>
      )}

      {!showLoadingOverlay && !showErrorOverlay && editingBh && (
        <BoreholeEditPanel
          borehole={editingBh}
          onClose={() => setEditingBh(null)}
          onPreviewChange={(updated) => {
            setBhState((prev) => prev.map((b) => (String(b.id) === String(updated.id) ? { ...b, ...updated } : b)))
            setEditingBh((prev) => (prev && String(prev.id) === String(updated.id) ? { ...prev, ...updated } : prev))
          }}
          onSaved={(updated) => {
            setBhState((prev) => prev.map((b) => (String(b.id) === String(updated.id) ? ({ ...b, ...updated, data_status: "revised" } as any) : b)))
            setEditingBh(null)
            setReloadKey((k) => k + 1)
          }}
        />
      )}

      {/* [v4.2] 이상 심도 경고 모달 → PDF 대조 검증 패널 */}
      {!showLoadingOverlay && !showErrorOverlay && !depthModalDismissed && !compareBh &&
        bhState.some((b) => (b as any).depth_warning) && (
        <DepthWarningModal
          warned={bhState.filter((b) => (b as any).depth_warning) as any}
          onInspect={(b) => setCompareBh(b as any)}
          onClose={() => setDepthModalDismissed(true)}
        />
      )}
      {compareBh && (
        <PdfComparePanel
          borehole={compareBh as any}
          onClose={() => setCompareBh(null)}
          onSaved={() => {
            setCompareBh(null)
            setReloadKey((k) => k + 1) // 재조회 → 워커 자동 재계산 → 경고 재평가
          }}
        />
      )}
      {!showLoadingOverlay && !showErrorOverlay && isExportOpen && bbox && (
        <DataExportModal
          bbox={bbox}
          projectId={projectId}
          boreholes={bhState}
          initialScope={modelSourceMode}
          basementMode={basementMode}
          onClose={() => setIsExportOpen(false)}
        />
      )}
    </div>
  )
}
