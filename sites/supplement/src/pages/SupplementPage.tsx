import { useState, useEffect, useCallback } from "react"
import { parseUrlParams, fetchBoreholes } from "@/lib/parseUrl"
import type { Borehole, ExportOptions } from "@/lib/types"
import { MAP_URL, VIEWER_3D_URL } from "@shared/urls"
import ExistingBoreholeList from "@/components/ExistingBoreholeList"
import NewBoreholeForm from "@/components/NewBoreholeForm"
import ExportPanel from "@/components/ExportPanel"

const C = {
  bg: "#faf8f5",
  panel: "rgba(250,248,245,.97)",
  inner: "#f2ede6",
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  btnIdle: "#f2ede6",
  btnIdleBd: "#e9e4da",
  red: "#dc2626",
} as const

const { bbox, polygon, projectId, boreholeIds, error: parseError } = parseUrlParams()

function isProjectNewBorehole(borehole: Borehole) {
  return borehole.project_role ? borehole.project_role === "new" : Boolean(borehole.is_supplementary)
}

export default function SupplementPage() {
  const [projectBhs, setProjectBhs] = useState<Borehole[]>([])
  const [loadState, setLoadState] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [manualNewBhs, setManualNewBhs] = useState<Borehole[]>([])
  const [exportOpts, setExportOpts] = useState<ExportOptions>({
    mode: "merge",
    layers: ["weathered_rock", "soft_rock", "normal_rock", "hard_rock"],
    gridRes: 48,
  })
  const [exportState, setExportState] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [exportErr, setExportErr] = useState<string | null>(null)
  const [effectiveBbox, setEffectiveBbox] = useState(bbox)
  const [effectivePolygon, setEffectivePolygon] = useState(polygon)
  const [effectiveBoreholeIds, setEffectiveBoreholeIds] = useState(boreholeIds)

  const projectExistingBhs = projectBhs.filter((bh) => !isProjectNewBorehole(bh))
  const projectNewBhs = projectBhs.filter(isProjectNewBorehole)
  const allNewBhs = [...projectNewBhs, ...manualNewBhs]

  useEffect(() => {
    if (bbox || !projectId) return
    let cancelled = false
    setLoadState("loading")
    setLoadErr(null)

    fetch(`/api/v1/projects/${projectId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`프로젝트 API 오류: HTTP ${res.status}`)
        return res.json()
      })
      .then((project) => {
        if (cancelled) return
        const projectBbox = project?.bbox?.bbox
        if (!Array.isArray(projectBbox) || projectBbox.length !== 4 || projectBbox.some((n: unknown) => !Number.isFinite(Number(n)))) {
          throw new Error("프로젝트에 저장된 영역 정보가 없습니다.")
        }
        setEffectiveBbox(projectBbox.map(Number) as [number, number, number, number])
        setEffectivePolygon(project.bbox?.polygon ?? null)
        setEffectiveBoreholeIds(project.bbox?.borehole_ids ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setLoadErr(e?.message ?? String(e))
        setLoadState("error")
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!effectiveBbox) return
    setLoadState("loading")
    setLoadErr(null)

    fetchBoreholes(effectiveBbox, projectId, effectiveBoreholeIds, effectivePolygon)
      .then((bhs) => {
        setProjectBhs(bhs)
        setLoadState("done")

        const presentGroups = new Set<string>(["ground_surface"])
        for (const bh of bhs) {
          for (const s of bh.strata ?? []) {
            if (s.strata_group) presentGroups.add(s.strata_group)
          }
        }
        setExportOpts((prev) => ({
          ...prev,
          layers: prev.layers.filter((layer) => presentGroups.has(layer)),
        }))
      })
      .catch((e) => {
        setLoadErr(String(e))
        setLoadState("error")
      })
  }, [effectiveBbox, effectivePolygon, effectiveBoreholeIds])

  const handleAddNew = useCallback((bh: Borehole) => {
    setManualNewBhs((prev) => [...prev, { ...bh, id: Date.now(), isNew: true, project_role: "new", is_supplementary: true }])
  }, [])

  const handleRemoveNew = useCallback((id: number) => {
    setManualNewBhs((prev) => prev.filter((b) => b.id !== id))
  }, [])

  const handleExport = useCallback(async () => {
    if (!effectiveBbox) return
    setExportState("loading")
    setExportErr(null)

    try {
      const exportBoreholes = exportOpts.mode === "new_only"
        ? allNewBhs
        : [...projectBhs, ...manualNewBhs]

      const res = await fetch("/api/v1/export/landxml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox: effectiveBbox,
          project_id: projectId,
          grid_res: exportOpts.gridRes,
          boreholes: exportBoreholes,
          borehole_ids: [],
          layers: exportOpts.layers,
          mode: exportOpts.mode,
          data_type: "cogo_points",
        }),
      })

      if (!res.ok) {
        const detail = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(detail.detail ?? res.statusText)
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const cd = res.headers.get("Content-Disposition") ?? ""
      const fn = cd.match(/filename="([^"]+)"/)?.[1] ?? "geobim_stratum.xml"
      a.href = url
      a.download = fn
      a.click()
      URL.revokeObjectURL(url)

      setExportState("done")
      setTimeout(() => setExportState("idle"), 3000)
    } catch (e) {
      setExportErr(String(e))
      setExportState("error")
    }
  }, [effectiveBbox, projectId, exportOpts, projectBhs, manualNewBhs, allNewBhs])

  if (parseError || (!effectiveBbox && !projectId)) {
    return (
      <CenteredMessage
        message={parseError ?? "영역 정보가 없습니다."}
        error
        actionLabel="1단계 지도로 돌아가기"
        actionHref={MAP_URL}
      />
    )
  }

  if (!effectiveBbox) {
    return (
      <CenteredMessage
        message={loadState === "error" ? (loadErr ?? "프로젝트 영역 정보를 불러오지 못했습니다.") : "프로젝트 영역 정보를 불러오는 중입니다..."}
        error={loadState === "error"}
        actionLabel={loadState === "error" ? "1단계 지도로 돌아가기" : undefined}
        actionHref={loadState === "error" ? MAP_URL : undefined}
      />
    )
  }

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      background: C.bg,
      fontFamily: "'Noto Sans KR',-apple-system,sans-serif",
      color: C.text,
      overflow: "hidden",
    }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 20px",
        background: C.panel,
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 11, color: C.tertiary }}>KH Geo · 3단계</div>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>데이터 보완 · 내보내기</h1>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              const params = new URLSearchParams(window.location.search)
              window.open(`${VIEWER_3D_URL}/?${params.toString()}`, "_blank")
            }}
            style={navButtonStyle}
          >
            2단계 3D 뷰어로 확인
          </button>
          <button
            onClick={() => { window.location.href = MAP_URL }}
            style={{ ...navButtonStyle, background: "rgba(232,83,58,.12)", border: `1px solid ${C.red}`, color: C.red }}
          >
            1단계 지도
          </button>
        </div>
      </header>

      <div style={{
        display: "flex",
        gap: 12,
        padding: "8px 20px",
        background: C.inner,
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
        fontSize: 12,
        color: C.tertiary,
      }}>
        <span>
          조사 영역: <strong style={{ color: C.secondary }}>
            {effectiveBbox[0].toFixed(5)}, {effectiveBbox[1].toFixed(5)} ~ {effectiveBbox[2].toFixed(5)}, {effectiveBbox[3].toFixed(5)}
          </strong>
        </span>
        {projectId && <span>· 프로젝트 ID: <strong style={{ color: C.secondary }}>{projectId}</strong></span>}
        <span>· 기존 시추공: <strong style={{ color: C.secondary }}>{projectExistingBhs.length}개</strong></span>
        <span>· 신규 시추공: <strong style={{ color: C.secondary }}>{projectNewBhs.length}개</strong></span>
        {manualNewBhs.length > 0 && (
          <span>· 3단계 추가: <strong style={{ color: C.secondary }}>{manualNewBhs.length}개</strong></span>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ width: 280, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.border}`, background: C.panel }}>
          <ExistingBoreholeList
            boreholes={projectBhs}
            loadState={loadState}
            loadErr={loadErr}
          />
        </div>

        <div style={{ flex: 1, overflowY: "auto", borderRight: `1px solid ${C.border}`, background: C.inner, padding: "16px 20px" }}>
          <NewBoreholeForm
            newBhs={manualNewBhs}
            onAdd={handleAddNew}
            onRemove={handleRemoveNew}
          />
        </div>

        <div style={{ width: 320, flexShrink: 0, overflowY: "auto", background: C.panel }}>
          <ExportPanel
            opts={exportOpts}
            setOpts={setExportOpts}
            newBhCount={allNewBhs.length}
            existingBhCount={projectExistingBhs.length}
            exportState={exportState}
            exportErr={exportErr}
            onExport={handleExport}
            availableGroups={(() => {
              const groups = new Set<string>(["ground_surface"])
              for (const bh of [...projectBhs, ...manualNewBhs]) {
                for (const st of bh.strata ?? []) {
                  if (st.strata_group) groups.add(st.strata_group)
                }
              }
              return groups
            })()}
          />
        </div>
      </div>
    </div>
  )
}

const navButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  background: C.btnIdle,
  border: `1px solid ${C.btnIdleBd}`,
  color: C.secondary,
}

function CenteredMessage({
  message,
  error,
  actionLabel,
  actionHref,
}: {
  message: string
  error?: boolean
  actionLabel?: string
  actionHref?: string
}) {
  return (
    <div style={{
      display: "flex",
      height: "100vh",
      alignItems: "center",
      justifyContent: "center",
      background: C.bg,
      color: C.text,
      flexDirection: "column",
      gap: 16,
      fontFamily: "'Noto Sans KR',sans-serif",
    }}>
      <p style={{ fontSize: 13, color: error ? C.red : C.secondary }}>{message}</p>
      {actionLabel && actionHref && (
        <a href={actionHref} style={{ fontSize: 12, color: C.tertiary, textDecoration: "underline" }}>
          {actionLabel}
        </a>
      )}
    </div>
  )
}
