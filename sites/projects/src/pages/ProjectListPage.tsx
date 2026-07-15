import { useState } from "react"
import { Building2, FileText, Layers, Map, MapPin, Pencil, Plus, Trash2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import Navbar from "@/components/Navbar"
import { useProjects } from "@/features/projects/hooks"
import { api } from "@/lib/api"
import type { Project } from "@/lib/types"
import { API_URL, VIEWER_3D_URL, MAP_URL } from "@shared/urls"

function fallbackBoreholeCount(project: Project) {
  return project.borehole_count
}

function ProjectBoreholeCount({ project }: { project: Project }) {
  const count = fallbackBoreholeCount(project)

  return <>시추공 {count}개</>
}

function ProjectCard({
  project,
  onEdit,
  onDelete,
}: {
  project: Project
  onEdit: (e: React.MouseEvent, project: Project) => void
  onDelete: (e: React.MouseEvent, id: number, name: string) => void
}) {
  return (
    <Card className="flex flex-col h-full border-border/60 hover:border-border transition-colors hover:shadow-md bg-card">
      <CardHeader className="pb-3 flex-1">
        <div className="flex items-start gap-2">
          <CardTitle className="min-w-0 flex-1 text-sm font-medium leading-snug line-clamp-2">
            {project.name}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={(e) => onEdit(e, project)}
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors p-1 relative z-10"
            title="프로젝트 이름 변경"
          >
            <Pencil className="h-4 w-4 pointer-events-none" />
          </button>
          <button
            onClick={(e) => onDelete(e, project.id, project.name)}
            type="button"
            className="text-muted-foreground hover:text-destructive transition-colors p-1 relative z-10"
            title="프로젝트 삭제"
          >
            <Trash2 className="h-4 w-4 pointer-events-none" />
          </button>
          </div>
        </div>
        {project.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {project.description}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        <div className="flex flex-col gap-1.5">
          {project.region && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {project.region}
            </div>
          )}
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Building2 className="h-3 w-3" />
            <ProjectBoreholeCount project={project} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5 mt-2 pt-3 border-t border-border/40">
          <a
            href={`${VIEWER_3D_URL}/?projectId=${project.id}`}
            className="flex flex-col items-center justify-center gap-1 py-1.5 rounded bg-stone-200 hover:bg-stone-300 text-stone-800 border border-stone-300 transition-all text-[10px] font-semibold"
          >
            <Layers className="h-3.5 w-3.5" />
            3D 분석
          </a>
          <a
            href={`${MAP_URL}/?project_id=${project.id}`}
            className="flex flex-col items-center justify-center gap-1 py-1.5 rounded bg-stone-200 hover:bg-stone-300 text-stone-800 border border-stone-300 transition-all text-[10px] font-semibold"
          >
            <Map className="h-3.5 w-3.5" />
            2D 지도
          </a>
          <a
            href={`/detail/${project.id}`}
            className="flex flex-col items-center justify-center gap-1 py-1.5 rounded bg-stone-200 hover:bg-stone-300 text-stone-700 border border-stone-300 transition-all text-[10px] font-semibold"
          >
            <FileText className="h-3.5 w-3.5" />
            시추 관리
          </a>
        </div>
      </CardContent>
    </Card>
  )
}

export default function ProjectListPage() {
  const { data: projects, isLoading, error, refetch } = useProjects()
  const queryClient = useQueryClient()

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectDesc, setNewProjectDesc] = useState("")
  const [createLoading, setCreateLoading] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [editProjectName, setEditProjectName] = useState("")
  const [editProjectDesc, setEditProjectDesc] = useState("")
  const [editLoading, setEditLoading] = useState(false)

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newProjectName.trim()) {
      alert("프로젝트 이름을 입력해주세요.")
      return
    }

    setCreateLoading(true)
    try {
      await api.post("/projects/", {
        name: newProjectName.trim(),
        description: newProjectDesc.trim(),
        region: "선택 영역",
        source_crs: "EPSG:4326",
        creation_source: "projects_ui",
        lifecycle_status: "active",
        bbox: {
          bbox: [127.02, 37.24, 127.03, 37.25],
          polygon: [
            { lng: 127.02, lat: 37.24 },
            { lng: 127.03, lat: 37.24 },
            { lng: 127.03, lat: 37.25 },
            { lng: 127.02, lat: 37.25 },
          ],
          borehole_ids: [],
        },
      })
      alert("프로젝트가 성공적으로 생성되었습니다.")
      setIsCreateModalOpen(false)
      setNewProjectName("")
      setNewProjectDesc("")
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["boreholes"] })
    } catch (err: any) {
      alert("생성 중 오류가 발생했습니다: " + (err.response?.data?.detail || err.message))
    } finally {
      setCreateLoading(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: number, name: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(`프로젝트 '${name}'를 삭제하시겠습니까?`)) return

    try {
      await api.delete(`/projects/${id}`)
      alert("프로젝트가 삭제되었습니다.")
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["boreholes"] })
    } catch (err: any) {
      alert("삭제 중 오류가 발생했습니다: " + (err.response?.data?.detail || err.message))
    }
  }

  const handleOpenEdit = (e: React.MouseEvent, project: Project) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingProject(project)
    setEditProjectName(project.name)
    setEditProjectDesc(project.description ?? "")
  }

  const handleCloseEdit = () => {
    setEditingProject(null)
    setEditProjectName("")
    setEditProjectDesc("")
  }

  const handleUpdateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingProject) return
    if (!editProjectName.trim()) {
      alert("프로젝트 이름을 입력해주세요.")
      return
    }

    setEditLoading(true)
    try {
      await api.put(`/projects/${editingProject.id}`, {
        name: editProjectName.trim(),
        description: editProjectDesc.trim(),
        region: editingProject.region,
        source_crs: editingProject.source_crs,
        bbox: editingProject.bbox ?? null,
      })
      alert("프로젝트 이름이 변경되었습니다.")
      handleCloseEdit()
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["project", editingProject.id] })
    } catch (err: any) {
      alert("수정 중 오류가 발생했습니다: " + (err.response?.data?.detail || err.message))
    } finally {
      setEditLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <Navbar active="projects" />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-xl font-semibold">프로젝트 목록</h1>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            type="button"
            className="inline-flex items-center gap-1.5 justify-center rounded-md text-xs font-semibold bg-stone-300 hover:bg-stone-400 text-stone-800 h-9 px-4 py-2 shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4" />
            새 프로젝트
          </button>
        </div>

        {isLoading && <div className="text-sm text-muted-foreground">로딩 중...</div>}
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            <p className="font-semibold">프로젝트 DB 연결에 실패했습니다.</p>
            <p className="mt-1 text-xs">
              오래된 예제 데이터로 대체하지 않습니다. API 주소: {API_URL}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-3 rounded border border-destructive/40 px-3 py-1.5 text-xs font-semibold hover:bg-destructive/10"
            >
              다시 연결
            </button>
          </div>
        )}

        {projects && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onEdit={handleOpenEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </main>

      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h3 className="text-base font-semibold text-foreground mb-4">새 프로젝트 생성</h3>

            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground font-medium mb-1.5">
                  프로젝트 이름 <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="예: 서울시 서초구 지반 조사"
                  className="w-full h-9 rounded-md border border-input bg-background/50 px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div>
                <label className="block text-xs text-muted-foreground font-medium mb-1.5">
                  설명
                </label>
                <textarea
                  value={newProjectDesc}
                  onChange={(e) => setNewProjectDesc(e.target.value)}
                  placeholder="프로젝트 상세 설명 또는 특이사항을 적어주세요."
                  rows={3}
                  className="w-full rounded-md border border-input bg-background/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateModalOpen(false)
                    setNewProjectName("")
                    setNewProjectDesc("")
                  }}
                  className="inline-flex items-center justify-center rounded-md text-xs font-semibold border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2 transition-colors"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="inline-flex items-center justify-center rounded-md text-xs font-semibold bg-stone-300 hover:bg-stone-400 text-stone-800 h-9 px-4 py-2 transition-colors disabled:opacity-50"
                >
                  {createLoading ? "생성 중..." : "프로젝트 생성"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h3 className="text-base font-semibold text-foreground mb-4">프로젝트 이름 변경</h3>

            <form onSubmit={handleUpdateProject} className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground font-medium mb-1.5">
                  프로젝트 이름 <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={editProjectName}
                  onChange={(e) => setEditProjectName(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background/50 px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div>
                <label className="block text-xs text-muted-foreground font-medium mb-1.5">
                  설명
                </label>
                <textarea
                  value={editProjectDesc}
                  onChange={(e) => setEditProjectDesc(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleCloseEdit}
                  className="inline-flex items-center justify-center rounded-md text-xs font-semibold border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2 transition-colors"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={editLoading}
                  className="inline-flex items-center justify-center rounded-md text-xs font-semibold bg-stone-300 hover:bg-stone-400 text-stone-800 h-9 px-4 py-2 transition-colors disabled:opacity-50"
                >
                  {editLoading ? "저장 중..." : "저장"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
