import { useCallback, useEffect, useRef, useState, useMemo } from "react"
import "cesium/Build/Cesium/Widgets/widgets.css"
import * as Cesium from "cesium"
import { useCesiumMap } from "@/features/map/useCesiumMap"
import type { Borehole, Project, BoreholeApiResponse, Stratum } from "@/lib/types"
import { normalizeStrataGroup, getStrataColor, STRATA_LEGEND } from "@shared/strataColor"
import { PROJECTS_URL, VIEWER_3D_URL } from "@shared/urls"

// ── KH_Geo 색상 팔레트 ────────────────────────────────────────
const C = {
  bg:        "#faf8f5",
  panel:     "rgba(250,248,245,.97)",
  inner:     "#f2ede6",
  border:    "#e9e4da",
  text:      "#1c1917",
  secondary: "#44403c",
  tertiary:  "#78716c",
  btnActive: "#D4D1CB",
  btnBorder: "#BEBAB3",
  btnIdle:   "#f2ede6",
  btnIdleBd: "#e9e4da",
  accent:    "#dc2626",
  success:   "#D4D1CB",
  successBd: "#BEBAB3",
  input:     "#f2ede6",
} as const

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 14, left: 14,
  minWidth: 250, zIndex: 10,
  background: C.panel, padding: "14px 16px",
  border: `1px solid ${C.border}`, borderRadius: 10,
  boxShadow: "0 4px 18px rgba(0,0,0,.12)",
  color: C.text, fontFamily: "'Noto Sans KR', sans-serif",
}

const DEFAULT_LAYER_VISIBLE = [true, true, true, true]

export default function MapPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const restoredProjectRef = useRef<string | null>(null) // 중복 API 및 무한 루프 락 체크용
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null) // 진입 프로젝트 ID
  const [projectFilter, setProjectFilter] = useState<number | null>(null)
  const [allBoreholes, setAllBoreholes]   = useState<Borehole[]>([])
  const [projects, setProjects]           = useState<Project[]>([])
  const [status, setStatus]               = useState("초기화 중...")
  const [dataError, setDataError]         = useState<string | null>(null)
  const [showMarkers, setShowMarkers]       = useState(true)
  const [selectedBorehole, setSelectedBorehole] = useState<Borehole | null>(null)
  const [bhLoading, setBhLoading]           = useState(false)

  // ── 데이터 로드 ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/v1/boreholes/?limit=50000&include_strata=false")
        if (!res.ok) throw new Error(await apiErrorMessage(res, "시추공 데이터를 불러오지 못했습니다."))
        const body: BoreholeApiResponse = await res.json()
        if (!cancelled) {
          setAllBoreholes(body.boreholes)
          setStatus(`준비 완료 · 시추공 ${body.boreholes.length.toLocaleString()}개`)
          setDataError(null)
        }
      } catch (e: any) {
        if (!cancelled) {
          setAllBoreholes([])
          const message = mapApiFailureMessage(e)
          setStatus("시추공 데이터 연결 필요")
          setDataError(message)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/v1/projects/")
        if (!res.ok) return
        const body = await res.json()
        if (!cancelled) setProjects(Array.isArray(body) ? body : (body.projects || []))
      } catch {
        if (!cancelled) setProjects([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  const filteredBoreholes = useMemo(() => {
    return projectFilter
      ? allBoreholes.filter((b) => b.project_id === projectFilter)
      : allBoreholes
  }, [allBoreholes, projectFilter])

  const visibleBoreholes = useMemo(() => {
    return showMarkers ? filteredBoreholes : []
  }, [filteredBoreholes, showMarkers])

  // ── Cesium 훅 ────────────────────────────────────────────
  const handleBoreholeClick = useCallback(async (bh: Borehole) => {
    setSelectedBorehole(bh)   // 즉시 패널 표시 (기본 정보)
    if (bh.data_status?.startsWith("modified_")) return
    setBhLoading(true)
    try {
      const res = await fetch(`/api/v1/boreholes/${bh.id}`)
      if (res.ok) {
        const detail: Borehole = await res.json()
        setSelectedBorehole(detail)  // strata 포함 전체 정보로 갱신
      }
    } catch {}
    finally { setBhLoading(false) }
  }, [])

  const handleBoreholeSaved = useCallback((updated: Borehole) => {
    setSelectedBorehole(updated)
    setAllBoreholes((current) =>
      current.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
    )
  }, [])

  const { isDrawing, polygon, selectedBoreholes, startDrawing, cancelDrawing, setSelection } =
    useCesiumMap(containerRef, visibleBoreholes, "Base",
      15, 10, 235, "gl", DEFAULT_LAYER_VISIBLE,
      handleBoreholeClick
    )

  // ── 프로젝트 영역 저장/복원 상태 및 효과 ───────────────────
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [projectDesc, setProjectDesc] = useState("")
  const [saveLoading, setSaveLoading] = useState(false)

  // URL에서 projectId 또는 project_id 파라미터가 있는 경우 자동 로드 및 영역 세팅
  useEffect(() => {
    let cancelled = false
    const sp = new URLSearchParams(window.location.search)
    const projectIdStr = sp.get("project_id") || sp.get("projectId")
    if (!projectIdStr || allBoreholes.length === 0) return
    if (restoredProjectRef.current === projectIdStr) return // 이미 세팅된 경우 재세팅 차단
    restoredProjectRef.current = projectIdStr

    ;(async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectIdStr}`)
        if (!res.ok) return
        const proj = await res.json()

        // 현재 프로젝트 정보 동적 탑재
        setCurrentProjectId(proj.id)
        setProjectName(proj.name)
        setProjectDesc(proj.description || "")

        const effectiveRes = await fetch(`/api/v1/projects/${projectIdStr}/boreholes/effective`)
        if (effectiveRes.ok) {
          const effectiveBody = await effectiveRes.json()
          if (!cancelled && Array.isArray(effectiveBody.boreholes)) {
            setAllBoreholes(effectiveBody.boreholes)
            setStatus(`프로젝트 기준 · 시추공 ${effectiveBody.boreholes.length.toLocaleString()}개`)
          }
        }

        if (proj.bbox && typeof proj.bbox === "object") {
          const { bbox: rectBbox, polygon: rectPoly, borehole_ids: bhIds } = proj.bbox
          if (rectBbox && bhIds) {
            // Cesium 인스턴스가 완전히 로드될 때까지 약간의 대기 후 setSelection 호출
            let count = 0
            const interval = setInterval(() => {
              if (setSelection && count < 20) {
                setSelection(rectBbox, rectPoly, bhIds)
                clearInterval(interval)
              }
              count++
            }, 300)
          }
        }
      } catch (e) {
        console.error("Failed to restore project from URL:", e)
      }
    })()

    return () => { cancelled = true }
  }, [allBoreholes, setSelection])

  const handleSaveProject = async (name: string, description: string) => {
    if (!currentProjectId) {
      alert("프로젝트를 먼저 생성한 뒤 프로젝트 목록에서 지도로 진입해주세요.")
      return
    }
    if (!name.trim()) {
      alert("프로젝트 이름을 입력해주세요.")
      return
    }
    if (!bbox) return

    setSaveLoading(true)
    try {
      const [swLat, swLng] = bbox.sw
      const [neLat, neLng] = bbox.ne
      const polyDeg = polygon!.map((pt) => ({
        lng: Cesium.Math.toDegrees(pt.longitude),
        lat: Cesium.Math.toDegrees(pt.latitude),
      }))

      const payload = {
        name,
        description,
        region: "선택 영역",
        source_crs: "EPSG:4326",
        bbox: {
          bbox: [swLng, swLat, neLng, neLat],
          polygon: polyDeg,
          borehole_ids: selectedBoreholes.map((b) => b.id),
        },
      }

      const res = await fetch(`/api/v1/projects/${currentProjectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, "프로젝트를 저장하지 못했습니다."))
      }

      const savedProject = await res.json()
      setProjectName(savedProject.name)
      setProjectDesc(savedProject.description || "")
      alert(`프로젝트 '${savedProject.name}'가 성공적으로 저장되었습니다!`)
      setIsSaveModalOpen(false)
    } catch (e: any) {
      alert(`저장 중 오류가 발생했습니다.\n\n${mapApiFailureMessage(e)}`)
    } finally {
      setSaveLoading(false)
    }
  }

  // ── BBOX (도 단위) ───────────────────────────────────────
  const bbox = useMemo<{ sw: [number,number]; ne: [number,number] } | null>(() => {
    if (!polygon || polygon.length === 0) return null
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    polygon.forEach((pt) => {
      const lng = Cesium.Math.toDegrees(pt.longitude)
      const lat = Cesium.Math.toDegrees(pt.latitude)
      if (lng < minLng) minLng = lng
      if (lat < minLat) minLat = lat
      if (lng > maxLng) maxLng = lng
      if (lat > maxLat) maxLat = lat
    })
    return { sw: [minLat, minLng], ne: [maxLat, maxLng] }
  }, [polygon])

  // ── 2단계 이동 ──────────────────────────────────────────
  const handleProceed = () => {
    if (!bbox) return
    const [swLat, swLng] = bbox.sw
    const [neLat, neLng] = bbox.ne
    const bboxStr = `${swLng.toFixed(6)},${swLat.toFixed(6)},${neLng.toFixed(6)},${neLat.toFixed(6)}`
    const bhIdsStr = selectedBoreholes.map((b) => b.id).join(",")
    const polyDeg = polygon!.map((pt) => ({
      lng: Cesium.Math.toDegrees(pt.longitude),
      lat: Cesium.Math.toDegrees(pt.latitude),
    }))
    window.location.href = `${VIEWER_3D_URL}/?bbox=${bboxStr}&boreholeIds=${bhIdsStr}&polygon=${encodeURIComponent(JSON.stringify(polyDeg))}`
  }

  const handleClear = () => {
    cancelDrawing()
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100vh", background: C.bg, overflow: "hidden" }}>
      {/* Cesium 컨테이너 */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* ── 좌측 패널 ─────────────────────────────────────── */}
      <div style={panelStyle}>
        {/* 워크플로우 레이블 */}
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 2 }}>
          KH Geo · 업무 흐름
        </div>
        {/* 단계 헤더 */}
        <div style={{ fontSize: 16, fontWeight: 700, margin: "2px 0 12px 0" }}>
          1단계 · 영역 선택
        </div>

        {/* 시추공 ON/OFF */}
        <Btn
          label="시추공 위치 ON/OFF"
          active={showMarkers}
          onClick={() => setShowMarkers((v) => !v)}
        />

        {/* 영역 그리기 */}
        <Btn
          label={isDrawing ? "그리기 취소" : "영역 선택"}
          active={isDrawing}
          onClick={isDrawing ? cancelDrawing : startDrawing}
          style={{ marginTop: 6 }}
        />

        {/* 선택 초기화 */}
        {bbox && (
          <Btn label="선택 초기화" onClick={handleClear} style={{ marginTop: 6 }} />
        )}

        {/* 프로젝트 필터 */}
        {projects.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: C.tertiary, marginTop: 12, marginBottom: 4 }}>
              프로젝트 필터
            </div>
            <select
              value={projectFilter ?? ""}
              onChange={(e) => setProjectFilter(e.target.value === "" ? null : Number(e.target.value))}
              style={{
                width: "100%", padding: "6px 8px", borderRadius: 6,
                background: C.input, color: C.text, border: `1px solid ${C.btnIdleBd}`,
                fontSize: 13, fontFamily: "inherit",
              }}
            >
              <option value="">전체 프로젝트</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </>
        )}

        {/* 선택 영역 정보 */}
        {bbox && (
          <div style={{
            marginTop: 12, padding: "10px 12px",
            background: C.inner, border: `1px solid ${C.border}`, borderRadius: 6,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6, color: C.text }}>선택된 영역</div>
            <InfoRow label="SW" value={`${bbox.sw[0].toFixed(4)}, ${bbox.sw[1].toFixed(4)}`} />
            <InfoRow label="NE" value={`${bbox.ne[0].toFixed(4)}, ${bbox.ne[1].toFixed(4)}`} />
            <InfoRow
              label="포함 시추공"
              value={`${selectedBoreholes.length.toLocaleString()} 개`}
              valueStyle={{ color: C.accent, fontWeight: 700 }}
            />
          </div>
        )}

        {/* 확인 → 2단계 및 영역 저장 */}
        {bbox && (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={handleProceed}
              style={{
                flex: 1, padding: 10, borderRadius: 6,
                background: C.success, border: `1px solid ${C.successBd}`,
                color: C.text, fontSize: 13, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              3D 분석 (2단계)
            </button>
            {currentProjectId ? (
              <button
                onClick={() => setIsSaveModalOpen(true)}
                style={{
                  flex: 1, padding: 10, borderRadius: 6,
                  background: C.btnActive, border: `1px solid ${C.btnBorder}`,
                  color: C.text, fontSize: 13, fontWeight: 600,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                프로젝트 영역 저장
              </button>
            ) : (
              <a
                href={PROJECTS_URL}
                style={{
                  flex: 1, padding: 10, borderRadius: 6, textAlign: "center",
                  background: C.btnActive, border: `1px solid ${C.btnBorder}`,
                  color: C.text, fontSize: 13, fontWeight: 600,
                  textDecoration: "none", fontFamily: "inherit",
                }}
              >
                프로젝트 먼저 생성
              </a>
            )}
          </div>
        )}
      </div>

      {isSaveModalOpen && (
        <SaveProjectModal
          currentProjectId={currentProjectId}
          initialName={projectName}
          initialDescription={projectDesc}
          saveLoading={saveLoading}
          onCancel={() => setIsSaveModalOpen(false)}
          onSave={handleSaveProject}
        />
      )}

      {/* ── 시추공 정보 패널 ─────────────────────────────────── */}
      {selectedBorehole && (
        <BoreholePanel
          borehole={selectedBorehole}
          loading={bhLoading}
          onSaved={handleBoreholeSaved}
          onClose={() => setSelectedBorehole(null)}
        />
      )}

      {/* ── 우상단 힌트 ─────────────────────────────────────── */}
      {dataError && (
        <div style={{
          position: "absolute", left: 14, bottom: 52, zIndex: 10,
          maxWidth: 420, background: "rgba(254,242,242,.96)",
          border: "1px solid #fecaca", borderRadius: 8,
          padding: "12px 14px", color: "#7f1d1d",
          fontSize: 12, lineHeight: 1.55,
          boxShadow: "0 4px 18px rgba(0,0,0,.10)",
          fontFamily: "'Noto Sans KR', sans-serif",
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            시추공 데이터를 표시할 수 없습니다
          </div>
          <div style={{ whiteSpace: "pre-line" }}>{dataError}</div>
        </div>
      )}

      <div style={{
        position: "absolute", top: 14, right: 14, zIndex: 10,
        background: "rgba(250,248,245,.88)", padding: "9px 12px",
        borderRadius: 6, fontSize: 11, color: C.tertiary,
        border: `1px solid ${C.border}`,
      }}>
        {isDrawing
          ? "지도에서 마우스를 드래그하여 사각형 영역을 그리세요"
          : '"영역 선택" 클릭 후 지도에서 드래그하세요'}
      </div>

      {/* ── 하단 상태 바 ─────────────────────────────────────── */}
      <div style={{
        position: "absolute", bottom: 14, left: 14, zIndex: 10,
        background: "rgba(250,248,245,.93)", padding: "8px 13px",
        borderRadius: 7, fontSize: 11, color: C.secondary,
        border: `1px solid ${C.border}`,
      }}>
        {status}
      </div>

      <style>{`select option { background: #f2ede6; color: #1c1917; }`}</style>
    </div>
  )
}

// ── 재사용 컴포넌트 ───────────────────────────────────────────
async function apiErrorMessage(response: Response, fallback: string) {
  let detail = ""
  try {
    const body = await response.json()
    detail = body.detail ? String(body.detail) : ""
  } catch {
    try {
      detail = await response.text()
    } catch {
      detail = ""
    }
  }
  if (detail) return detail
  if (response.status >= 500) {
    return `${fallback} 백엔드 내부 오류가 발생했습니다.`
  }
  return `${fallback} 요청이 실패했습니다.`
}

function mapApiFailureMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "")
  if (
    raw.includes("Connect call failed") ||
    raw.includes("connection refused") ||
    raw.includes("ECONNREFUSED") ||
    raw.includes("127.0.0.1', 5432") ||
    raw.includes("127.0.0.1:5432") ||
    raw.includes("백엔드 내부 오류")
  ) {
    return [
      "현재 백엔드가 PostgreSQL 데이터베이스에 연결하지 못하고 있습니다.",
      "",
      "해결 방법:",
      "1. Docker Desktop 또는 Rancher Desktop을 실행합니다.",
      "2. 프로젝트 루트에서 `docker compose up -d`를 실행합니다.",
      "3. 백엔드가 다시 정상화되면 지도뷰를 새로고침합니다.",
      "",
      "지도에는 실제 DB 시추공 데이터만 표시합니다.",
    ].join("\n")
  }
  return [
    "실제 시추공 API 호출이 실패했습니다.",
    raw ? `원인: ${raw}` : "",
    "",
    "백엔드와 데이터베이스가 실행 중인지 확인한 뒤 지도뷰를 새로고침해 주세요.",
  ].filter(Boolean).join("\n")
}

function Btn({ label, active, onClick, style }: {
  label: string; active?: boolean; onClick: () => void; style?: React.CSSProperties
}) {
  return (
    <button onClick={onClick} style={{
      width: "100%", padding: "8px 10px", borderRadius: 6,
      fontSize: 13, cursor: "pointer", transition: "all .15s",
      fontFamily: "'Noto Sans KR', sans-serif",
      background: active ? "#D4D1CB" : "#f2ede6",
      color: "#1c1917",
      border: `1px solid ${active ? "#BEBAB3" : "#e9e4da"}`,
      fontWeight: active ? 600 : 400,
      ...style,
    }}>
      {label}
    </button>
  )
}

function InfoRow({ label, value, valueStyle }: {
  label: string; value: string; valueStyle?: React.CSSProperties
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
      <span style={{ color: "#78716c" }}>{label}</span>
      <span style={{ color: "#44403c", ...valueStyle }}>{value}</span>
    </div>
  )
}

function SaveProjectModal({
  currentProjectId,
  initialName,
  initialDescription,
  saveLoading,
  onCancel,
  onSave,
}: {
  currentProjectId: number | null
  initialName: string
  initialDescription: string
  saveLoading: boolean
  onCancel: () => void
  onSave: (name: string, description: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(name, description)
  }

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      background: "rgba(28,25,23,.45)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Noto Sans KR', sans-serif"
    }}>
      <form onSubmit={handleSubmit} style={{
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12,
        width: 380, padding: 24, boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
        color: C.text
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, marginTop: 0 }}>
          {currentProjectId ? "프로젝트 영역 수정" : "새 프로젝트 저장"}
        </h3>
        
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: C.tertiary, display: "block", marginBottom: 6 }}>프로젝트 이름</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 수원시 영통구 지반 조사"
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              background: C.input, border: `1px solid ${C.border}`,
              color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box"
            }}
          />
        </div>
        
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, color: C.tertiary, display: "block", marginBottom: 6 }}>프로젝트 설명</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="상세 정보를 입력하세요..."
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              background: C.input, border: `1px solid ${C.border}`,
              color: C.text, fontSize: 13, outline: "none",
              height: 80, resize: "none", boxSizing: "border-box", fontFamily: "inherit"
            }}
          />
        </div>
        
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 16px", borderRadius: 6,
              background: "transparent", border: `1px solid ${C.border}`,
              color: C.secondary, fontSize: 13, cursor: "pointer"
            }}
          >
            취소
          </button>
          <button
            type="submit"
            disabled={saveLoading}
            style={{
              padding: "8px 16px", borderRadius: 6,
              background: C.success, border: `1px solid ${C.successBd}`,
              color: "#1c1917", fontSize: 13, fontWeight: 600, cursor: "pointer"
            }}
          >
            {saveLoading ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </div>
  )
}

function BoreholePanel({
  borehole,
  loading,
  onSaved,
  onClose,
}: {
  borehole: Borehole
  loading?: boolean
  onSaved: (updated: Borehole) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const sorted = [...(borehole.strata ?? [])].sort((a, b) => a.depth_top - b.depth_top)
  const totalDepth = sorted.length ? Math.max(...sorted.map((s) => s.depth_bottom)) : 0
  const LOG_H = 220 // px

  if (editing) {
    return (
      <BoreholeEditPanel
        borehole={borehole}
        onCancel={() => setEditing(false)}
        onClose={onClose}
        onSaved={(updated) => {
          onSaved(updated)
          setEditing(false)
        }}
      />
    )
  }

  return (
    <div style={{
      position: "absolute", bottom: 14, right: 14, width: 260, zIndex: 20,
      background: "rgba(250,248,245,.97)", border: `1px solid ${C.border}`,
      borderRadius: 10, boxShadow: "0 4px 20px rgba(0,0,0,.12)",
      color: C.text, fontFamily: "'Noto Sans KR',-apple-system,sans-serif",
      overflow: "hidden",
    }}>
      {/* 헤더 */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: `1px solid ${C.border}`,
        background: "rgba(160,155,148,.15)",
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{borehole.name}</div>
          <div style={{ fontSize: 11, color: C.tertiary, marginTop: 1 }}>
            시추공 정보
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => setEditing(true)} style={{
            background: C.btnIdle, border: `1px solid ${C.btnBorder}`,
            color: C.secondary, borderRadius: 5, fontSize: 11,
            cursor: "pointer", padding: "4px 8px",
          }}>편집</button>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: C.tertiary,
            fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 2px",
          }}>×</button>
        </div>
      </div>

      <div style={{ padding: "12px 14px" }}>
        {/* 기본 정보 */}
        <div style={{
          padding: "8px 10px", background: C.inner,
          borderRadius: 6, border: `1px solid ${C.border}`, marginBottom: 12,
        }}>
          <InfoRow label="표고" value={borehole.elevation != null ? `${borehole.elevation.toFixed(1)} m` : "-"} />
          <InfoRow label="위도" value={borehole.latitude.toFixed(5)} />
          <InfoRow label="경도" value={borehole.longitude.toFixed(5)} />
          <InfoRow label="총 심도" value={totalDepth > 0 ? `${totalDepth.toFixed(1)} m` : "-"} />
          <InfoRow label="지층 수" value={`${sorted.length} 개`} />
        </div>

        {/* 지층 시각화 */}
        {loading ? (
          <div style={{ fontSize: 11, color: C.tertiary, textAlign: "center", padding: "12px 0" }}>
            지층 데이터 로드 중...
          </div>
        ) : sorted.length > 0 ? (
          <>
            <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 6 }}>지층 구성</div>
            <div style={{ display: "flex", gap: 6, position: "relative" }}>
              {/* 1단 (왼쪽): 심도 숫자 컬럼 */}
              <div style={{ width: 35, position: "relative", height: LOG_H, flexShrink: 0 }}>
                {sorted.map((s, i) => {
                  const distFromBottomPx = totalDepth > 0 ? ((totalDepth - s.depth_top) / totalDepth) * LOG_H : 100
                  const showDepthTop = distFromBottomPx >= 16
                  const topPx = totalDepth > 0 ? (s.depth_top / totalDepth) * LOG_H : 0
                  
                  return showDepthTop ? (
                    <div key={i} style={{
                      position: "absolute", top: topPx, right: 0,
                      fontSize: 9, color: C.tertiary, lineHeight: "10px",
                      textAlign: "right", whiteSpace: "nowrap",
                    }}>
                      {s.depth_top.toFixed(1)}m
                    </div>
                  ) : null
                })}
                {/* 최하단 깊이 */}
                <div style={{
                  position: "absolute", bottom: 0, right: 0,
                  fontSize: 9, color: C.tertiary, textAlign: "right",
                }}>
                  {totalDepth.toFixed(1)}m
                </div>
              </div>

              {/* 2단 (가운데): 지층 구성 기둥 (컬러 바) */}
              <div style={{
                width: 24, height: LOG_H, borderRadius: 4,
                overflow: "hidden", flexShrink: 0,
                border: `1px solid ${C.border}`,
                display: "flex", flexDirection: "column",
              }}>
                {sorted.map((s, i) => {
                  const thickness = s.depth_bottom - s.depth_top
                  const heightPx = totalDepth > 0 ? (thickness / totalDepth) * LOG_H : 0
                  const col = getStrataColor(s.soil_type)
                  return (
                    <div key={i} style={{
                      width: "100%", height: heightPx,
                      background: col, flexShrink: 0,
                    }} />
                  )
                })}
              </div>

              {/* 3단 (오른쪽): 지층명 레이블 컬럼 */}
              <div style={{ flex: 1, position: "relative", height: LOG_H }}>
                {sorted.map((s, i) => {
                  const thickness = s.depth_bottom - s.depth_top
                  const topPx = totalDepth > 0 ? (s.depth_top / totalDepth) * LOG_H : 0
                  const heightPx = totalDepth > 0 ? (thickness / totalDepth) * LOG_H : 0
                  const grp = normalizeStrataGroup(s.soil_type)
                  const col = getStrataColor(s.soil_type)
                  const lbl = STRATA_LEGEND.find(l => l.group === grp)?.label ?? s.soil_type
                  
                  return (
                    <div key={i} style={{
                      position: "absolute", top: topPx, left: 4, right: 0,
                      height: heightPx, overflow: "hidden",
                      display: "flex", alignItems: "center",
                    }}>
                      {heightPx > 22 && (
                        <div style={{
                          display: "flex", alignItems: "center", gap: 4,
                        }}>
                          <span style={{
                            width: 8, height: 8, borderRadius: 2,
                            background: col, flexShrink: 0, display: "inline-block",
                          }} />
                          <span style={{ fontSize: 11, color: C.secondary, whiteSpace: "nowrap" }}>{lbl}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 범례 */}
            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
              {sorted
                .filter((s, i, arr) => {
                  const key = normalizeStrataGroup(s.soil_type)
                  return arr.findIndex((x) => normalizeStrataGroup(x.soil_type) === key) === i
                })
                .map((s) => {
                  const grp = normalizeStrataGroup(s.soil_type)
                  const col = getStrataColor(s.soil_type)
                  const lbl = STRATA_LEGEND.find(l => l.group === grp)?.label ?? s.soil_type
                  return (
                    <div key={grp} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: col, display: "inline-block" }} />
                      <span style={{ color: C.secondary }}>{lbl}</span>
                    </div>
                  )
                })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: C.tertiary, textAlign: "center", padding: "12px 0" }}>
            지층 데이터 없음
          </div>
        )}
      </div>
    </div>
  )
}

type EditableStratum = {
  depth_top: string
  depth_bottom: string
  soil_type: string
}

function BoreholeEditPanel({
  borehole,
  onSaved,
  onCancel,
  onClose,
}: {
  borehole: Borehole
  onSaved: (updated: Borehole) => void
  onCancel: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(borehole.name)
  const [longitude, setLongitude] = useState(String(borehole.longitude))
  const [latitude, setLatitude] = useState(String(borehole.latitude))
  const [elevation, setElevation] = useState(borehole.elevation == null ? "" : String(borehole.elevation))
  const [strata, setStrata] = useState<EditableStratum[]>(
    [...(borehole.strata ?? [])]
      .sort((a, b) => a.depth_top - b.depth_top)
      .map((item) => ({
        depth_top: String(item.depth_top),
        depth_bottom: String(item.depth_bottom),
        soil_type: item.soil_type,
      })),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: `1px solid ${C.border}`,
    borderRadius: 5, padding: "6px 7px", background: "#fff",
    color: C.text, fontSize: 11, outline: "none",
  }

  const updateStratum = (index: number, key: keyof EditableStratum, value: string) => {
    setStrata((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, [key]: value } : item,
    ))
  }

  const save = async () => {
    setError(null)
    const lon = Number(longitude)
    const lat = Number(latitude)
    const elev = elevation.trim() === "" ? null : Number(elevation)
    if (!name.trim()) return setError("시추공명을 입력하세요.")
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return setError("경도와 위도를 숫자로 입력하세요.")
    if (lon < 124 || lon > 132 || lat < 33 || lat > 39) return setError("좌표가 한국 영역 범위를 벗어났습니다.")
    if (elev !== null && !Number.isFinite(elev)) return setError("표고를 숫자로 입력하세요.")

    const normalizedStrata = strata.map((item) => ({
      depth_top: Number(item.depth_top),
      depth_bottom: Number(item.depth_bottom),
      soil_type: item.soil_type.trim(),
    }))
    for (const item of normalizedStrata) {
      if (!Number.isFinite(item.depth_top) || !Number.isFinite(item.depth_bottom)) {
        return setError("지층 심도를 숫자로 입력하세요.")
      }
      if (item.depth_bottom <= item.depth_top) return setError("하심도는 상심도보다 커야 합니다.")
      if (!item.soil_type) return setError("지층명을 입력하세요.")
    }

    setSaving(true)
    try {
      const baseResponse = await fetch(`/api/v1/boreholes/${borehole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          longitude: lon,
          latitude: lat,
          elevation: elev,
        }),
      })
      if (!baseResponse.ok) throw new Error(await apiErrorMessage(baseResponse, "시추공 정보를 저장하지 못했습니다."))

      const strataResponse = await fetch(`/api/v1/boreholes/${borehole.id}/strata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalizedStrata),
      })
      if (!strataResponse.ok) throw new Error(await apiErrorMessage(strataResponse, "지층 정보를 저장하지 못했습니다."))

      const detailResponse = await fetch(`/api/v1/boreholes/${borehole.id}`)
      if (!detailResponse.ok) throw new Error(await apiErrorMessage(detailResponse, "수정 결과를 불러오지 못했습니다."))
      onSaved(await detailResponse.json() as Borehole)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "저장 중 오류가 발생했습니다.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: "absolute", bottom: 14, right: 14, width: 480, maxHeight: "calc(100vh - 28px)",
      zIndex: 20, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
      boxShadow: "0 4px 20px rgba(0,0,0,.12)", color: C.text,
      fontFamily: "'Noto Sans KR',-apple-system,sans-serif", overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: `1px solid ${C.border}`,
        background: "rgba(160,155,148,.15)",
      }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>시추공 데이터 편집</div>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: C.tertiary,
          fontSize: 18, cursor: "pointer", lineHeight: 1,
        }}>×</button>
      </div>

      <div style={{ padding: 14, overflowY: "auto", maxHeight: "calc(100vh - 118px)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label style={{ gridColumn: "1 / -1", fontSize: 10, color: C.tertiary }}>
            시추공명
            <input value={name} onChange={(event) => setName(event.target.value)} style={{ ...fieldStyle, marginTop: 3 }} />
          </label>
          <label style={{ fontSize: 10, color: C.tertiary }}>
            경도
            <input value={longitude} onChange={(event) => setLongitude(event.target.value)} style={{ ...fieldStyle, marginTop: 3 }} />
          </label>
          <label style={{ fontSize: 10, color: C.tertiary }}>
            위도
            <input value={latitude} onChange={(event) => setLatitude(event.target.value)} style={{ ...fieldStyle, marginTop: 3 }} />
          </label>
          <label style={{ gridColumn: "1 / -1", fontSize: 10, color: C.tertiary }}>
            표고(m)
            <input value={elevation} onChange={(event) => setElevation(event.target.value)} style={{ ...fieldStyle, marginTop: 3 }} />
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 6px" }}>
          <strong style={{ fontSize: 12 }}>지층 데이터</strong>
          <button onClick={() => setStrata((current) => [
            ...current,
            { depth_top: current.length ? current[current.length - 1].depth_bottom : "0", depth_bottom: "", soil_type: "" },
          ])} style={{
            border: `1px solid ${C.btnBorder}`, borderRadius: 5, background: C.btnIdle,
            color: C.secondary, fontSize: 10, padding: "4px 7px", cursor: "pointer",
          }}>+ 지층 추가</button>
        </div>

        <div style={{ display: "grid", gap: 5 }}>
          {strata.map((item, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "72px 72px 1fr 26px", gap: 5 }}>
              <input aria-label={`지층 ${index + 1} 상심도`} value={item.depth_top}
                onChange={(event) => updateStratum(index, "depth_top", event.target.value)} style={fieldStyle} />
              <input aria-label={`지층 ${index + 1} 하심도`} value={item.depth_bottom}
                onChange={(event) => updateStratum(index, "depth_bottom", event.target.value)} style={fieldStyle} />
              <input aria-label={`지층 ${index + 1} 지층명`} value={item.soil_type}
                onChange={(event) => updateStratum(index, "soil_type", event.target.value)} style={fieldStyle} />
              <button aria-label={`지층 ${index + 1} 삭제`} onClick={() => setStrata((current) => current.filter((_, i) => i !== index))}
                style={{ border: `1px solid ${C.border}`, borderRadius: 5, background: "#fff", color: C.accent, cursor: "pointer" }}>×</button>
            </div>
          ))}
        </div>

        {error && <div style={{
          marginTop: 10, padding: "7px 9px", borderRadius: 5,
          background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 11,
        }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 12 }}>
          <button onClick={onCancel} disabled={saving} style={{
            border: `1px solid ${C.border}`, borderRadius: 5, background: "#fff",
            color: C.secondary, padding: "6px 12px", cursor: "pointer",
          }}>취소</button>
          <button onClick={save} disabled={saving} style={{
            border: `1px solid ${C.btnBorder}`, borderRadius: 5, background: C.btnActive,
            color: C.text, padding: "6px 14px", cursor: saving ? "wait" : "pointer", fontWeight: 600,
          }}>{saving ? "저장 중..." : "저장"}</button>
        </div>
      </div>
    </div>
  )
}
