import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, FileSpreadsheet, AlertTriangle, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { CRS_OPTIONS } from "@/lib/constants"
import { apiPostForm } from "@/lib/api"
import type { PreviewRow, Project } from "@/lib/types"
import { DropZone } from "./DropZone"
import { PreviewPanel } from "./PreviewPanel"
import { Button } from "./ui/button"

// 마법사에서 선택 가능한 컬럼 역할 (백엔드 apply_overrides 와 호환)
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "project_name", label: "프로젝트명(조사명)" },
  { value: "name", label: "시추공명" },
  { value: "lon", label: "경도" },
  { value: "lat", label: "위도" },
  { value: "x", label: "X(평면)" },
  { value: "y", label: "Y(평면)" },
  { value: "elevation", label: "표고" },
  { value: "depth_top", label: "상심도" },
  { value: "depth_bottom", label: "하심도" },
  { value: "soil_type", label: "지층명(long)" },
  { value: "stratum", label: "지층 두께(wide)" },
  { value: "total_depth", label: "시추심도" },
  { value: "water_gl", label: "지하수위 GL" },
  { value: "water_el", label: "지하수위 EL" },
  { value: "crs", label: "좌표계(CRS)" },
  { value: "ignore", label: "사용 안 함" },
]

type StratumPreview = { 상심도: number; 하심도: number; 지층명: string }
type BoreholePreview = {
  project_name?: string | null
  name: string
  longitude: number | null
  latitude: number | null
  source_crs: string | null
  elevation: number | null
  water_level_gl?: number | null
  water_level_el?: number | null
  raw_x?: number | null
  raw_y?: number | null
  strata: StratumPreview[]
}
type MappingDto = {
  fmt: "wide" | "long" | "ambiguous"
  header_row: number
  roles: Record<string, string>
  stratum_columns: { header: string; group: string }[]
  source_crs: string | null
  confidence: number
  warnings: string[]
  headers: string[]
}
type PreviewResponse = {
  filename: string
  mapping: MappingDto
  summary: { boreholes: number; strata: number; rows_total: number }
  preview: BoreholePreview[]
  issues: string[]
}
type CommitResponse = {
  job_id: number
  status: string
  result: Record<string, number>
  issues: string[]
}

export function CsvParseTab({
  projects,
  loadingProjects,
  lockedProjectId,
  projectId,
  setProjectId,
  file,
  setFile,
  returnUrl,
  onReviewReadyChange,
}: {
  projects: Project[]
  loadingProjects: boolean
  lockedProjectId?: number
  projectId: number | ""
  setProjectId: (id: number | "") => void
  file: File | null
  setFile: (f: File | null) => void
  returnUrl?: string
  onReviewReadyChange: (ready: boolean) => void
}) {
  const [analyzing, setAnalyzing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [committed, setCommitted] = useState<CommitResponse | null>(null)
  const commitLockRef = useRef(false)
  const commitKeyRef = useRef(crypto.randomUUID())

  // 사용자 확정 입력
  const [sourceCrs, setSourceCrs] = useState<string>("")
  const [sourceCrsConfirmed, setSourceCrsConfirmed] = useState(false)
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string>>({})
  // Uploads opened from an existing project's management page are additions
  // to that project, so classify them as new/supplementary by default.
  const [isSupplementary, setIsSupplementary] = useState(Boolean(lockedProjectId))

  useEffect(() => {
    if (lockedProjectId) setIsSupplementary(true)
  }, [lockedProjectId])

  useEffect(() => {
    onReviewReadyChange(Boolean(preview))
  }, [preview, onReviewReadyChange])

  const effectiveProjectId = lockedProjectId ?? (projectId === "" ? undefined : projectId)
  // X/Y 평면좌표가 감지되면 CRS 확정이 필수
  const needsCrs =
    preview?.mapping.fmt !== "ambiguous" &&
    Object.values({ ...preview?.mapping.roles, ...roleOverrides }).some((r) => r === "x" || r === "y") &&
    !Object.values({ ...preview?.mapping.roles, ...roleOverrides }).includes("lon") &&
    !Object.values({ ...preview?.mapping.roles, ...roleOverrides }).includes("crs")

  function buildForm(): FormData {
    const fd = new FormData()
    fd.append("file", file as File)
    if (sourceCrs && sourceCrsConfirmed) fd.append("source_crs", sourceCrs)
    if (Object.keys(roleOverrides).length) fd.append("mapping", JSON.stringify(roleOverrides))
    return fd
  }

  async function analyze() {
    if (!file || !effectiveProjectId) return
    setAnalyzing(true)
    setError(null)
    setCommitted(null)
    commitKeyRef.current = crypto.randomUUID()
    try {
      const res = await apiPostForm<PreviewResponse>(
        `/api/v1/csv-ingestion/projects/${effectiveProjectId}/preview`,
        buildForm(),
      )
      setPreview(res)
      if (res.mapping.source_crs && !sourceCrs) setSourceCrs(res.mapping.source_crs)
    } catch (e) {
      setError(e instanceof Error ? e.message : "분석 실패")
    } finally {
      setAnalyzing(false)
    }
  }

  async function commit(editedRows?: PreviewRow[]) {
    if (!file || !effectiveProjectId || committed || commitLockRef.current) return
    if (needsCrs && !sourceCrs) {
      setError("평면좌표(X/Y)가 감지되었습니다. 좌표계(CRS)를 먼저 선택해 주세요.")
      return
    }
    commitLockRef.current = true
    setCommitting(true)
    setError(null)
    try {
      const fd = buildForm()
      fd.append("is_supplementary", String(isSupplementary))
      fd.append("idempotency_key", commitKeyRef.current)
      if (editedRows) fd.append("edited_rows", JSON.stringify(editedRows))
      const res = await apiPostForm<CommitResponse>(
        `/api/v1/csv-ingestion/projects/${effectiveProjectId}/commit`,
        fd,
      )
      setCommitted(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패")
    } finally {
      commitLockRef.current = false
      setCommitting(false)
    }
  }

  function setRole(header: string, role: string) {
    setRoleOverrides((prev) => ({ ...prev, [header]: role }))
  }

  // 현재 표시할 역할: override 우선, 없으면 추론값
  function currentRole(header: string): string {
    if (header in roleOverrides) return roleOverrides[header]
    if (preview && header in preview.mapping.roles) return preview.mapping.roles[header]
    if (preview?.mapping.stratum_columns.some((s) => s.header === header)) return "stratum"
    return "ignore"
  }

  const allHeaders = preview
    ? Array.from(
        new Set([
          ...preview.mapping.headers,
        ]),
      )
    : []

  const selectedProjectName =
    projects.find((project) => project.id === effectiveProjectId)?.name ?? ""
  const previewRows = useMemo<PreviewRow[]>(
    () =>
      (preview?.preview ?? []).flatMap((borehole, boreholeIndex) =>
        borehole.strata.map((stratum) => ({
          __sourceGroupKey: `csv-borehole-${boreholeIndex}`,
          "프로젝트명": borehole.project_name || selectedProjectName,
          "시추공명": borehole.name,
          "상심도": stratum.상심도,
          "하심도": stratum.하심도,
          "지층명": stratum.지층명,
          "표고": borehole.elevation ?? "",
          lon_wgs84: borehole.longitude ?? "",
          lat_wgs84: borehole.latitude ?? "",
          raw_x: borehole.raw_x ?? borehole.longitude ?? "",
          raw_y: borehole.raw_y ?? borehole.latitude ?? "",
          coordinate_order: "easting_northing",
          water_level_gl: borehole.water_level_gl ?? "",
          water_level_el: borehole.water_level_el ?? "",
          meta_crs: borehole.source_crs ?? "",
        })),
      ),
    [preview, selectedProjectName],
  )

  return (
    <div className="space-y-6">
      {/* 프로젝트 선택 */}
      {!lockedProjectId && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">프로젝트</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value === "" ? "" : Number(e.target.value))}
            disabled={loadingProjects}
            className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
          >
            <option value="">{loadingProjects ? "불러오는 중…" : "프로젝트 선택"}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            프로젝트 관리에서 생성한 프로젝트를 선택하면 추출 데이터가 해당 프로젝트에 적재됩니다.
          </p>
        </div>
      )}

      <DropZone
        accept=".csv,.tsv,.xlsx,.xlsm"
        file={file}
        onFile={(f) => {
          setFile(f)
          setPreview(null)
          setCommitted(null)
          setRoleOverrides({})
          setSourceCrs("")
          setSourceCrsConfirmed(false)
        }}
        hint="CSV · TSV · XLSX 시추공 표를 드롭하거나 클릭하여 선택"
      />

      <div className="flex items-center gap-3">
        <Button onClick={analyze} disabled={!file || !effectiveProjectId || analyzing}>
          {analyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
          분석
        </Button>
        {preview && (
          <span className="text-xs text-muted-foreground">
            {preview.summary.boreholes}개 시추공 · {preview.summary.strata}개 지층 (총 {preview.summary.rows_total}행)
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {preview && (
        <div className="grid items-start gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
          <div className="space-y-5 rounded-lg border border-border bg-card/40 p-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span>포맷 <b>{preview.mapping.fmt}</b></span>
              <span>신뢰도 <b>{Math.round(preview.mapping.confidence * 100)}%</b></span>
            </div>

            {preview.mapping.warnings.map((warning, index) => (
              <div
                key={index}
                className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{warning}</span>
              </div>
            ))}

            <div>
              <h3 className="mb-3 text-sm font-medium">컬럼 역할 확인</h3>
              <div className="space-y-2">
                {allHeaders.map((header) => (
                  <div key={header} className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-2">
                    <span className="truncate text-xs text-muted-foreground" title={header}>
                      {header || "(빈 헤더)"}
                    </span>
                    <select
                      value={currentRole(header)}
                      onChange={(event) => setRole(header, event.target.value)}
                      className="rounded border border-border bg-card px-2 py-1 text-xs"
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role.value} value={role.value}>{role.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={cn("text-sm font-medium", needsCrs && "text-amber-300")}>
                좌표계(CRS){needsCrs ? " — 반드시 확정" : ""}
              </label>
              <select
                value={sourceCrs}
                onChange={(event) => {
                  setSourceCrs(event.target.value)
                  setSourceCrsConfirmed(Boolean(event.target.value))
                }}
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
              >
                <option value="">{needsCrs ? "좌표계를 선택하세요" : "자동/위경도"}</option>
                {CRS_OPTIONS.map((crs) => (
                  <option key={crs.value} value={crs.value}>{crs.value} — {crs.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                역할이나 좌표계를 변경한 뒤 다시 분석하면 우측 미리보기에 반영됩니다.
              </p>
            </div>

            {preview.issues.length > 0 && (
              <ul className="max-h-32 space-y-0.5 overflow-auto text-xs text-amber-300">
                {preview.issues.map((issue, index) => <li key={index}>• {issue}</li>)}
              </ul>
            )}

            <Button className="w-full" onClick={analyze} disabled={analyzing || (needsCrs && !sourceCrs)}>
              {analyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              매핑 적용 · 다시 분석
            </Button>

            <label className="flex items-center gap-1.5 border-t border-border pt-4 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={isSupplementary}
                onChange={(event) => setIsSupplementary(event.target.checked)}
              />
              보완(신규) 시추공으로 등록
            </label>
          </div>

          <PreviewPanel
            key={`${preview.filename}-${preview.summary.boreholes}-${preview.summary.strata}-${sourceCrs}`}
            job={{
              id: 0,
              project_id: Number(effectiveProjectId),
              status: "awaiting_review",
              borehole_count: preview.summary.boreholes,
              result: {
                project_name: selectedProjectName,
                borehole_count: preview.summary.boreholes,
                stratum_count: preview.summary.strata,
                rows: previewRows,
              },
            }}
            saving={committing}
            onSave={(rows) => void commit(rows)}
          />
        </div>
      )}

      {committed && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>저장 완료 (job #{committed.job_id}).</p>
            <p className="text-xs">
              {Object.entries(committed.result)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
            </p>
            {returnUrl && (
              <a href={returnUrl} className="text-xs underline underline-offset-2">
                ← 시추 관리로 돌아가기
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
