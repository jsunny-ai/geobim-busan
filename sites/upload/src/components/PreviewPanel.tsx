import { useEffect, useState } from "react"
import { Loader2, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PreviewRow, ExtractionJob } from "../lib/types"
import { CRS_OPTIONS } from "../lib/constants"
import {
  projectNameFromRows,
  previewBoreholeName,
  convertPreviewCoordinates,
  rowsWithProjectName,
} from "../lib/helpers"
import { CoordinatePreviewMap } from "./CoordinatePreviewMap"

type EditablePreviewRow = PreviewRow & {
  __previewRowId: string
  __previewGroupId: string
}

function editableRows(rows: PreviewRow[]): EditablePreviewRow[] {
  let groupIndex = 0
  let previousName: string | null = null
  let previousSourceGroupKey: string | null = null
  return rows.map((row, index) => {
    const name = previewBoreholeName(row, index)
    const sourceGroupKey = row.__sourceGroupKey ? String(row.__sourceGroupKey) : null
    const startsNewGroup = sourceGroupKey
      ? sourceGroupKey !== previousSourceGroupKey
      : name !== previousName
    if (index === 0 || startsNewGroup) {
      groupIndex += 1
    }
    previousName = name
    previousSourceGroupKey = sourceGroupKey
    return {
      ...row,
      __previewRowId: `${index}-${name}`,
      __previewGroupId: `group-${groupIndex}`,
    }
  })
}

function cleanRows(rows: EditablePreviewRow[]): PreviewRow[] {
  return rows.map(({ __previewRowId, __previewGroupId, __sourceGroupKey, ...row }) => row)
}

export function PreviewPanel({
  job,
  saving,
  onSave,
}: {
  job: ExtractionJob
  saving: boolean
  onSave: (updatedRows: PreviewRow[]) => void
}) {
  const [editedRows, setEditedRows] = useState<EditablePreviewRow[]>(() => editableRows(job.result?.rows ?? []))
  const [projectName, setProjectName] = useState(
    () => projectNameFromRows(job.result?.rows ?? []) ?? job.result?.project_name ?? "",
  )
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  useEffect(() => {
    const rows = job.result?.rows ?? []
    setEditedRows(editableRows(rows))
    setProjectName(projectNameFromRows(rows) ?? job.result?.project_name ?? "")
    setSelectedGroupId(null)
  }, [job.id, job.result])

  const handleProjectNameChange = (value: string) => {
    setProjectName(value)
    setEditedRows((prev) => prev.map((row) => ({ ...row, "프로젝트명": value })))
  }

  const applyCoordinateConversion = (groupId: string, sourceRow: PreviewRow) => {
    void convertPreviewCoordinates(sourceRow)
      .then((converted) => {
        if (!converted) return
        setEditedRows((prev) =>
          prev.map((row) =>
            row.__previewGroupId === groupId
              ? {
                  ...row,
                  lon_wgs84: converted.lon_wgs84,
                  lat_wgs84: converted.lat_wgs84,
                  tm_x: converted.tm_x,
                  tm_y: converted.tm_y,
                  meta_crs: converted.meta_crs,
                }
              : row,
          ),
        )
      })
      .catch((err) => {
        console.warn("좌표 변환 API 호출 실패", err)
      })
  }

  const handleCellChange = (rowIndex: number, key: keyof PreviewRow, value: string) => {
    setSelectedGroupId(editedRows[rowIndex]?.__previewGroupId ?? null)
    const sourceRowForConversion = { ...(editedRows[rowIndex] ?? {}), [key]: value }
    setEditedRows((prev) => {
      const parsedValue = value
      const isBoreholeMetaField = [
        "시추공명",
        "lon_wgs84",
        "lat_wgs84",
        "표고",
        "water_level_gl",
        "water_level_el",
        "meta_crs",
      ].includes(String(key))
      let nextRows = [...prev]

      if (isBoreholeMetaField) {
        const targetGroupId = prev[rowIndex]?.__previewGroupId
        nextRows = prev.map((row, idx) => {
          if (row.__previewGroupId === targetGroupId || idx === rowIndex) {
            const updatedRow = { ...row, [key]: parsedValue }
            return updatedRow
          }
          return row
        })
      } else {
        nextRows = prev.map((row, idx) => {
          if (idx === rowIndex) {
            return { ...row, [key]: parsedValue }
          }
          return row
        })
      }

      const currentGroupId = nextRows[rowIndex]?.__previewGroupId

      if (key === "하심도") {
        if (rowIndex + 1 < nextRows.length && nextRows[rowIndex + 1].__previewGroupId === currentGroupId) {
          nextRows[rowIndex + 1] = {
            ...nextRows[rowIndex + 1],
            "상심도": parsedValue
          }
        }
      } else if (key === "상심도") {
        if (rowIndex - 1 >= 0 && nextRows[rowIndex - 1].__previewGroupId === currentGroupId) {
          nextRows[rowIndex - 1] = {
            ...nextRows[rowIndex - 1],
            "하심도": parsedValue
          }
        }
      }

      return nextRows
    })
    if (key === "meta_crs") {
      const groupId = editedRows[rowIndex]?.__previewGroupId
      if (groupId) {
        applyCoordinateConversion(groupId, sourceRowForConversion)
      }
    }
  }

  const previewRows = editedRows
  const saveRows = cleanRows(editedRows)

  return (
    <div className="space-y-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-sky-100">파싱 결과 확인</p>
          <p className="mt-1 text-xs text-sky-100/75">
            시추공 {job.result?.borehole_count ?? 0}개 · 지층 {job.result?.stratum_count ?? 0}개
          </p>
        </div>
        <Button
          className="gap-2"
          disabled={saving || editedRows.length === 0}
          onClick={() => onSave(rowsWithProjectName(saveRows, projectName))}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          저장
        </Button>
      </div>

      <div className="grid gap-3 rounded-md border border-sky-400/20 bg-background/60 p-3 text-xs sm:grid-cols-2">
        <div>
          <label htmlFor={`project-name-${job.id}`} className="text-muted-foreground">
            프로젝트명
          </label>
          <input
            id={`project-name-${job.id}`}
            type="text"
            value={projectName}
            placeholder="프로젝트명을 입력하세요"
            onChange={(event) => handleProjectNameChange(event.target.value)}
            className="mt-1 w-full rounded border border-transparent bg-transparent px-1 py-1 text-sm font-medium text-foreground outline-none transition-all duration-150 hover:border-input focus:border-sky-500 focus:bg-background/80"
          />
        </div>
        <div>
          <p className="text-muted-foreground">저장 방식</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {projectName.trim() ? "해당 프로젝트로 저장 예정" : "저장 전 확인 필요"}
          </p>
        </div>
      </div>

      <CoordinatePreviewMap
        rows={editedRows}
        selectedId={selectedGroupId}
        onSelectPoint={setSelectedGroupId}
      />

      <div className="max-h-[360px] overflow-auto rounded-md border border-sky-400/20 bg-background/60">
        <table className="w-full min-w-[1120px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[12%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[8%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              {["시추공", "상심도", "하심도", "지층", "경도", "위도", "지하수위 GL(m)", "지하수위 EL(m)", "표고", "좌표계"].map((header) => (
                <th key={header} className="border-b border-border px-3 py-2 font-medium whitespace-nowrap">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, index) => {
              const boreholeName = previewBoreholeName(row, index)
              const selected = selectedGroupId === row.__previewGroupId
              return (
                <tr
                  key={row.__previewRowId}
                  onClick={() => setSelectedGroupId(row.__previewGroupId)}
                  className={cn(
                    "border-b border-border/60 transition-colors",
                    selected && "bg-sky-500/10",
                  )}
                >
                  <td className="px-2 py-1 text-foreground">
                    <input
                      type="text"
                      value={row["시추공명"] ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "시추공명", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row["상심도"] ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "상심도", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row["하심도"] ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "하심도", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-foreground">
                    <input
                      type="text"
                      value={row["지층명"] ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "지층명", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row.lon_wgs84 ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "lon_wgs84", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row.lat_wgs84 ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "lat_wgs84", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row.water_level_gl ?? row["지하수위"] ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "water_level_gl", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row.water_level_el ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "water_level_el", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <input
                      type="text"
                      value={row["표고"] ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "표고", e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <select
                      value={row.meta_crs ?? ""}
                      onFocus={() => setSelectedGroupId(row.__previewGroupId)}
                      onChange={(e) => handleCellChange(index, "meta_crs", e.target.value)}
                      className="w-full bg-transparent pl-1 pr-8 py-0.5 border border-transparent hover:border-input focus:border-sky-500 focus:bg-background/80 rounded outline-none text-foreground transition-all duration-150"
                    >
                      <option value="" className="bg-slate-900 text-slate-100">선택 없음</option>
                      {CRS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value} className="bg-slate-900 text-slate-100">
                          {option.label} ({option.value})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {editedRows.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            표시할 파싱 결과가 없습니다.
          </div>
        )}
      </div>
    </div>
  )
}
