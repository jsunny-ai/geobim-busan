import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { MOCK_BOREHOLES } from "@/lib/mock"
import type { Borehole, Project, Stratum } from "@/lib/types"

function selectedBoreholeIds(project?: Project | null): number[] {
  const ids = project?.bbox?.borehole_ids
  return Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : []
}

function mergeBoreholes(...groups: Borehole[][]): Borehole[] {
  const byId = new Map<number, Borehole>()
  for (const group of groups) {
    for (const borehole of group) byId.set(Number(borehole.id), borehole)
  }
  return Array.from(byId.values())
}

async function fetchProjectOwnedBoreholes(projectId: number): Promise<Borehole[]> {
  try {
    const res = await api.get<{ boreholes: Borehole[] }>(`/boreholes?project_id=${projectId}&include_strata=true`)
    return res.data.boreholes
  } catch {
    return MOCK_BOREHOLES[projectId] ?? []
  }
}

async function fetchSelectedAreaBoreholes(project: Project): Promise<Borehole[]> {
  const ids = selectedBoreholeIds(project)
  if (ids.length === 0) return []

  const res = await api.get<{ boreholes: Borehole[] }>(
    `/boreholes?ids=${ids.join(",")}&include_strata=true&limit=${ids.length}`,
  )
  const order = new Map(ids.map((id, index) => [id, index]))
  return res.data.boreholes.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0))
}

async function fetchBoreholes(projectId: number, project?: Project | null): Promise<Borehole[]> {
  if (project) {
    try {
      const res = await api.get<{ boreholes: Borehole[] }>(`/projects/${projectId}/boreholes/effective`)
      return res.data.boreholes
    } catch {
      // Fallback to the older split query flow below.
    }
  }

  const owned = await fetchProjectOwnedBoreholes(projectId)
  if (!project || selectedBoreholeIds(project).length === 0) return owned

  try {
    const selected = await fetchSelectedAreaBoreholes(project)
    return mergeBoreholes(selected, owned)
  } catch {
    return owned
  }
}

async function fetchBorehole(id: number): Promise<Borehole> {
  try {
    const res = await api.get<Borehole>(`/boreholes/${id}`)
    return res.data
  } catch {
    for (const list of Object.values(MOCK_BOREHOLES)) {
      const found = list.find((b) => b.id === id)
      if (found) return found
    }
    throw new Error("시추공을 찾을 수 없습니다.")
  }
}

export function useBoreholes(projectId: number, project?: Project | null) {
  const selectedIds = selectedBoreholeIds(project).join(",")
  return useQuery({
    queryKey: ["boreholes", projectId, selectedIds],
    queryFn: () => fetchBoreholes(projectId, project),
    enabled: !!projectId,
  })
}

export function useBorehole(id: number) {
  return useQuery({
    queryKey: ["borehole", id],
    queryFn: () => fetchBorehole(id),
    enabled: !!id,
  })
}

// ── 수동 시추공 생성 ──────────────────────────────────────────────

interface StratumInput {
  depth_top: number
  depth_bottom: number
  soil_type: string
  raw_text?: string
  n_value?: number
  uscs_code?: string
}

interface CreateBoreholePayload {
  project_id: number
  name: string
  latitude: number
  longitude: number
  elevation?: number
  source_crs?: string
  is_supplementary?: boolean
  strata: StratumInput[]
}

export function useCreateBorehole(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateBoreholePayload) => {
      const res = await api.post("/boreholes/", payload)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["boreholes", projectId] })
      qc.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

// ── 시추공 수정 ──────────────────────────────────────────────────

interface UpdateBoreholePayload {
  longitude?: number
  latitude?: number
  elevation?: number
  strata?: Omit<Stratum, "id">[]
}

export function useUpdateBorehole(id: number, projectId: number, isSupplementary: boolean) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: UpdateBoreholePayload) => {
      const { strata, ...coords } = payload
      const coordinatePayload: Pick<UpdateBoreholePayload, "longitude" | "latitude"> = {}
      if (coords.longitude !== undefined) coordinatePayload.longitude = coords.longitude
      if (coords.latitude !== undefined) coordinatePayload.latitude = coords.latitude

      if (Object.keys(coordinatePayload).length > 0) {
        await api.patch(`/boreholes/${id}`, coordinatePayload)
      }

      if (coords.elevation !== undefined || strata !== undefined) {
        await api.post(`/boreholes/${id}/revisions`, {
          elevation: coords.elevation,
          strata,
          reason: isSupplementary
            ? "시추데이터 관리 뷰어에서 신규 시추공 데이터 수정"
            : "시추데이터 관리 뷰어에서 기존 시추공 데이터 전역 수정",
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["borehole", id] })
      qc.invalidateQueries({ queryKey: ["boreholes"] })
    },
  })
}
