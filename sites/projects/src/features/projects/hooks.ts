import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Project } from "@/lib/types"

async function fetchProjects(): Promise<Project[]> {
  const res = await api.get<Project[]>("/projects")
  return res.data
}

async function fetchProject(id: number): Promise<Project> {
  const res = await api.get<Project>(`/projects/${id}`)
  return res.data
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    retry: 1,
    refetchOnMount: "always",
  })
}

export function useProject(id: number) {
  return useQuery({
    queryKey: ["projects", id],
    queryFn: () => fetchProject(id),
    enabled: !!id,
  })
}
