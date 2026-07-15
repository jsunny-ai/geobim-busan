import { useState, useEffect } from "react"
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { VIEWER_3D_URL } from "@shared/urls"
import type { Project, ExtractionJob, PreviewRow, JobStatus } from "../lib/types"
import { apiGet, apiPostForm, apiPostJson } from "../lib/api"
import { buttonLabel } from "../lib/helpers"
import { DropZone } from "./DropZone"
import { PreviewPanel } from "./PreviewPanel"

export function AutoParseTab({
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
  setFile: (file: File | null) => void
  returnUrl?: string
  onReviewReadyChange?: (ready: boolean) => void
}) {
  const [job, setJob] = useState<ExtractionJob | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!job || !["pending", "running"].includes(job.status)) return
    const timer = window.setInterval(async () => {
      try {
        const next = await apiGet<ExtractionJob>(`/api/v1/pdf-extraction/jobs/${job.id}`)
        setJob(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : "작업 상태를 확인하지 못했습니다.")
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [job])

  async function handleStart() {
    if (!file || projectId === "") return
    setSubmitting(true)
    setError(null)
    setJob(null)

    try {
      const form = new FormData()
      form.append("project_id", String(projectId))
      form.append("pdf_file", file)
      if (lockedProjectId) form.append("is_supplementary", "true")
      const created = await apiPostForm<{ job_id: number; project_id: number; status: JobStatus }>(
        "/api/v1/pdf-extraction/upload",
        form,
      )
      setJob({ id: created.job_id, project_id: created.project_id, status: created.status, borehole_count: 0 })
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드를 시작하지 못했습니다.")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleApprove(updatedRows: PreviewRow[]) {
    if (!job) return
    setSaving(true)
    setError(null)
    try {
      const saved = await apiPostJson<ExtractionJob>(`/api/v1/pdf-extraction/jobs/${job.id}/approve`, { rows: updatedRows })
      setJob(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.")
    } finally {
      setSaving(false)
    }
  }

  const busy = submitting || job?.status === "pending" || job?.status === "running"
  const reviewReady = job?.status === "awaiting_review"
  const complete = job?.status === "approved"

  useEffect(() => {
    onReviewReadyChange?.(reviewReady)
  }, [reviewReady, onReviewReadyChange])

  return (
    <div className={cn("space-y-5", reviewReady && "grid gap-6 lg:grid-cols-[420px_1fr] lg:space-y-0")}>
      <div className="space-y-5">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-foreground">저장 프로젝트</span>
          <select
            value={projectId}
            disabled={loadingProjects || busy || !!lockedProjectId}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            <option value="">
              {loadingProjects ? "프로젝트 불러오는 중" : "프로젝트를 선택하세요"}
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {lockedProjectId && (
            <p className="text-xs text-sky-300 mt-1">
              ✓ 프로젝트가 고정되어 있습니다. 저장 후 시추 관리 탭으로 돌아가세요.
            </p>
          )}
        </label>

        <DropZone
          accept=".pdf,.docx,.hwpx"
          file={file}
          onFile={(f) => {
            setFile(f)
            setJob(null)
            setError(null)
          }}
          hint="PDF, DOCX, HWPX 지원"
        />

        <Button className="w-full gap-2" disabled={!file || projectId === "" || busy} onClick={handleStart}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
          {buttonLabel({ busy, file, projectId })}
        </Button>

        {complete && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              저장 완료
            </div>
            <p className="mt-1 text-xs text-emerald-200/80">
              {job.result?.project_name ? `${job.result.project_name}에 ` : ""}
              시추공 {job.borehole_count || job.result?.borehole_count || 0}개,
              지층 {job.result?.stratum_count || 0}개가 저장되었습니다.
            </p>
            <div className="mt-3 flex gap-3">
              {returnUrl ? (
                <a
                  href={returnUrl}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                >
                  ← 시추 관리로 돌아가기
                </a>
              ) : (
                <a
                  href={VIEWER_3D_URL}
                  className="text-xs font-medium text-emerald-100 underline-offset-4 hover:underline"
                >
                  3D 뷰어에서 확인
                </a>
              )}
            </div>
          </div>
        )}

        {(error || job?.status === "failed") && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              파싱 실패
            </div>
            <p className="mt-1 text-xs text-red-200/80">{error || job?.error}</p>
          </div>
        )}
      </div>

      {reviewReady && (
        <div className="min-w-0">
          <PreviewPanel key={job.id} job={job} saving={saving} onSave={handleApprove} />
        </div>
      )}
    </div>
  )
}
