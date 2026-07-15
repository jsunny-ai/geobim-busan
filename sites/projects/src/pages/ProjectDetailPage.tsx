import { Fragment, useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Pencil, X, Building2, Compass, TrendingUp, FileUp, PenLine, ChevronDown, ChevronRight, ExternalLink, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useProject } from "@/features/projects/hooks"
import { useBoreholes } from "@/features/boreholes/hooks"
import Navbar from "@/components/Navbar"
import StratigraphyColumn from "@/components/StratigraphyColumn"
import BoreholeEditorPanel from "@/components/BoreholeEditorPanel"
import ManualBoreholeForm from "@/components/ManualBoreholeForm"
import type { Borehole } from "@/lib/types"
import { PROJECTS_URL, UPLOAD_URL } from "@shared/urls"

type MainTab    = "existing" | "register"
type RegisterTab = "pdf" | "manual"
type FilterType  = "all" | "original" | "supplementary"

const UPLOAD_BASE = UPLOAD_URL

function isProjectNew(borehole: Borehole) {
  return borehole.project_role ? borehole.project_role === "new" : Boolean(borehole.is_supplementary)
}

type BoreholeListGroup = {
  key: string
  label: string | null
  items: Borehole[]
}

function uploadGroupLabel(borehole: Borehole) {
  if (!borehole.registered_from_job_id) return "직접 등록"
  const source = (borehole.source_file ?? "").toLowerCase()
  const kind = source.includes("csv_uploads") || source.endsWith(".csv")
    ? "CSV"
    : source.endsWith(".xlsx") || source.endsWith(".xls")
      ? "엑셀"
      : "PDF"
  return `${kind} 업로드 #${borehole.registered_from_job_id}`
}

function groupBoreholesByUpload(boreholes: Borehole[]): BoreholeListGroup[] {
  const existing: Borehole[] = []
  const uploads = new Map<string, BoreholeListGroup>()

  boreholes.forEach((borehole) => {
    if (!isProjectNew(borehole)) {
      existing.push(borehole)
      return
    }

    const key = borehole.registered_from_job_id
      ? `upload-${borehole.registered_from_job_id}`
      : "manual"
    const group = uploads.get(key)
    if (group) {
      group.items.push(borehole)
    } else {
      uploads.set(key, { key, label: uploadGroupLabel(borehole), items: [borehole] })
    }
  })

  return [
    ...(existing.length ? [{ key: "existing", label: null, items: existing }] : []),
    ...Array.from(uploads.values()).reverse(),
  ]
}

// 배지 컴포넌트
function BoreholeTypeBadge({ isSupplementary, status }: { isSupplementary: boolean; status?: string }) {
  if (status?.startsWith("modified_")) {
    return (
      <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300">
        수정본
      </span>
    )
  }

  return isSupplementary ? (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-stone-200 text-stone-800 border border-stone-300">
      신규
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-stone-200 text-stone-700 border border-stone-300">
      기존
    </span>
  )
}

function BoreholeOriginBadge({ origin }: { origin?: string }) {
  const label =
    origin === "user_upload" ? "사용자" :
    origin === "manual_input" ? "직접" :
    origin === "test" ? "테스트" :
    "공공"

  return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-white text-stone-700 border border-stone-300">
      {label}
    </span>
  )
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id)
  const queryClient = useQueryClient()

  const { data: project } = useProject(projectId)
  const { data: boreholes, isLoading, refetch } = useBoreholes(projectId, project)

  const [mainTab, setMainTab]         = useState<MainTab>("existing")
  const [registerTab, setRegisterTab] = useState<RegisterTab>("pdf")
  const [selected, setSelected]       = useState<Borehole | null>(null)
  const [editing, setEditing]         = useState(false)
  const [editingBase, setEditingBase] = useState<Borehole | null>(null)
  const [filter, setFilter]           = useState<FilterType>("all")
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())

  const returnUrl = encodeURIComponent(`${PROJECTS_URL}/detail/${projectId}`)
  const uploadUrl = `${UPLOAD_BASE}/?project_id=${projectId}&return_url=${returnUrl}`

  // 필터링된 목록
  const filteredBoreholes = (boreholes ?? []).filter(b => {
    if (filter === "original")      return !isProjectNew(b)
    if (filter === "supplementary") return isProjectNew(b)
    return true
  })

  const origCount  = (boreholes ?? []).filter(b => !isProjectNew(b)).length
  const suppCount  = (boreholes ?? []).filter(b =>  isProjectNew(b)).length
  const totalCount = (boreholes ?? []).length
  const boreholeGroups = groupBoreholesByUpload(filteredBoreholes)

  function toggleGroup(key: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleSelectBorehole(b: Borehole) {
    setSelected(b); setEditing(false); setEditingBase(null); setMainTab("existing")
  }

  function handleRegisterSuccess() {
    setMainTab("existing"); setSelected(null); refetch()
  }

  function handleBoreholeSaved(updated: Borehole) {
    setSelected(updated)
    setEditingBase(null)
    queryClient.setQueryData<Borehole[]>(["boreholes", projectId], (prev) =>
      prev?.map((b) => (b.id === updated.id ? updated : b)) ?? prev,
    )
    queryClient.setQueryData(["borehole", updated.id], updated)
  }

  function handleToggleEditing() {
    if (editing) {
      if (editingBase) setSelected(editingBase)
      setEditingBase(null)
      setEditing(false)
      return
    }
    setEditingBase(selected)
    setEditing(true)
  }

  function handleCancelEditing() {
    if (editingBase) setSelected(editingBase)
    setEditingBase(null)
    setEditing(false)
  }

  useEffect(() => {
    if (editing || !selected || !boreholes) return
    const latest = boreholes.find((b) => b.id === selected.id)
    if (latest) setSelected(latest)
  }, [boreholes, editing, selected?.id])

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <Navbar active="projects" />
      <div className="flex flex-1 overflow-hidden">

        {/* ── 좌측 사이드바 ── */}
        <aside className="w-64 border-r border-border flex flex-col shrink-0 bg-card/30">
          {/* 헤더 */}
          <div className="p-3 border-b border-border">
            <a href="/" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
              <ArrowLeft className="h-3 w-3" /> 목록으로
            </a>
            <p className="text-xs font-semibold leading-snug line-clamp-2">{project?.name ?? "…"}</p>
            {/* 카운트 요약 */}
            <div className="flex gap-2 mt-1.5">
              <span className="text-[11px] text-stone-700">기존 {origCount}개</span>
              <span className="text-[11px] text-muted-foreground">·</span>
              <span className="text-[11px] text-stone-700">신규 {suppCount}개</span>
            </div>
          </div>

          {/* 메인 탭 */}
          <div className="flex border-b border-border shrink-0">
            {(["existing", "register"] as const).map(t => (
              <button key={t} onClick={() => setMainTab(t)}
                className={`flex-1 py-2 text-xs font-medium transition-colors ${
                  mainTab === t
                    ? `bg-accent text-foreground border-b-2 ${"border-stone-400"}`
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "existing" ? "시추공 목록" : "+ 신규 등록"}
              </button>
            ))}
          </div>

          {mainTab === "existing" ? (
            <>
              {/* 필터 바 */}
              <div className="flex border-b border-border/60 shrink-0 bg-muted/10">
                {([
                  { key: "all",           label: `전체 ${totalCount}` },
                  { key: "original",      label: `기존 ${origCount}` },
                  { key: "supplementary", label: `신규 ${suppCount}` },
                ] as const).map(({ key, label }) => (
                  <button key={key} onClick={() => setFilter(key)}
                    className={`flex-1 py-1.5 text-[10px] font-medium transition-colors ${
                      filter === key
                        ? key === "supplementary"
                          ? "text-stone-700 border-b border-stone-400 bg-stone-100"
                          : key === "original"
                          ? "text-stone-700 border-b border-stone-300 bg-stone-100"
                          : "text-foreground border-b border-border"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 시추공 리스트 */}
              <div className="flex-1 overflow-y-auto">
                {isLoading && <div className="p-3 text-xs text-muted-foreground">로딩 중…</div>}

                {boreholeGroups.map(group => (
                  <Fragment key={group.key}>
                    {group.label && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-stone-300 bg-stone-100 px-3 py-2 text-left text-[11px] font-semibold text-stone-800"
                      >
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsedGroups.has(group.key) ? "-rotate-90" : ""}`} />
                        <span className="truncate">{group.label}</span>
                        <span className="ml-auto shrink-0 text-[10px] font-normal text-stone-600">{group.items.length}개</span>
                      </button>
                    )}
                    {!collapsedGroups.has(group.key) && group.items.map(b => (
                      <button key={b.id} onClick={() => handleSelectBorehole(b)}
                        className={`w-full text-left px-3 py-2.5 text-xs hover:bg-accent transition-colors border-b border-border/40 ${
                          selected?.id === b.id ? "bg-accent text-accent-foreground" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-medium truncate">{b.name}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            <BoreholeTypeBadge isSupplementary={isProjectNew(b)} status={b.data_status} />
                            <BoreholeOriginBadge origin={b.data_origin} />
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          </div>
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          {b.strata.length}개 지층{b.elevation != null ? ` · ${b.elevation}m` : ""}
                        </div>
                      </button>
                    ))}
                  </Fragment>
                ))}

                {filteredBoreholes.length === 0 && !isLoading && (
                  <div className="p-3 text-xs text-muted-foreground">
                    {filter === "all"
                      ? <>등록된 시추공이 없습니다.<br />
                          <button onClick={() => setMainTab("register")} className="text-stone-700 hover:underline mt-1">신규 등록하기 →</button>
                        </>
                      : `${filter === "original" ? "기존" : "신규"} 시추공이 없습니다.`
                    }
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-3 space-y-2">
              <p className="text-[11px] text-muted-foreground mb-3">오른쪽에서 등록 방식을 선택하세요.</p>
              {([
                { key: "pdf",    icon: FileUp,  label: "PDF 파싱 등록",  sub: "업로드 사이트 연동",  color: "stone" },
                { key: "manual", icon: PenLine, label: "직접 입력 등록", sub: "위치·지층 수동 입력", color: "stone" },
              ] as const).map(({ key, icon: Icon, label, sub, color }) => (
                <button key={key} onClick={() => setRegisterTab(key)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                    registerTab === key
                      ? "bg-stone-100 border-stone-300 text-stone-800"
                      : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <div className="text-left">
                    <div>{label}</div>
                    <div className={`text-[10px] mt-0.5 ${registerTab === key ? "text-stone-700/70" : "text-muted-foreground"}`}>{sub}</div>
                  </div>
                </button>
              ))}

              {/* 구분 설명 */}
              <div className="mt-3 pt-3 border-t border-border/40 space-y-1.5">
                <p className="text-[10px] text-muted-foreground font-medium">등록 구분 기준</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <BoreholeTypeBadge isSupplementary={false} />
                  원본 시추조사 데이터
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <BoreholeTypeBadge isSupplementary={true} />
                  사후 추가 보완 데이터
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* ── 우측 메인 패널 ── */}
        <main className="flex-1 overflow-y-auto">

          {/* 신규 등록 */}
          {mainTab === "register" && (
            <div className="max-w-2xl mx-auto p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${"bg-stone-200"}`}>
                  {registerTab === "pdf" ? <FileUp className="h-4 w-4 text-stone-700" /> : <PenLine className="h-4 w-4 text-stone-700" />}
                </div>
                <div>
                  <h2 className="text-base font-semibold">{registerTab === "pdf" ? "PDF 파싱 등록" : "직접 입력 등록"}</h2>
                  <p className="text-xs text-muted-foreground">
                    프로젝트: <span className="text-foreground font-medium">{project?.name}</span>
                    <span className="ml-2"><BoreholeTypeBadge isSupplementary={true} /></span>
                    <span className="ml-1 text-[10px] text-muted-foreground">로 저장됩니다</span>
                  </p>
                </div>
              </div>

              {registerTab === "pdf" && (
                <div className="rounded-xl border border-stone-300 bg-stone-100 p-6 text-center space-y-4">
                  <div className="h-12 w-12 rounded-full bg-stone-100 border border-stone-300 flex items-center justify-center mx-auto">
                    <FileUp className="h-6 w-6 text-stone-700" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">PDF 파싱 업로드 사이트</h3>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      PDF · DOCX · HWPX 형식의 지반조사보고서를 업로드합니다.
                      <br />현재 프로젝트가 자동 선택된 상태로 열리며, <strong>신규</strong> 시추공으로 저장됩니다.
                    </p>
                  </div>
                  <a href={uploadUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-stone-300 hover:bg-stone-400 px-5 py-2.5 text-sm font-semibold text-white transition-colors shadow-sm"
                  >
                    <ExternalLink className="h-4 w-4" />
                    업로드 사이트에서 PDF 파싱하기
                  </a>
                  <p className="text-[11px] text-muted-foreground">저장 완료 후 이 페이지로 자동으로 돌아옵니다.</p>
                  <div className="pt-3 border-t border-stone-300">
                    <button onClick={() => refetch()} className="text-xs text-stone-700 hover:text-stone-800 hover:underline">
                      업로드 완료 후 목록 새로고침
                    </button>
                  </div>
                </div>
              )}

              {registerTab === "manual" && (
                <ManualBoreholeForm projectId={projectId} onSuccess={handleRegisterSuccess} />
              )}
            </div>
          )}

          {/* 기존 데이터 */}
          {mainTab === "existing" && (
            <div className="p-6">
              {totalCount === 0 ? (
                    <div className="flex flex-col items-center justify-center max-w-md mx-auto text-center space-y-6 py-20">
                      <div className="h-16 w-16 rounded-full bg-stone-400/10 flex items-center justify-center text-stone-500 border border-stone-400/20">
                        <FileUp className="h-8 w-8" />
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-base font-semibold">등록된 시추 데이터가 없습니다</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          좌측 '신규 등록' 탭에서 PDF 파싱 또는 직접 입력으로 시추공을 등록하세요.
                        </p>
                      </div>
                      <Button onClick={() => setMainTab("register")} className="w-full max-w-xs bg-stone-300 hover:bg-stone-400 text-stone-800 font-semibold text-xs h-9">
                        신규 시추공 등록하기
                      </Button>
                    </div>
              ) : (
                <div className={`grid gap-5 items-start ${selected ? "lg:grid-cols-[minmax(0,1fr)_420px]" : ""}`}>
                  <div className={`space-y-6 animate-in fade-in duration-300 min-w-0 ${selected ? "" : "max-w-4xl mx-auto w-full"}`}>
                      <div className="flex items-start justify-between">
                        <div>
                          <h2 className="text-lg font-bold tracking-tight text-stone-800">
                            {project?.name ?? "시추 프로젝트 상세"}
                          </h2>
                          <p className="text-xs text-muted-foreground mt-0.5">{project?.description || "등록된 설명이 없습니다."}</p>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setMainTab("register")} className="text-xs shrink-0">
                          <FileUp className="h-3 w-3 mr-1.5" /> 시추공 추가
                        </Button>
                      </div>

                      {/* 통계 카드 */}
                      <div className="grid grid-cols-3 gap-4">
                        {[
                          { label: "총 시추공 수", value: totalCount, unit: "개", icon: <Building2 className="h-4 w-4 text-stone-700" />,
                            sub: <><span className="text-stone-700">{origCount}</span> + <span className="text-stone-700">{suppCount}</span></> },
                          {
                            label: "평균 표고",
                            value: boreholes!.length > 0
                              ? (boreholes!.reduce((s, b) => s + (b.elevation ?? 0), 0) / boreholes!.length).toFixed(2) : "-",
                            unit: "m", icon: <Compass className="h-4 w-4 text-stone-700" />,
                          },
                          {
                            label: "최대 굴착심도",
                            value: boreholes!.length > 0
                              ? Math.max(...boreholes!.map(b => b.strata.length > 0 ? Math.max(...b.strata.map(s => s.depth_bottom)) : 0)).toFixed(2) : "-",
                            unit: "m", icon: <TrendingUp className="h-4 w-4 text-stone-700" />,
                          },
                        ].map(({ label, value, unit, icon, sub }) => (
                          <div key={label} className="p-4 rounded-xl border border-border/60 bg-card/50 backdrop-blur flex flex-col gap-1 shadow-sm">
                            <div className="flex justify-between items-center text-muted-foreground">
                              <span className="text-xs font-medium">{label}</span>
                              {icon}
                            </div>
                            <div className="text-2xl font-bold mt-1">{value} <span className="text-xs font-normal text-muted-foreground">{unit}</span></div>
                            {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
                          </div>
                        ))}
                      </div>

                      {/* 시추공 테이블 */}
                      <div className="rounded-xl border border-border/60 bg-card/40 overflow-hidden shadow-sm">
                        <div className="px-4 py-3 border-b border-border/60 bg-muted/30 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-semibold">시추데이터 목록</span>
                            <div className="flex gap-1.5">
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-800 border border-stone-300">기존 {origCount}개</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-200 text-stone-700 border border-stone-300">신규 {suppCount}개</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Filter className="h-3 w-3 text-muted-foreground" />
                            <select
                              value={filter}
                              onChange={e => setFilter(e.target.value as FilterType)}
                              className="text-[11px] bg-background border border-input rounded px-2 py-0.5 text-foreground outline-none"
                            >
                              <option value="all">전체 {totalCount}개</option>
                              <option value="original">기존만 {origCount}개</option>
                              <option value="supplementary">신규만 {suppCount}개</option>
                            </select>
                          </div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[640px] text-left text-xs">
                            <thead>
                              <tr className="border-b border-border/40 text-muted-foreground bg-muted/10">
                                {["구분", "시추공명", "표고", "굴착심도", "지층", "위치 (경도, 위도)", ""].map(h => (
                                  <th key={h} className="px-3 py-2.5 font-medium">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {boreholeGroups.map(group => (
                                <Fragment key={group.key}>
                                  {group.label && (
                                    <tr className="border-b border-stone-300 bg-stone-100">
                                      <td colSpan={7} className="p-0">
                                        <button
                                          type="button"
                                          onClick={() => toggleGroup(group.key)}
                                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold text-stone-800"
                                        >
                                          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsedGroups.has(group.key) ? "-rotate-90" : ""}`} />
                                          <span>{group.label}</span>
                                          <span className="rounded-full border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] font-normal text-stone-600">
                                            {group.items.length}개 시추공
                                          </span>
                                        </button>
                                      </td>
                                    </tr>
                                  )}
                                  {!collapsedGroups.has(group.key) && group.items.map(b => {
                                    const maxDepth = b.strata.length > 0 ? Math.max(...b.strata.map(s => s.depth_bottom)) : 0
                                    return (
                                      <tr key={b.id}
                                    className={`border-b border-border/40 hover:bg-muted/20 transition-colors ${
                                      selected?.id === b.id
                                        ? "bg-stone-100"
                                        : isProjectNew(b)
                                        ? "bg-stone-100"
                                        : ""
                                    }`}
                                  >
                                    <td className="px-3 py-3">
                                      <div className="flex gap-1">
                                        <BoreholeTypeBadge isSupplementary={isProjectNew(b)} status={b.data_status} />
                                        <BoreholeOriginBadge origin={b.data_origin} />
                                      </div>
                                    </td>
                                    <td className="px-3 py-3 font-semibold">{b.name}</td>
                                    <td className="px-3 py-3 text-muted-foreground">{b.elevation != null ? `${b.elevation.toFixed(2)}m` : "-"}</td>
                                    <td className="px-3 py-3 text-muted-foreground">{maxDepth > 0 ? `${maxDepth.toFixed(2)}m` : "-"}</td>
                                    <td className="px-3 py-3">
                                      <Badge variant="outline" className="text-[10px] font-semibold text-stone-700 bg-stone-100 border-stone-300">
                                        {b.strata.length}개
                                      </Badge>
                                    </td>
                                    <td className="px-3 py-3 text-muted-foreground">{b.longitude.toFixed(5)}, {b.latitude.toFixed(5)}</td>
                                    <td className="px-3 py-3">
                                      <Button size="sm" variant="ghost"
                                        className="h-7 px-2.5 text-xs text-stone-700 hover:text-stone-800 hover:bg-stone-200 font-semibold"
                                        onClick={() => handleSelectBorehole(b)}
                                      >
                                        주상도 보기
                                      </Button>
                                    </td>
                                      </tr>
                                    )
                                  })}
                                </Fragment>
                              ))}
                            </tbody>
                          </table>
                          {filteredBoreholes.length === 0 && (
                            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                              필터 조건에 해당하는 시추공이 없습니다.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  {selected && (<>

              {/* 주상도 상세 */}
                    <aside className="sticky top-6 rounded-xl border border-border/60 bg-card/50 p-4 shadow-sm min-w-0">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="h-4 w-4" />
                      </button>
                      <h2 className="text-base font-semibold">{selected.name}</h2>
                      <BoreholeTypeBadge isSupplementary={isProjectNew(selected)} status={selected.data_status} />
                      <BoreholeOriginBadge origin={selected.data_origin} />
                      {selected.strata.length > 0 && <Badge variant="slate" className="text-xs">{selected.strata.length}개 지층</Badge>}
                    </div>
                    <Button size="sm" variant={editing ? "secondary" : "outline"} className="h-7 text-xs" onClick={handleToggleEditing}>
                      {editing ? <><X className="h-3 w-3 mr-1" />닫기</> : <><Pencil className="h-3 w-3 mr-1" />편집</>}
                    </Button>
                  </div>
                  <div className="space-y-4">
                    <StratigraphyColumn borehole={selected} />
                    {editing && (
                      <div className="border-t border-border/60 pt-4">
                        <BoreholeEditorPanel
                          borehole={selected}
                          projectId={projectId}
                          onClose={() => setEditing(false)}
                          onCancel={handleCancelEditing}
                          onPreviewChange={(updated) => setSelected(updated)}
                          onSaved={handleBoreholeSaved}
                        />
                      </div>
                    )}
                  </div>
                    </aside>
                    </>)}
            </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
