import { useMemo, useState } from "react"
import type { Borehole } from "@/lib/types"
import { apiUrl } from "@shared/urls"

type ExportScope = "all" | "existing" | "new"
type ExportState = "idle" | "loading" | "done" | "error"

interface Props {
  bbox: [number, number, number, number]
  projectId: number | null
  boreholes: Borehole[]
  initialScope: ExportScope
  basementMode: "extend" | "unknown"
  onClose: () => void
}

const C = {
  panel: "rgba(250,248,245,.98)",
  border: "#e9e4da",
  text: "#1c1917",
  secondary: "#44403c",
  tertiary: "#78716c",
  inner: "#f2ede6",
  active: "#D4D1CB",
  activeBorder: "#BEBAB3",
  red: "#dc2626",
} as const

const LAYERS = [
  { key: "ground_surface", label: "지표면", color: "#4a7c35" },
  { key: "weathered_rock", label: "풍화암 상단면", color: "#C4A57B" },
  { key: "soft_rock", label: "연암 상단면", color: "#6B8E5A" },
  { key: "normal_rock", label: "보통암 상단면", color: "#5F6552" },
  { key: "hard_rock", label: "경암 상단면", color: "#3D3D3D" },
]

const SECTION_LAYERS = [
  { label: "지표면", color: "#a3c98a", height: 12 },
  { label: "토사", color: "#c9b89a", height: 24 },
  { label: "풍화암", color: "#c4a57b", height: 24 },
  { label: "연암", color: "#7da86e", height: 24 },
  { label: "보통암", color: "#6b7a5a", height: 24 },
  { label: "경암", color: "#4a4a4a", height: 24 },
]

const RES_OPTIONS = [24, 32, 48, 64, 96]

function isProjectNew(borehole: Borehole) {
  return (borehole as any).project_role ? (borehole as any).project_role === "new" : Boolean((borehole as any).is_supplementary)
}

function SectionPreview({ layers }: { layers: string[] }) {
  const selected = new Set(layers)
  const width = 190
  const yOffsets: number[] = []
  let acc = 0
  for (const layer of SECTION_LAYERS) {
    yOffsets.push(acc)
    acc += layer.height
  }

  const boundaries = [
    { ...LAYERS[0], y: yOffsets[1] },
    { ...LAYERS[1], y: yOffsets[2] },
    { ...LAYERS[2], y: yOffsets[3] },
    { ...LAYERS[3], y: yOffsets[4] },
    { ...LAYERS[4], y: yOffsets[5] },
  ]

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, color: C.tertiary, marginBottom: 5 }}>출력 경계면 미리보기</div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <svg
          width={width}
          height={acc}
          style={{ border: `1px solid ${C.border}`, borderRadius: 6, display: "block", overflow: "visible" }}
        >
          {SECTION_LAYERS.map((layer, index) => (
            <g key={layer.label}>
              <rect x={0} y={yOffsets[index]} width={width} height={layer.height} fill={layer.color} opacity={0.55} />
              <text x={7} y={yOffsets[index] + layer.height / 2 + 3} fontSize={8.5} fill={C.text} opacity={0.85}>
                {layer.label}
              </text>
            </g>
          ))}
          {boundaries.map((boundary) => {
            const active = selected.has(boundary.key)
            return (
              <g key={boundary.key}>
                <line
                  x1={0}
                  y1={boundary.y}
                  x2={width}
                  y2={boundary.y}
                  stroke={active ? boundary.color : "#aaa"}
                  strokeWidth={active ? 2.2 : 0.8}
                  strokeDasharray={active ? "6 3" : "3 3"}
                  opacity={active ? 1 : 0.45}
                />
                {active && (
                  <>
                    <rect x={width - 96} y={boundary.y - 8} width={90} height={13} fill={boundary.color} rx={3} opacity={0.92} />
                    <text x={width - 51} y={boundary.y + 1.3} fontSize={7.5} fill="#fff" textAnchor="middle" fontWeight="bold">
                      {boundary.label}
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

export function DataExportModal({ bbox, projectId, boreholes, initialScope, basementMode, onClose }: Props) {
  const [scope, setScope] = useState<ExportScope>(initialScope)
  const [gridRes, setGridRes] = useState(48)
  const [layers, setLayers] = useState<string[]>(["weathered_rock", "soft_rock", "normal_rock", "hard_rock"])
  const [exportState, setExportState] = useState<ExportState>("idle")
  const [exportErr, setExportErr] = useState<string | null>(null)
  const [dxfState, setDxfState] = useState<ExportState>("idle")

  const existing = useMemo(() => boreholes.filter((b) => !isProjectNew(b)), [boreholes])
  const newly = useMemo(() => boreholes.filter(isProjectNew), [boreholes])
  const selected = scope === "existing" ? existing : scope === "new" ? newly : boreholes

  const availableGroups = useMemo(() => {
    const groups = new Set<string>(["ground_surface"])
    for (const bh of selected) {
      for (const st of ((bh as any).strata ?? [])) {
        if (st.strata_group) groups.add(String(st.strata_group))
      }
    }
    return groups
  }, [selected])

  // 선택된 레이어 중 실제 데이터가 있는 것만 추린다.
  // (기본값에 포함된 hard_rock 등 '데이터 없음' 레이어가 미리보기·내보내기에
  //  활성으로 새어 들어가는 것을 막는다. UI의 '데이터 없음' 라벨과 실제 전송
  //  레이어의 출처를 일치시킨다.)
  const effectiveLayers = useMemo(
    () => layers.filter((key) => availableGroups.has(key)),
    [layers, availableGroups],
  )

  const canExport = selected.length > 0 && effectiveLayers.length > 0 && exportState !== "loading"

  const toggleLayer = (key: string) => {
    if (!availableGroups.has(key)) return
    setLayers((prev) => prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key])
  }

  const handleExport = async () => {
    if (!canExport) return
    setExportState("loading")
    setExportErr(null)

    try {
      const res = await fetch(apiUrl("/api/v1/export/landxml"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
          project_id: projectId,
          grid_res: gridRes,
          boreholes: selected,
          borehole_ids: [],
          layers: effectiveLayers,
          mode: scope === "new" ? "new_only" : "merge",
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
      setTimeout(() => setExportState("idle"), 2500)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : String(e))
      setExportState("error")
    }
  }

  // 시추공 주상도를 색상 3D 기둥 DXF로 내보낸다(보간 없이 실측 시추공만).
  // LandXML 지층면과 같은 좌표계라 Civil 3D에서 겹쳐 검수할 수 있다.
  const handleExportDxf = async () => {
    if (selected.length === 0 || dxfState === "loading") return
    setDxfState("loading")
    setExportErr(null)

    try {
      const res = await fetch(apiUrl("/api/v1/export/boreholes-dxf"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
          project_id: projectId,
          boreholes: selected,
          borehole_ids: [],
          // 검수용이므로 지층 필터 없이 전체 주상도를 기둥으로 그린다.
          layers: null,
          mode: scope === "new" ? "new_only" : "merge",
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
      const fn = cd.match(/filename="([^"]+)"/)?.[1] ?? "geobim_strata_lines.dxf"
      a.href = url
      a.download = fn
      a.click()
      URL.revokeObjectURL(url)
      setDxfState("done")
      setTimeout(() => setDxfState("idle"), 2500)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : String(e))
      setDxfState("error")
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(28,25,23,.45)",
        fontFamily: "'Noto Sans KR',-apple-system,sans-serif",
      }}
    >
      <div style={{
        width: 500,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "calc(100vh - 32px)",
        overflow: "auto",
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        boxShadow: "0 18px 50px rgba(0,0,0,.22)",
        color: C.text,
        fontSize: 11,
      }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div>
            <div style={{ fontSize: 10, color: C.tertiary }}>Civil 3D · LandXML COGO Points</div>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>데이터 내보내기</h2>
          </div>
          <button onClick={onClose} style={{ marginLeft: "auto", border: 0, background: "transparent", cursor: "pointer", fontSize: 17, color: C.tertiary }}>
            x
          </button>
        </header>

        <div style={{ padding: "13px 16px" }}>
          <section style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 6 }}>시추공데이터 선택</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
              {([
                ["all", `전체 ${boreholes.length}`],
                ["existing", `기존 ${existing.length}`],
                ["new", `신규 ${newly.length}`],
              ] as const).map(([key, label]) => {
                const active = scope === key
                return (
                  <button
                    key={key}
                    onClick={() => setScope(key)}
                    style={{
                      padding: "7px 4px",
                      borderRadius: 5,
                      border: `1px solid ${active ? C.activeBorder : C.border}`,
                      background: active ? C.active : C.inner,
                      color: C.text,
                      fontSize: 11,
                      fontWeight: active ? 700 : 500,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </section>

          <section style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 6 }}>출력 경계면</div>
            {LAYERS.map((layer) => {
              const checked = layers.includes(layer.key)
              const available = availableGroups.has(layer.key)
              return (
                <div
                  key={layer.key}
                  onClick={() => toggleLayer(layer.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "4px 7px",
                    marginBottom: 2,
                    borderRadius: 5,
                    cursor: available ? "pointer" : "not-allowed",
                    opacity: available ? (checked ? 1 : 0.45) : 0.25,
                  }}
                >
                  <span style={{
                    width: 13,
                    height: 13,
                    borderRadius: 3,
                    flexShrink: 0,
                    background: available && checked ? layer.color : C.inner,
                    border: `1px solid ${available && checked ? layer.color : C.border}`,
                  }} />
                  <span style={{ fontSize: 11, color: C.secondary }}>{layer.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: C.tertiary }}>
                    {!available ? "데이터 없음" : checked ? "포함" : "제외"}
                  </span>
                </div>
              )
            })}
            <SectionPreview layers={effectiveLayers} />
          </section>

          <section style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 6 }}>
              보간점 해상도: <strong style={{ color: C.secondary }}>{gridRes} x {gridRes}</strong>
            </div>
            <div style={{ fontSize: 10, color: C.tertiary, marginTop: 5 }}>
              지층당 보간점 {gridRes * gridRes}개 + 해당 지층의 시추공 실측 접촉점
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {RES_OPTIONS.map((res) => (
                <button
                  key={res}
                  onClick={() => setGridRes(res)}
                  style={{
                    flex: 1,
                    padding: "5px 0",
                    borderRadius: 5,
                    border: `1px solid ${gridRes === res ? C.activeBorder : C.border}`,
                    background: gridRes === res ? C.active : C.inner,
                    cursor: "pointer",
                    fontSize: 10.5,
                    fontWeight: gridRes === res ? 700 : 500,
                  }}
                >
                  {res}
                </button>
              ))}
            </div>
          </section>

          <div style={{ padding: "8px 10px", borderRadius: 6, background: C.inner, border: `1px solid ${C.border}`, fontSize: 10, lineHeight: 1.45, color: C.tertiary, marginBottom: 12 }}>
            지층별 Point Group에 실측 접촉점과 RBF 보간점을 구분하여 저장합니다.
            현재 표시 모드: {basementMode === "extend" ? "연장" : "미분류 유지"}
          </div>

          {exportErr && (
            <div style={{ padding: "8px 9px", borderRadius: 6, border: `1px solid ${C.red}`, background: "rgba(220,38,38,.08)", color: C.red, fontSize: 11, marginBottom: 9 }}>
              {exportErr}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
            <button onClick={onClose} style={{ padding: "7px 12px", borderRadius: 5, border: `1px solid ${C.border}`, background: C.panel, cursor: "pointer", fontSize: 11 }}>
              닫기
            </button>
            <button
              onClick={handleExportDxf}
              disabled={selected.length === 0 || dxfState === "loading"}
              title="시추공 주상도를 지층별 수직선 DXF로 내보냅니다. Civil3D에서 LISP으로 원통형 3D Solid로 변환할 수 있습니다."
              style={{
                padding: "7px 14px",
                borderRadius: 5,
                border: `1px solid ${selected.length > 0 ? C.activeBorder : C.border}`,
                background: C.panel,
                color: selected.length > 0 ? C.text : C.tertiary,
                cursor: selected.length > 0 && dxfState !== "loading" ? "pointer" : "not-allowed",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {dxfState === "loading" ? "DXF 생성 중..." : dxfState === "done" ? "수직선 DXF 완료" : "지층 수직선 DXF"}
            </button>
            <button
              onClick={handleExport}
              disabled={!canExport}
              style={{
                padding: "7px 14px",
                borderRadius: 5,
                border: `1px solid ${canExport ? C.activeBorder : C.border}`,
                background: canExport ? C.active : C.inner,
                color: canExport ? C.text : C.tertiary,
                cursor: canExport ? "pointer" : "not-allowed",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {exportState === "loading" ? "생성 중..." : exportState === "done" ? "다운로드 완료" : "COGO 점 내보내기"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
