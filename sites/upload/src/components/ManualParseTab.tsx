import { useState, useEffect, useRef } from "react"
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  Project,
  ManualUpload,
  ExtractionJob,
  ManualBox,
  PageMode,
  ManualTemplate,
  ManualLabel,
  PreviewRow,
} from "../lib/types"
import {
  API_BASE,
  PAGE_MODES,
  MANUAL_TEMPLATES,
  MANUAL_LABELS,
} from "../lib/constants"
import {
  clamp,
  normalizedRect,
  boxStyle,
  labelText,
  templateText,
  hasBox,
} from "../lib/helpers"
import { apiPostForm, apiPostJson } from "../lib/api"
import { DropZone } from "./DropZone"
import { PreviewPanel } from "./PreviewPanel"

export function ManualParseTab({
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
  const imageRef = useRef<HTMLImageElement>(null)
  const [manualJob, setManualJob] = useState<ManualUpload | null>(null)
  const [job, setJob] = useState<ExtractionJob | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [boxes, setBoxes] = useState<ManualBox[]>([])
  const [pageMode, setPageMode] = useState<PageMode>("split")
  const [activeTemplate, setActiveTemplate] = useState<ManualTemplate>("first")
  const [activeLabel, setActiveLabel] = useState<ManualLabel>("depth")
  const [draftBox, setDraftBox] = useState<ManualBox | null>(null)
  const [drawingStart, setDrawingStart] = useState<[number, number] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleFile(f: File) {
    setFile(f)
    setManualJob(null)
    setJob(null)
    setPageNumber(1)
    setBoxes([])
    setError(null)
  }

  async function handleUpload() {
    if (!file || projectId === "") return
    setSubmitting(true)
    setError(null)
    try {
      const form = new FormData()
      form.append("project_id", String(projectId))
      form.append("pdf_file", file)
      if (lockedProjectId) form.append("is_supplementary", "true")
      const created = await apiPostForm<ManualUpload>("/api/v1/pdf-extraction/manual/upload", form)
      setManualJob(created)
      setPageNumber(1)
      setBoxes([])
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드하지 못했습니다.")
    } finally {
      setSubmitting(false)
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!imageRef.current) return
    const rect = imageRef.current.getBoundingClientRect()
    const x = clamp((event.clientX - rect.left) / rect.width)
    const y = clamp((event.clientY - rect.top) / rect.height)
    setDrawingStart([x, y])
    setDraftBox({
      id: "draft",
      label: activeLabel,
      template: activeTemplate,
      page: pageNumber,
      rect: [x, y, x, y],
    })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drawingStart || !draftBox || !imageRef.current) return
    const rect = imageRef.current.getBoundingClientRect()
    const x = clamp((event.clientX - rect.left) / rect.width)
    const y = clamp((event.clientY - rect.top) / rect.height)
    const point: [number, number] = [x, y]
    setDraftBox({
      ...draftBox,
      rect: normalizedRect(drawingStart, point),
    })
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!draftBox) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    const [x0, y0, x1, y1] = draftBox.rect
    if (Math.abs(x1 - x0) > 0.01 && Math.abs(y1 - y0) > 0.01) {
      setBoxes((current) => [
        ...current,
        {
          ...draftBox,
          id: crypto.randomUUID(),
        },
      ])
    }
    setDrawingStart(null)
    setDraftBox(null)
  }

  async function handleExtract() {
    if (!manualJob) return
    setExtracting(true)
    setError(null)
    try {
      const next = await apiPostJson<ExtractionJob>(
        `/api/v1/pdf-extraction/jobs/${manualJob.job_id}/extract-boxes`,
        {
          box_definitions: {
            mode: "auto_borehole_pages",
            page_mode: pageMode,
            first_page_detector: "borehole_name",
            boxes: boxes.filter((box) => pageMode === "split" || box.template === "first"),
          },
        },
      )
      setJob(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "박스 영역을 추출하지 못했습니다.")
    } finally {
      setExtracting(false)
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

  const pageBoxes = boxes.filter((box) => box.page === pageNumber && box.template === activeTemplate)
  const firstBoxes = boxes.filter((box) => box.template === "first")
  const continuationBoxes = boxes.filter((box) => box.template === "continuation")
  const requiredReady = pageMode === "same"
    ? hasBox(firstBoxes, "borehole_name") && hasBox(firstBoxes, "depth") && hasBox(firstBoxes, "stratum_name")
    : hasBox(firstBoxes, "borehole_name") &&
      hasBox(firstBoxes, "depth") &&
      hasBox(firstBoxes, "stratum_name") &&
      hasBox(continuationBoxes, "depth") &&
      hasBox(continuationBoxes, "stratum_name")
  const pageImage = manualJob
    ? `${API_BASE}/api/v1/pdf-extraction/jobs/${manualJob.job_id}/pages/${pageNumber}.png`
    : null

  const reviewReady = job?.status === "awaiting_review"
  const wideLayout = Boolean(manualJob) || reviewReady

  useEffect(() => {
    onReviewReadyChange?.(wideLayout)
  }, [wideLayout, onReviewReadyChange])

  return (
    <div className={cn("space-y-5", reviewReady && "grid gap-6 lg:grid-cols-[420px_1fr] lg:space-y-0")}>
      <div className="space-y-5">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-foreground">저장 프로젝트</span>
          <select
            value={projectId}
            disabled={loadingProjects || submitting || Boolean(manualJob) || !!lockedProjectId}
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

        <DropZone accept=".pdf" file={file} onFile={handleFile} hint="PDF 파일만 지원" />

        {file && !file.name.toLowerCase().endsWith(".pdf") && (
          <p className="text-xs text-red-400 mt-1">
            ⚠ 직접 지정 파싱은 PDF 파일만 지원합니다.
          </p>
        )}

        <Button
          className="w-full gap-2"
          disabled={!file || projectId === "" || !file.name.toLowerCase().endsWith(".pdf") || submitting || Boolean(manualJob)}
          onClick={handleUpload}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
          직접 지정 시작
        </Button>

        {manualJob && pageImage && (
          <div className={cn("grid gap-4", reviewReady ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_260px]")}>
            <div className="overflow-hidden rounded-lg border border-border bg-card/40">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pageNumber <= 1}
                    onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
                  >
                    이전
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {pageNumber} / {manualJob.page_count}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pageNumber >= manualJob.page_count}
                    onClick={() => setPageNumber((value) => Math.min(manualJob.page_count, value + 1))}
                  >
                    다음
                  </Button>
                </div>
                <span className="text-xs font-medium text-sky-200">
                  {labelText(activeLabel)}
                </span>
              </div>

              <div
                className="relative max-h-[720px] touch-none overflow-auto bg-slate-950"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                <div className="relative mx-auto w-fit">
                  <img
                    ref={imageRef}
                    src={pageImage}
                    alt="PDF 페이지"
                    draggable={false}
                    className="block max-w-full select-none"
                  />
                  {[...pageBoxes, ...(draftBox && draftBox.page === pageNumber ? [draftBox] : [])].map((box) => (
                    <div
                      key={box.id}
                      className={cn(
                        "pointer-events-none absolute border-2 bg-sky-400/20",
                        box.id === "draft" ? "border-amber-300" : "border-sky-300",
                      )}
                      style={boxStyle(box.rect)}
                    >
                      <span className="absolute left-0 top-0 max-w-full truncate bg-sky-950/90 px-1.5 py-0.5 text-[11px] font-medium text-sky-100">
                        {labelText(box.label)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
              <label className="block space-y-2">
                <span className="text-xs font-medium text-muted-foreground">페이지 처리 방식</span>
                <select
                  value={pageMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as PageMode
                    setPageMode(nextMode)
                    if (nextMode === "same") setActiveTemplate("first")
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                >
                  {PAGE_MODES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-1">
                {MANUAL_TEMPLATES.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => setActiveTemplate(item.value)}
                    disabled={pageMode === "same" && item.value === "continuation"}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-medium transition-colors",
                      activeTemplate === item.value
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                      pageMode === "same" && item.value === "continuation" && "cursor-not-allowed opacity-40",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <label className="block space-y-2">
                <span className="text-xs font-medium text-muted-foreground">박스 라벨</span>
                <select
                  value={activeLabel}
                  onChange={(event) => setActiveLabel(event.target.value as ManualLabel)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                >
                  {MANUAL_LABELS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="max-h-[260px] space-y-2 overflow-auto">
                {boxes.map((box) => (
                  <div
                    key={box.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/70 px-2 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{labelText(box.label)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {templateText(box.template)} · 페이지 {box.page}
                      </p>
                    </div>
                    <button
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => setBoxes((current) => current.filter((item) => item.id !== box.id))}
                      title="삭제"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {boxes.length === 0 && (
                  <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                    지정된 박스가 없습니다.
                  </div>
                )}
              </div>

              <Button className="w-full gap-2" disabled={!requiredReady || extracting} onClick={handleExtract}>
                {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                박스 영역 추출
              </Button>
            </div>
          </div>
        )}

        {job?.status === "approved" && (
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
            {returnUrl && (
              <div className="mt-3">
                <a
                  href={returnUrl}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                >
                  ← 시추 관리로 돌아가기
                </a>
              </div>
            )}
          </div>
        )}

        {(error || job?.status === "failed") && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              직접 지정 실패
            </div>
            <p className="mt-1 text-xs text-red-200/80">{error || job?.error}</p>
          </div>
        )}
      </div>

      {reviewReady && (
        <div className="min-w-0 lg:max-h-[850px] lg:overflow-y-auto">
          <PreviewPanel key={job.id} job={job} saving={saving} onSave={handleApprove} />
        </div>
      )}
    </div>
  )
}
