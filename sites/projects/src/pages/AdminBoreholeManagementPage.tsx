import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, Database,
  EyeOff, FileText, FolderInput, GitMerge, MapPin, MapPinOff, RefreshCw, Ruler, Search, Trash2, X,
} from "lucide-react"
import Navbar from "@/components/Navbar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import type { Borehole, Stratum } from "@/lib/types"
import { MAP_URL, apiUrl } from "@shared/urls"
import { getStrataColor, normalizeStrataGroup } from "@shared/strataColor"

interface CurrentUser {
  id: number
  email: string
  role: string
  full_name?: string | null
}

interface BoreholeResponse {
  boreholes: Borehole[]
  count: number
  total: number
  limit: number
  offset: number
}

interface DuplicateBoreholeItem {
  id: number
  name: string
  project_id: number
  longitude: number
  latitude: number
  elevation: number | null
  data_origin?: string | null
  source_file?: string | null
  strata_count: number
  max_depth: number | null
}

interface DuplicateBoreholeGroup {
  key: { name: string; longitude: number; latitude: number }
  duplicate_type: "exact" | "conflict" | "coordinate_conflict"
  count: number
  keep_id: number
  items: DuplicateBoreholeItem[]
}

interface DuplicateBoreholeResponse {
  groups: DuplicateBoreholeGroup[]
  summary: {
    groups: number
    exact_groups: number
    conflict_groups: number
    coordinate_conflict_groups?: number
    duplicate_rows: number
    removable_rows: number
  }
}

const ORIGIN_LABEL: Record<string, string> = {
  public: "공공데이터",
  user_upload: "사용자 업로드",
  manual_input: "직접 입력",
  test: "테스트",
}

const PAGE_SIZE = 100

type FlagKey = "duplicate" | "depth_anomaly" | "unreviewed" | "coord_outlier"

const FLAG_META: Record<FlagKey, { label: string; icon: typeof Copy; badge: string; card: string }> = {
  duplicate:     { label: "중복 의심",   icon: Copy,       badge: "bg-amber-100 text-amber-800 border-amber-200",   card: "text-amber-700" },
  depth_anomaly: { label: "심도 이상",   icon: Ruler,      badge: "bg-orange-100 text-orange-800 border-orange-200", card: "text-orange-700" },
  unreviewed:    { label: "미검수",      icon: EyeOff,     badge: "bg-violet-100 text-violet-800 border-violet-200", card: "text-violet-700" },
  coord_outlier: { label: "좌표 이탈",   icon: MapPinOff,  badge: "bg-rose-100 text-rose-800 border-rose-200",       card: "text-rose-700" },
}
const FLAG_ORDER: FlagKey[] = ["duplicate", "depth_anomaly", "unreviewed", "coord_outlier"]

function originLabel(origin?: string | null) {
  return ORIGIN_LABEL[origin || "public"] ?? origin ?? "공공데이터"
}

function sortedStrata(b: { strata?: Stratum[] }): Stratum[] {
  return [...(b.strata ?? [])].sort((a, z) => a.depth_top - z.depth_top)
}

function maxDepth(b: { strata?: Stratum[] }): number | null {
  const s = sortedStrata(b)
  return s.length ? s[s.length - 1].depth_bottom : null
}

function hasDepthAnomaly(b: Borehole): boolean {
  const s = sortedStrata(b)
  if (s.length === 0) return false
  const TOL = 0.02
  if (s[0].depth_top < -TOL) return true
  for (const x of s) if (x.depth_bottom <= x.depth_top) return true
  for (let i = 0; i < s.length - 1; i++) {
    if (Math.abs(s[i].depth_bottom - s[i + 1].depth_top) > TOL) return true
  }
  return s[s.length - 1].depth_bottom <= 0
}

function isCoordOutlier(b: Borehole): boolean {
  const { longitude: lng, latitude: lat } = b
  if (lng == null || lat == null) return true
  if (lng === 0 && lat === 0) return true
  return lng < 124 || lng > 132 || lat < 33 || lat > 43
}

function isUnreviewed(b: Borehole): boolean {
  if ((b.strata?.length ?? 0) === 0) return true
  return String(b.data_status || "").includes("pending_review")
}

function deriveFlags(b: Borehole, dupIds: Set<number>): FlagKey[] {
  const out: FlagKey[] = []
  if (dupIds.has(b.id)) out.push("duplicate")
  if (hasDepthAnomaly(b)) out.push("depth_anomaly")
  if (isUnreviewed(b)) out.push("unreviewed")
  if (isCoordOutlier(b)) out.push("coord_outlier")
  return out
}

const GROUP_LABEL: Record<string, string> = {
  soil: "토사", weathered_rock: "풍화암", soft_rock: "연암",
  normal_rock: "보통암", hard_rock: "경암", unknown: "미분류",
}
function strataLabel(soilType: string) {
  return GROUP_LABEL[normalizeStrataGroup(soilType)] ?? soilType
}

function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async () => {
      const res = await api.get<CurrentUser>("/auth/me")
      return res.data
    },
  })
}

function useAdminBoreholes(page: number, query: string, origin: string) {
  return useQuery({
    queryKey: ["admin-boreholes", page, query, origin],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
        include_strata: "true",
      })
      if (query.trim()) params.set("q", query.trim())
      if (origin !== "all") params.set("data_origin", origin)
      const res = await api.get<BoreholeResponse>(`/boreholes?${params}`)
      return res.data
    },
    placeholderData: (previous) => previous,
  })
}

function useDuplicateBoreholes(enabled: boolean) {
  return useQuery({
    queryKey: ["admin-borehole-duplicates"],
    queryFn: async () => {
      const res = await api.get<DuplicateBoreholeResponse>("/boreholes/admin/duplicates")
      return res.data
    },
    enabled,
  })
}

function OriginBadge({ origin }: { origin?: string | null }) {
  const label = originLabel(origin)
  const className =
    origin === "user_upload"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : origin === "manual_input"
        ? "bg-sky-100 text-sky-800 border-sky-200"
        : origin === "test"
          ? "bg-rose-100 text-rose-800 border-rose-200"
          : "bg-stone-100 text-stone-700 border-stone-200"
  return <Badge variant="outline" className={className}>{label}</Badge>
}

function FlagBadges({ flags }: { flags: FlagKey[] }) {
  if (flags.length === 0) {
    return <span className="text-xs text-emerald-600 inline-flex items-center gap-1"><Check className="h-3 w-3" />정상</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={`text-[10px] px-1.5 py-0.5 rounded border ${FLAG_META[f].badge}`}>
          {FLAG_META[f].label}
        </span>
      ))}
    </span>
  )
}

type SortDir = "none" | "asc" | "desc"

export default function AdminBoreholeManagementPage() {
  const queryClient = useQueryClient()
  const { data: user, isLoading: userLoading } = useCurrentUser()
  const isAdmin = user?.role === "admin"
  const [query, setQuery] = useState("")
  const [origin, setOrigin] = useState("all")
  const [page, setPage] = useState(1)
  const { data, isLoading, error, refetch, isFetching } = useAdminBoreholes(page, query, origin)
  const { data: duplicateData, isFetching: duplicateFetching, refetch: refetchDuplicates } = useDuplicateBoreholes(Boolean(isAdmin))
  const [flagFilter, setFlagFilter] = useState<FlagKey | null>(null)
  const [sortDepth, setSortDepth] = useState<SortDir>("none")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [compareGroup, setCompareGroup] = useState<DuplicateBoreholeGroup | null>(null)

  const deleteMutation = useMutation({
    mutationFn: async (borehole: Borehole) => {
      await api.delete(`/boreholes/${borehole.id}`)
      return borehole
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-boreholes"] })
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["boreholes"] })
    },
  })

  const mergeExactDuplicatesMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post("/boreholes/admin/duplicates/merge-exact", { mode: "exact" })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-boreholes"] })
      queryClient.invalidateQueries({ queryKey: ["admin-borehole-duplicates"] })
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["boreholes"] })
    },
  })

  const boreholes = data?.boreholes ?? []

  const boreholeById = useMemo(() => {
    const m = new Map<number, Borehole>()
    for (const b of boreholes) m.set(b.id, b)
    return m
  }, [boreholes])

  const dupIds = useMemo(() => {
    const s = new Set<number>()
    for (const g of duplicateData?.groups ?? []) for (const it of g.items) s.add(it.id)
    return s
  }, [duplicateData])

  const flagsById = useMemo(() => {
    const m = new Map<number, FlagKey[]>()
    for (const b of boreholes) m.set(b.id, deriveFlags(b, dupIds))
    return m
  }, [boreholes, dupIds])

  const originStats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of boreholes) {
      const key = b.data_origin || "public"
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [boreholes])

  const flagStats = useMemo(() => {
    const counts: Record<FlagKey, number> = { duplicate: 0, depth_anomaly: 0, unreviewed: 0, coord_outlier: 0 }
    let clean = 0
    for (const b of boreholes) {
      const f = flagsById.get(b.id) ?? []
      if (f.length === 0) clean++
      for (const k of f) counts[k]++
    }
    return { counts, clean, flagged: boreholes.length - clean }
  }, [boreholes, flagsById])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = boreholes.filter((b) => {
      if (flagFilter && !(flagsById.get(b.id) ?? []).includes(flagFilter)) return false
      return true
    })
    if (sortDepth !== "none") {
      list.sort((a, b) => {
        const da = maxDepth(a) ?? -1
        const db = maxDepth(b) ?? -1
        return sortDepth === "asc" ? da - db : db - da
      })
    }
    return list
  }, [boreholes, flagFilter, flagsById, sortDepth])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const visible = filtered

  const visibleIds = visible.map((b) => b.id)
  const allVisibleChecked = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  const toggleCheck = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleCheckAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allVisibleChecked) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }

  const cycleSortDepth = () => {
    setSortDepth((d) => (d === "none" ? "desc" : d === "desc" ? "asc" : "none"))
    setPage(1)
  }

  const handleFlagCard = (f: FlagKey) => {
    setFlagFilter((cur) => (cur === f ? null : f))
    setPage(1)
  }

  const openInMap = (b: { project_id: number }) => {
    window.open(`${MAP_URL}/?project_id=${b.project_id}`, "_blank", "noopener")
  }

  const handleDelete = async (borehole: Borehole) => {
    const ok = confirm(
      `시추공 '${borehole.name}'(ID ${borehole.id})을 삭제하시겠습니까?\n\n` +
      "삭제된 시추공은 프로젝트 목록과 지도/3D 조회에서 제외됩니다.",
    )
    if (!ok) return
    try {
      await deleteMutation.mutateAsync(borehole)
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(borehole.id); return n })
    } catch (err: any) {
      alert(`삭제하지 못했습니다.\n\n${err.response?.data?.detail || err.message}`)
    }
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const ok = confirm(
      `선택한 시추공 ${ids.length.toLocaleString()}개를 삭제하시겠습니까?\n\n` +
      "삭제된 시추공은 프로젝트 목록과 지도/3D 조회에서 제외됩니다.",
    )
    if (!ok) return
    let failed = 0
    for (const id of ids) {
      try { await api.delete(`/boreholes/${id}`) } catch { failed++ }
    }
    queryClient.invalidateQueries({ queryKey: ["admin-boreholes"] })
    queryClient.invalidateQueries({ queryKey: ["admin-borehole-duplicates"] })
    queryClient.invalidateQueries({ queryKey: ["projects"] })
    queryClient.invalidateQueries({ queryKey: ["boreholes"] })
    setSelectedIds(new Set())
    if (failed) alert(`${failed}개는 삭제하지 못했습니다. (권한 또는 서버 오류)`)
  }

  const handleBulkMerge = async () => {
    const ids = [...selectedIds].sort((a, b) => a - b)
    if (ids.length < 2) { alert("병합하려면 2개 이상 선택하세요."); return }
    const keepId = ids[0]
    const ok = confirm(
      `가장 작은 ID #${keepId}를 대표로 두고 나머지 ${ids.length - 1}개를 병합합니다.\n` +
      "프로젝트 연결·영역 ID는 대표로 이관되고 나머지는 삭제됩니다.\n\n계속하시겠습니까?",
    )
    if (!ok) return
    try {
      const res = await api.post("/boreholes/admin/merge", { keep_id: keepId, duplicate_ids: ids.slice(1) })
      queryClient.invalidateQueries({ queryKey: ["admin-boreholes"] })
      queryClient.invalidateQueries({ queryKey: ["admin-borehole-duplicates"] })
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["boreholes"] })
      setSelectedIds(new Set())
      alert(`병합 완료 · 대표 #${res.data.keep_id} · 삭제 ${res.data.removed}건`)
    } catch (err: any) {
      alert(`병합에 실패했습니다.\n\n${err.response?.data?.detail || err.message}`)
    }
  }

  const handleBulkMoveProject = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const input = window.prompt(`선택한 ${ids.length}개 시추공을 이동할 대상 프로젝트 ID를 입력하세요.`)
    if (input == null) return
    const pid = Number(input.trim())
    if (!Number.isInteger(pid) || pid <= 0) { alert("올바른 프로젝트 ID(양의 정수)를 입력하세요."); return }
    if (!confirm(`${ids.length}개 시추공을 프로젝트 #${pid}로 이동하시겠습니까?`)) return
    let failed = 0
    for (const id of ids) {
      try { await api.patch(`/boreholes/${id}`, { project_id: pid }) } catch { failed++ }
    }
    queryClient.invalidateQueries({ queryKey: ["admin-boreholes"] })
    queryClient.invalidateQueries({ queryKey: ["projects"] })
    queryClient.invalidateQueries({ queryKey: ["boreholes"] })
    setSelectedIds(new Set())
    if (failed) alert(`${failed}개는 이동하지 못했습니다. (대상 프로젝트 없음/권한/오류)`)
  }

  const handleMergeExactDuplicates = async () => {
    const removable = duplicateData?.summary.removable_rows ?? 0
    if (removable === 0) {
      alert("정리할 완전 중복 시추공이 없습니다.")
      return
    }
    const ok = confirm(
      `지층까지 동일한 완전 중복 시추공 ${removable.toLocaleString()}개를 정리하시겠습니까?\n\n` +
      "각 중복 그룹에서 가장 작은 ID 1개만 남기고, 프로젝트 연결과 영역 선택 ID는 대표 시추공으로 이관됩니다.",
    )
    if (!ok) return
    try {
      const result = await mergeExactDuplicatesMutation.mutateAsync()
      alert(
        `완전 중복 정리가 완료되었습니다.\n\n` +
        `정리 그룹: ${result.groups_merged?.toLocaleString?.() ?? result.groups_merged}\n` +
        `삭제 처리: ${result.removed?.toLocaleString?.() ?? result.removed}\n` +
        `영역 ID 갱신 프로젝트: ${result.projects_bbox_updated?.toLocaleString?.() ?? result.projects_bbox_updated}`,
      )
    } catch (err: any) {
      alert(`중복 정리에 실패했습니다.\n\n${err.response?.data?.detail || err.message}`)
    }
  }

  const duplicateSummary = duplicateData?.summary
  const conflictGroups = duplicateData?.groups.filter((g) => g.duplicate_type === "conflict") ?? []
  const coordinateConflictGroups = duplicateData?.groups.filter((g) => g.duplicate_type === "coordinate_conflict") ?? []

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <Navbar active="admin" />

      <main className="flex-1 overflow-hidden flex flex-col">
        <section className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-muted-foreground" />
                <h1 className="text-xl font-semibold">시추공 관리</h1>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                전체 시추공의 데이터 정합성을 점검하고 중복·오류를 정리합니다. 위치·지층 탐색은 지도 화면을 이용하세요.
              </p>
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              새로고침
            </Button>
          </div>

          {!userLoading && !isAdmin && (
            <div className="mt-3 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              현재 계정은 관리자 권한이 아닙니다. 목록 조회는 가능하지만 삭제는 서버에서 거부됩니다.
            </div>
          )}
        </section>

        <section className="px-6 py-4 border-b border-border bg-background">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-muted-foreground">데이터 품질 — 카드를 클릭하면 해당 항목만 필터됩니다</div>
            <div className="text-xs text-muted-foreground">
              정상 {flagStats.clean.toLocaleString()} · 검토 필요 {flagStats.flagged.toLocaleString()}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {FLAG_ORDER.map((f) => {
              const Meta = FLAG_META[f]
              const Icon = Meta.icon
              const active = flagFilter === f
              return (
                <button
                  key={f}
                  onClick={() => handleFlagCard(f)}
                  className={`rounded border px-3 py-2 text-left transition ${active ? "border-foreground ring-1 ring-foreground/40 bg-muted/40" : "border-border bg-card hover:bg-muted/30"}`}
                >
                  <div className={`text-xs flex items-center gap-1.5 ${Meta.card}`}>
                    <Icon className="h-3.5 w-3.5" />{Meta.label}
                  </div>
                  <div className="mt-1 text-lg font-semibold">{flagStats.counts[f].toLocaleString()}</div>
                </button>
              )
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="전체" value={data?.total ?? 0} />
            <StatCard label="공공데이터" value={originStats.get("public") ?? 0} />
            <StatCard label="사용자 업로드" value={originStats.get("user_upload") ?? 0} />
            <StatCard label="직접 입력" value={originStats.get("manual_input") ?? 0} />
            <StatCard label="테스트" value={originStats.get("test") ?? 0} />
          </div>
        </section>

        {isAdmin && (
          <section className="border-b border-border bg-card px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <h2 className="text-sm font-semibold">중복 시추공 검토</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  같은 이름과 좌표를 가진 시추공을 비교합니다. 지층까지 동일한 항목은 자동 정리하고, 지층이 다른 항목은 "비교"로 직접 검토하세요.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetchDuplicates()} disabled={duplicateFetching}>
                  <RefreshCw className={`mr-1 h-3.5 w-3.5 ${duplicateFetching ? "animate-spin" : ""}`} />
                  중복 새로고침
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleMergeExactDuplicates}
                  disabled={mergeExactDuplicatesMutation.isPending || duplicateFetching || (duplicateSummary?.removable_rows ?? 0) === 0}
                >
                  완전 중복 정리
                </Button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 md:grid-cols-6 gap-3">
              <StatCard label="중복 그룹" value={duplicateSummary?.groups ?? 0} />
              <StatCard label="완전 중복 그룹" value={duplicateSummary?.exact_groups ?? 0} />
              <StatCard label="지층 검토 그룹" value={duplicateSummary?.conflict_groups ?? 0} />
              <StatCard label="좌표 중복 그룹" value={duplicateSummary?.coordinate_conflict_groups ?? 0} />
              <StatCard label="중복 행" value={duplicateSummary?.duplicate_rows ?? 0} />
              <StatCard label="정리 가능" value={duplicateSummary?.removable_rows ?? 0} />
            </div>

            {conflictGroups.length > 0 && (
              <div className="mt-4 overflow-hidden rounded border border-amber-200 bg-amber-50/40">
                <div className="border-b border-amber-200 px-3 py-2 text-xs font-semibold text-amber-900">
                  지층 정보가 달라 관리자 검토가 필요한 중복 그룹
                </div>
                <div className="max-h-56 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-amber-100/70 text-amber-900">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">이름</th>
                        <th className="px-3 py-2 text-left font-medium">좌표</th>
                        <th className="px-3 py-2 text-left font-medium">후보 ID</th>
                        <th className="px-3 py-2 text-right font-medium">최대 심도</th>
                        <th className="px-3 py-2 text-right font-medium">검토</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conflictGroups.slice(0, 30).map((group) => (
                        <tr key={`${group.key.name}-${group.key.longitude}-${group.key.latitude}`} className="border-t border-amber-200/70">
                          <td className="px-3 py-2 font-medium">{group.key.name}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {group.key.longitude.toFixed(7)}, {group.key.latitude.toFixed(7)}
                          </td>
                          <td className="px-3 py-2 font-mono">{group.items.map((item) => item.id).join(", ")}</td>
                          <td className="px-3 py-2 text-right">
                            {group.items.map((item) => item.max_depth == null ? "-" : `${item.max_depth.toFixed(2)}m`).join(" / ")}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setCompareGroup(group)}>비교</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {conflictGroups.length > 30 && (
                  <div className="border-t border-amber-200 px-3 py-2 text-xs text-amber-900">상위 30개만 표시 중입니다.</div>
                )}
              </div>
            )}

            {coordinateConflictGroups.length > 0 && (
              <div className="mt-4 overflow-hidden rounded border border-sky-200 bg-sky-50/40">
                <div className="border-b border-sky-200 px-3 py-2 text-xs font-semibold text-sky-900">
                  좌표는 같지만 이름이 달라 관리자 검토가 필요한 그룹
                </div>
                <div className="max-h-56 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-sky-100/70 text-sky-900">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">좌표</th>
                        <th className="px-3 py-2 text-left font-medium">시추공명</th>
                        <th className="px-3 py-2 text-left font-medium">후보 ID</th>
                        <th className="px-3 py-2 text-right font-medium">최대 심도</th>
                        <th className="px-3 py-2 text-right font-medium">검토</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coordinateConflictGroups.slice(0, 30).map((group) => (
                        <tr key={`coord-${group.key.longitude}-${group.key.latitude}`} className="border-t border-sky-200/70">
                          <td className="px-3 py-2 text-muted-foreground">
                            {group.key.longitude.toFixed(7)}, {group.key.latitude.toFixed(7)}
                          </td>
                          <td className="px-3 py-2 font-medium">{group.items.map((item) => item.name).join(", ")}</td>
                          <td className="px-3 py-2 font-mono">{group.items.map((item) => item.id).join(", ")}</td>
                          <td className="px-3 py-2 text-right">
                            {group.items.map((item) => item.max_depth == null ? "-" : `${item.max_depth.toFixed(2)}m`).join(" / ")}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setCompareGroup(group)}>비교</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {coordinateConflictGroups.length > 30 && (
                  <div className="border-t border-sky-200 px-3 py-2 text-xs text-sky-900">상위 30개만 표시 중입니다.</div>
                )}
              </div>
            )}
          </section>
        )}

        <section className="flex items-center gap-3 px-6 py-3 border-b border-border bg-card">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              placeholder="ID, 시추공명, 프로젝트 ID, 원본 파일명 검색"
              className="h-9 w-full rounded border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <select
            value={origin}
            onChange={(e) => { setOrigin(e.target.value); setPage(1) }}
            className="h-9 rounded border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">전체 출처</option>
            <option value="public">공공데이터</option>
            <option value="user_upload">사용자 업로드</option>
            <option value="manual_input">직접 입력</option>
            <option value="test">테스트</option>
          </select>
          {flagFilter && (
            <button
              onClick={() => { setFlagFilter(null); setPage(1) }}
              className="h-9 inline-flex items-center gap-1 rounded border border-border px-3 text-xs text-muted-foreground hover:bg-muted/40"
            >
              {FLAG_META[flagFilter].label} 필터 <X className="h-3 w-3" />
            </button>
          )}
          <div className="text-xs text-muted-foreground">{filtered.length.toLocaleString()}개 표시</div>
        </section>

        {selectedIds.size > 0 && (
          <section className="flex items-center gap-2 px-6 py-2 border-b border-border bg-sky-50">
            <span className="text-xs font-medium text-sky-800">{selectedIds.size.toLocaleString()}개 선택됨</span>
            <Button
              variant="outline" size="sm" className="h-7 text-xs"
              disabled={!isAdmin || selectedIds.size < 2}
              onClick={handleBulkMerge}
              title="가장 작은 ID를 대표로 병합"
            >
              <GitMerge className="mr-1 h-3.5 w-3.5" />병합
            </Button>
            <Button
              variant="outline" size="sm" className="h-7 text-xs"
              disabled={!isAdmin}
              onClick={handleBulkMoveProject}
            >
              <FolderInput className="mr-1 h-3.5 w-3.5" />프로젝트 이동
            </Button>
            <Button
              variant="outline" size="sm"
              className="h-7 text-xs text-destructive border-destructive/40 hover:text-destructive"
              disabled={!isAdmin}
              onClick={handleBulkDelete}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />삭제
            </Button>
            <button onClick={() => setSelectedIds(new Set())} className="ml-1 text-xs text-muted-foreground hover:underline">선택 해제</button>
          </section>
        )}

        <section className="flex-1 overflow-auto px-6 py-4">
          {isLoading && <div className="text-sm text-muted-foreground">시추공 목록을 불러오는 중입니다.</div>}
          {error && <div className="text-sm text-destructive">목록을 불러오지 못했습니다: {String(error)}</div>}

          {!isLoading && !error && (
            <div className="overflow-hidden rounded border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-center font-medium w-9">
                      <input type="checkbox" checked={allVisibleChecked} onChange={toggleCheckAllVisible} aria-label="전체 선택" />
                    </th>
                    <th className="px-3 py-2 text-left font-medium">ID</th>
                    <th className="px-3 py-2 text-left font-medium">시추공명</th>
                    <th className="px-3 py-2 text-left font-medium">출처</th>
                    <th className="px-3 py-2 text-left font-medium">프로젝트</th>
                    <th className="px-3 py-2 text-right font-medium">표고</th>
                    <th className="px-3 py-2 text-right font-medium">
                      <button onClick={cycleSortDepth} className="inline-flex items-center gap-1 hover:text-foreground">
                        굴착심도
                        {sortDepth === "none" ? <ArrowUpDown className="h-3 w-3" /> : sortDepth === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-left font-medium">상태</th>
                    <th className="px-3 py-2 text-right font-medium">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((b) => {
                    const depth = maxDepth(b)
                    const flags = flagsById.get(b.id) ?? []
                    const checked = selectedIds.has(b.id)
                    return (
                      <tr key={b.id} className={`border-t border-border/70 ${checked ? "bg-sky-50/60" : "hover:bg-muted/30"}`}>
                        <td className="px-3 py-2 text-center">
                          <input type="checkbox" checked={checked} onChange={() => toggleCheck(b.id)} aria-label={`${b.name} 선택`} />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{b.id}</td>
                        <td className="px-3 py-2 font-medium">{b.name}</td>
                        <td className="px-3 py-2"><OriginBadge origin={b.data_origin} /></td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{b.project_id}</td>
                        <td className="px-3 py-2 text-right text-xs">{b.elevation == null ? "-" : `${b.elevation.toFixed(2)}m`}</td>
                        <td className="px-3 py-2 text-right text-xs">{depth == null ? "-" : `${depth.toFixed(2)}m`}</td>
                        <td className="px-3 py-2"><FlagBadges flags={flags} /></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="지도에서 보기" onClick={() => openInMap(b)}>
                              <MapPin className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                              disabled={deleteMutation.isPending || !isAdmin}
                              onClick={() => handleDelete(b)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-10 text-center text-sm text-muted-foreground">
                        조건에 맞는 시추공이 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="flex items-center justify-between border-t border-border bg-card px-6 py-3 text-xs text-muted-foreground">
          <span>{safePage} / {totalPages} 페이지</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>이전</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>다음</Button>
          </div>
        </footer>
      </main>

      {compareGroup && (
        <CompareModal
          group={compareGroup}
          boreholeById={boreholeById}
          isAdmin={isAdmin}
          onOpenInMap={openInMap}
          onClose={() => setCompareGroup(null)}
          onResolved={() => {
            setCompareGroup(null)
            queryClient.invalidateQueries({ queryKey: ["admin-boreholes"] })
            queryClient.invalidateQueries({ queryKey: ["admin-borehole-duplicates"] })
            queryClient.invalidateQueries({ queryKey: ["projects"] })
            queryClient.invalidateQueries({ queryKey: ["boreholes"] })
          }}
        />
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  )
}

function MiniLog({ b, scaleDepth, height = 220 }: { b: Borehole; scaleDepth: number; height?: number }) {
  const strata = sortedStrata(b)
  const total = scaleDepth > 0 ? scaleDepth : 1
  return (
    <div className="flex gap-2">
      <div className="relative w-7 shrink-0 text-[10px] text-muted-foreground" style={{ height }}>
        {strata.map((s, i) => (
          <div key={i} className="absolute right-0" style={{ top: `${(s.depth_top / total) * height}px` }}>{s.depth_top.toFixed(0)}</div>
        ))}
        <div className="absolute right-0" style={{ top: `${height}px` }}>{(maxDepth(b) ?? 0).toFixed(0)}m</div>
      </div>
      <div className="w-6 shrink-0 rounded overflow-hidden border border-border" style={{ height }}>
        {strata.map((s, i) => (
          <div key={i} style={{ height: `${((s.depth_bottom - s.depth_top) / total) * height}px`, backgroundColor: getStrataColor(s.soil_type) }} />
        ))}
      </div>
      <div className="flex-1 min-w-0 text-[11px] leading-tight space-y-0.5">
        {strata.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: getStrataColor(s.soil_type) }} />
            <span className="truncate">{strataLabel(s.soil_type)}</span>
            <span className="ml-auto text-muted-foreground">{(s.depth_bottom - s.depth_top).toFixed(1)}m</span>
          </div>
        ))}
        {strata.length === 0 && <div className="text-muted-foreground">지층 데이터 없음</div>}
      </div>
    </div>
  )
}

function PdfPeek({ boreholeId, label, onClose }: { boreholeId: number; label: string; onClose: () => void }) {
  const [meta, setMeta] = useState<{ loading: boolean; error: string | null; jobId: number | null; pageCount: number; fileName: string; matchPages: number[]; searched: boolean }>(
    { loading: true, error: null, jobId: null, pageCount: 1, fileName: "", matchPages: [], searched: false },
  )
  const [page, setPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    setMeta({ loading: true, error: null, jobId: null, pageCount: 1, fileName: "", matchPages: [], searched: false })
    setPage(1)
    api.get(`/boreholes/${boreholeId}/source-pdf`)
      .then((res) => {
        if (cancelled) return
        const matchPages: number[] = res.data.match_pages ?? []
        setMeta({ loading: false, error: null, jobId: res.data.job_id, pageCount: res.data.page_count ?? 1, fileName: res.data.file_name ?? "", matchPages, searched: true })
        setPage(matchPages[0] ?? 1)
      })
      .catch((err: any) => {
        if (cancelled) return
        setMeta({ loading: false, error: err.response?.data?.detail || "원본 PDF를 불러올 수 없습니다.", jobId: null, pageCount: 1, fileName: "", matchPages: [], searched: false })
      })
    return () => { cancelled = true }
  }, [boreholeId])

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium truncate">{label}{meta.fileName ? ` · ${meta.fileName}` : ""}</div>
        <div className="flex items-center gap-2">
          {meta.jobId != null && meta.pageCount > 1 && (
            <div className="flex items-center gap-1 text-xs">
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>이전</Button>
              <span className="text-muted-foreground">{page} / {meta.pageCount}</span>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= meta.pageCount} onClick={() => setPage((p) => Math.min(meta.pageCount, p + 1))}>다음</Button>
            </div>
          )}
          {meta.jobId != null && (
            <a href={apiUrl(`/api/v1/pdf-extraction/jobs/${meta.jobId}/pages/${page}.png`)} target="_blank" rel="noopener" className="text-xs text-sky-600 hover:underline">새 탭에서 크게 보기</a>
          )}
          <button onClick={onClose} aria-label="PDF 닫기" className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {meta.jobId != null && meta.matchPages.length > 0 && (
        <div className="flex items-center flex-wrap gap-1 mb-2 text-xs">
          <span className="text-muted-foreground">이름 일치 페이지:</span>
          {meta.matchPages.map((mp) => (
            <button key={mp} onClick={() => setPage(mp)} className={`px-2 h-6 rounded border text-xs ${page === mp ? "border-foreground bg-muted/50" : "border-border hover:bg-muted/40"}`}>{mp}</button>
          ))}
        </div>
      )}
      {meta.jobId != null && meta.searched && meta.matchPages.length === 0 && (
        <div className="mb-2 text-xs text-amber-700">이름 자동 검색 결과가 없습니다(스캔 이미지 PDF일 수 있음). 전체 페이지를 넘겨 확인하세요.</div>
      )}
      {meta.loading && <div className="text-xs text-muted-foreground py-6 text-center">원본 PDF 정보를 불러오는 중...</div>}
      {meta.error && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">{meta.error}</div>}
      {!meta.loading && !meta.error && meta.jobId != null && (
        <div className="rounded border border-border bg-muted/20 overflow-auto max-h-[60vh] text-center">
          <img src={apiUrl(`/api/v1/pdf-extraction/jobs/${meta.jobId}/pages/${page}.png`)} alt={`${label} ${page}페이지`} className="inline-block max-w-full h-auto align-top" style={{ objectFit: "contain" }} />
        </div>
      )}
    </div>
  )
}

function CompareModal({
  group, boreholeById, isAdmin, onClose, onResolved, onOpenInMap,
}: {
  group: DuplicateBoreholeGroup
  boreholeById: Map<number, Borehole>
  isAdmin: boolean
  onClose: () => void
  onResolved: () => void
  onOpenInMap: (b: { project_id: number }) => void
}) {
  const [keepId, setKeepId] = useState<number>(group.keep_id)
  const [busy, setBusy] = useState(false)
  const [pdfItemId, setPdfItemId] = useState<number | null>(null)

  const items = group.items
  const scaleDepth = Math.max(
    1,
    ...items.map((it) => {
      const full = boreholeById.get(it.id)
      return (full ? maxDepth(full) : it.max_depth) ?? 0
    }),
  )
  const others = items.filter((it) => it.id !== keepId)

  const handleResolve = async () => {
    if (others.length === 0) return
    const ok = confirm(
      `#${keepId}를 대표로 유지하고 나머지 ${others.length}건(ID ${others.map((o) => o.id).join(", ")})을 병합합니다.\n` +
      "프로젝트 연결·영역 ID는 대표로 이관되고 나머지는 삭제됩니다.\n\n계속하시겠습니까?",
    )
    if (!ok) return
    setBusy(true)
    try {
      await api.post("/boreholes/admin/merge", { keep_id: keepId, duplicate_ids: others.map((o) => o.id) })
      setBusy(false)
      onResolved()
    } catch (err: any) {
      setBusy(false)
      alert(`병합에 실패했습니다.\n\n${err.response?.data?.detail || err.message}`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-lg bg-card border border-border flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Copy className="h-4 w-4 text-amber-600" />
            <h3 className="text-base font-semibold">중복 시추공 비교 — {group.key.name}</h3>
          </div>
          <button onClick={onClose} aria-label="닫기" className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
        </div>

        <div className="overflow-auto p-4">
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(items.length, 3)}, minmax(220px, 1fr))`, gridAutoFlow: "column" }}>
            {items.map((it) => {
              const full = boreholeById.get(it.id)
              const kept = it.id === keepId
              return (
                <div key={it.id} className={`rounded border p-3 ${kept ? "border-foreground ring-1 ring-foreground/30" : "border-border"}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">#{it.id}</span>
                    <OriginBadge origin={it.data_origin} />
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>프로젝트 {it.project_id}</span>
                    <span>지층 {it.strata_count}개</span>
                    <span>표고 {it.elevation == null ? "-" : `${it.elevation.toFixed(2)}m`}</span>
                    <span>심도 {it.max_depth == null ? "-" : `${it.max_depth.toFixed(2)}m`}</span>
                    <span className="col-span-2">좌표계 {full?.source_crs || "-"}</span>
                    <span className="col-span-2">변환좌표 {it.longitude.toFixed(6)}, {it.latitude.toFixed(6)}</span>
                  </div>
                  <div className="mt-3">
                    {full ? <MiniLog b={full} scaleDepth={scaleDepth} /> : <div className="text-xs text-muted-foreground">지층 데이터를 불러올 수 없습니다.</div>}
                  </div>
                  <div className="mt-3 flex items-center gap-1">
                    <Button variant={kept ? "default" : "outline"} size="sm" className="h-8 flex-1 text-xs" onClick={() => setKeepId(it.id)}>
                      <Check className="mr-1 h-3.5 w-3.5" />{kept ? "유지됨" : "이 항목 유지"}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" title="지도에서 보기" onClick={() => onOpenInMap(it)}>
                      <MapPin className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant={pdfItemId === it.id ? "default" : "ghost"} size="sm" className="h-8 px-2 text-xs" title="원본 PDF 보기" onClick={() => setPdfItemId(pdfItemId === it.id ? null : it.id)}>
                      <FileText className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
          {pdfItemId != null && (
            <div className="mt-4 border-t border-border pt-3">
              <PdfPeek boreholeId={pdfItemId} label={`#${pdfItemId} 원본 PDF`} onClose={() => setPdfItemId(null)} />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-muted/30">
          <span className="text-xs text-muted-foreground">
            #{keepId}를 대표로 유지 · 나머지 {others.length}건은 대표로 병합(연결 이관 후 삭제)됩니다.
          </span>
          <Button
            variant="outline" size="sm"
            className="h-8 text-xs"
            disabled={busy || others.length === 0 || !isAdmin}
            onClick={handleResolve}
          >
            <GitMerge className="mr-1 h-3.5 w-3.5" />유지 + 나머지 {others.length}건 병합
          </Button>
        </div>
      </div>
    </div>
  )
}
