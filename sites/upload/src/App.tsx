import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import type { Project, Tab } from "./lib/types"
import { TABS } from "./lib/constants"
import { apiGet, apiPostJson } from "./lib/api"
import { NavBar } from "./components/NavBar"
import { AutoParseTab } from "./components/AutoParseTab"
import { ManualParseTab } from "./components/ManualParseTab"
import { CsvParseTab } from "./components/CsvParseTab"

export default function App() {
  const [tab, setTab] = useState<Tab>("auto")
  const [projects, setProjects] = useState<Project[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [autoReviewReady, setAutoReviewReady] = useState(false)
  const [manualReviewReady, setManualReviewReady] = useState(false)
  const [csvReviewReady, setCsvReviewReady] = useState(false)

  // URL 파라미터: project_id (잠금), return_url (완료 후 복귀)
  const urlParams = new URLSearchParams(window.location.search)
  const lockedProjectId = urlParams.get("project_id") ? Number(urlParams.get("project_id")) : undefined
  const returnUrl = urlParams.get("return_url") ?? undefined

  const [projectId, setProjectId] = useState<number | "">(lockedProjectId ?? "")
  const [file, setFile] = useState<File | null>(null)
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectDescription, setNewProjectDescription] = useState("")
  const [creatingProject, setCreatingProject] = useState(false)

  useEffect(() => {
    if (lockedProjectId) {
      setProjects([{ id: lockedProjectId, name: `Project #${lockedProjectId}` }])
      setLoadingProjects(false)
      setProjectError(null)
      return
    }

    let mounted = true
    apiGet<Project[]>("/api/v1/projects/")
      .then((data) => {
        if (mounted) setProjects(data)
      })
      .catch((err) => {
        if (mounted) {
          console.warn("프로젝트 목록을 불러오지 못했습니다.", err)
          setProjects([])
          setProjectError(err instanceof Error ? err.message : "프로젝트 목록을 불러오지 못했습니다.")
        }
      })
      .finally(() => {
        if (mounted) setLoadingProjects(false)
      })
    return () => {
      mounted = false
    }
  }, [lockedProjectId])

  async function createProject(event: React.FormEvent) {
    event.preventDefault()
    const name = newProjectName.trim()
    if (!name) return
    setCreatingProject(true)
    setProjectError(null)
    try {
      const created = await apiPostJson<Project>("/api/v1/projects/", {
        name,
        description: newProjectDescription.trim() || null,
        region: null,
        source_crs: null,
        bbox: null,
        creation_source: "upload_ui",
      })
      setProjects((current) => [created, ...current.filter((project) => project.id !== created.id)])
      setProjectId(created.id)
      setNewProjectName("")
      setNewProjectDescription("")
      setShowCreateProject(false)
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "프로젝트를 생성하지 못했습니다.")
    } finally {
      setCreatingProject(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar />

      {/* 프로젝트 연동 배너 */}
      {lockedProjectId && (
        <div className="border-b border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-200 flex items-center justify-between">
          <span>
            시추 관리에서 연동됨 — 저장된 데이터는 해당 프로젝트에 자동 반영됩니다.
          </span>
          {returnUrl && (
            <a
              href={returnUrl}
              className="text-xs text-sky-100 hover:underline underline-offset-2"
            >
              ← 시추 관리로 돌아가기
            </a>
          )}
        </div>
      )}

      <main className={cn("mx-auto space-y-6 px-4 py-8", (tab === "auto" && autoReviewReady) || (tab === "manual" && manualReviewReady) || (tab === "csv" && csvReviewReady) ? "max-w-[1600px]" : "max-w-2xl")}>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">데이터 업로드</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            시추 주상도 문서(PDF) 또는 시추공 표(CSV/엑셀)를 업로드하여 지층 데이터를 추출합니다.
          </p>
        </div>

        <div className="flex rounded-lg border border-border bg-card/40 p-1">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={cn(
                "flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                tab === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {projectError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {projectError}
          </div>
        )}

        {!lockedProjectId && (
          <section className="rounded-lg border border-border bg-card/40 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">저장 프로젝트</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  PDF/CSV는 사용자가 선택한 프로젝트에만 저장됩니다.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateProject((value) => !value)}
                className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-card"
              >
                {showCreateProject ? "취소" : "새 프로젝트 생성"}
              </button>
            </div>
            {showCreateProject && (
              <form onSubmit={createProject} className="mt-4 grid gap-3">
                <input
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  placeholder="프로젝트 이름"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  required
                />
                <textarea
                  value={newProjectDescription}
                  onChange={(event) => setNewProjectDescription(event.target.value)}
                  placeholder="설명 (선택)"
                  className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={creatingProject || !newProjectName.trim()}
                  className="h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {creatingProject ? "생성 중..." : "프로젝트 생성 후 선택"}
                </button>
              </form>
            )}
          </section>
        )}

        {tab === "auto" && (
          <AutoParseTab
            projects={projects}
            loadingProjects={loadingProjects}
            lockedProjectId={lockedProjectId}
            projectId={projectId}
            setProjectId={setProjectId}
            file={file}
            setFile={setFile}
            returnUrl={returnUrl}
            onReviewReadyChange={setAutoReviewReady}
          />
        )}
        {tab === "manual" && (
          <ManualParseTab
            projects={projects}
            loadingProjects={loadingProjects}
            lockedProjectId={lockedProjectId}
            projectId={projectId}
            setProjectId={setProjectId}
            file={file}
            setFile={setFile}
            returnUrl={returnUrl}
            onReviewReadyChange={setManualReviewReady}
          />
        )}
        {tab === "csv" && (
          <CsvParseTab
            projects={projects}
            loadingProjects={loadingProjects}
            lockedProjectId={lockedProjectId}
            projectId={projectId}
            setProjectId={setProjectId}
            file={file}
            setFile={setFile}
            returnUrl={returnUrl}
            onReviewReadyChange={setCsvReviewReady}
          />
        )}
      </main>
    </div>
  )
}
