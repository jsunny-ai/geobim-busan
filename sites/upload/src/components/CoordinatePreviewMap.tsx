import { useState, useRef, useEffect } from "react"
import { MapPin } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PreviewRow, PreviewPoint } from "../lib/types"
import {
  uniquePreviewPoints,
  averagePoint,
  lonLatToWorld,
  worldToLonLat,
} from "../lib/helpers"

export function CoordinatePreviewMap({
  rows,
  selectedId,
  onSelectPoint,
}: {
  rows: PreviewRow[]
  selectedId: string | null
  onSelectPoint: (id: string) => void
}) {
  const points = uniquePreviewPoints(rows)
  const [mapCenter, setMapCenter] = useState<PreviewPoint | null>(null)
  const [zoom, setZoom] = useState(14)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    centerWorld: { x: number; y: number }
  } | null>(null)

  const selectedPoint = selectedId ? points.find((point) => point.id === selectedId) ?? null : null

  // 시추공 그룹 선택 또는 CRS 변환으로 좌표가 바뀌면 해당 위치로 재중심한다.
  useEffect(() => {
    if (selectedPoint) {
      setMapCenter(selectedPoint)
    }
  }, [selectedId, selectedPoint?.lon, selectedPoint?.lat])

  if (points.length === 0) {
    return (
      <div className="rounded-md border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100">
        좌표 위치 미리보기를 표시할 수 없습니다. 기준좌표계 또는 좌표값을 확인한 뒤 다시 파싱해 주세요.
      </div>
    )
  }

  const center = mapCenter ?? selectedPoint ?? averagePoint(points)
  const centerWorld = lonLatToWorld(center.lon, center.lat, zoom)
  const mapPlaneSize = 1280
  const mapCenterPx = mapPlaneSize / 2
  const tileX = Math.floor(centerWorld.x / 256)
  const tileY = Math.floor(centerWorld.y / 256)
  const offsetX = centerWorld.x - tileX * 256
  const offsetY = centerWorld.y - tileY * 256
  const tiles = [-2, -1, 0, 1, 2].flatMap((dy) =>
    [-2, -1, 0, 1, 2].map((dx) => ({
      key: `${dx}:${dy}`,
      x: tileX + dx,
      y: tileY + dy,
      left: mapCenterPx + dx * 256 - offsetX,
      top: mapCenterPx + dy * 256 - offsetY,
    })),
  )
  const coordinateGroups = new Map<string, PreviewPoint[]>()
  const nameGroups = new Map<string, PreviewPoint[]>()
  points.forEach((point) => {
    const key = `${point.lon.toFixed(7)}:${point.lat.toFixed(7)}`
    if (!coordinateGroups.has(key)) {
      coordinateGroups.set(key, [])
    }
    coordinateGroups.get(key)!.push(point)
    if (!nameGroups.has(point.name)) {
      nameGroups.set(point.name, [])
    }
    nameGroups.get(point.name)!.push(point)
  })

  const markers = points.map((point) => {
    const world = lonLatToWorld(point.lon, point.lat, zoom)
    let left = world.x - centerWorld.x + mapCenterPx
    let top = world.y - centerWorld.y + mapCenterPx

    const key = `${point.lon.toFixed(7)}:${point.lat.toFixed(7)}`
    const group = coordinateGroups.get(key) ?? []
    if (group.length > 1) {
      const idx = group.indexOf(point)
      const angle = (idx * 2 * Math.PI) / group.length
      const radius = 18
      left += radius * Math.cos(angle)
      top += radius * Math.sin(angle)
    }

    return {
      ...point,
      displayName:
        (nameGroups.get(point.name)?.length ?? 0) > 1
          ? `${point.name} (${(nameGroups.get(point.name)?.indexOf(point) ?? 0) + 1})`
          : point.name,
      left,
      top,
    }
  })
  const crsLabels = Array.from(new Set(points.map((point) => point.crs).filter(Boolean)))

  function moveToPoint(point: PreviewPoint) {
    onSelectPoint(point.id)
    setMapCenter(point)
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest("[data-map-marker]")) return

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      centerWorld,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const nextWorld = {
      x: drag.centerWorld.x - (event.clientX - drag.startX),
      y: drag.centerWorld.y - (event.clientY - drag.startY),
    }
    setMapCenter({
      id: "manual-map-center",
      name: "지도 중심",
      ...worldToLonLat(nextWorld.x, nextWorld.y, zoom),
    })
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function changeZoom(nextZoom: number, anchorOffset?: { x: number; y: number }) {
    const clampedZoom = Math.min(18, Math.max(8, nextZoom))
    if (clampedZoom === zoom) return

    if (anchorOffset) {
      const anchorBefore = worldToLonLat(centerWorld.x + anchorOffset.x, centerWorld.y + anchorOffset.y, zoom)
      const anchorAfterWorld = lonLatToWorld(anchorBefore.lon, anchorBefore.lat, clampedZoom)
      const nextCenterWorld = {
        x: anchorAfterWorld.x - anchorOffset.x,
        y: anchorAfterWorld.y - anchorOffset.y,
      }
      setMapCenter({
        id: "zoom-map-center",
        name: "지도 중심",
        ...worldToLonLat(nextCenterWorld.x, nextCenterWorld.y, clampedZoom),
      })
    }

    setZoom(clampedZoom)
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    changeZoom(zoom + (event.deltaY < 0 ? 1 : -1), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    })
  }

  return (
    <div className="overflow-hidden rounded-md border border-sky-400/20 bg-background/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-400/20 px-3 py-2">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-sky-300" />
          <span className="text-xs font-medium text-foreground">좌표 위치 미리보기</span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {points.length}개 시추공 {crsLabels.length ? `· ${crsLabels.join(", ")}` : ""}
        </span>
      </div>
      <div
        className="relative h-56 cursor-grab overflow-hidden bg-[#d8e7d1] active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <div className="absolute right-2 top-2 z-10 flex overflow-hidden rounded border border-slate-300 bg-white/90 shadow">
          <button
            type="button"
            onClick={() => changeZoom(zoom + 1, { x: -120, y: -60 })}
            className="h-7 w-7 border-r border-slate-300 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-40"
            disabled={zoom >= 18}
            title="확대"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => changeZoom(zoom - 1, { x: -120, y: -60 })}
            className="h-7 w-7 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-40"
            disabled={zoom <= 8}
            title="축소"
          >
            -
          </button>
        </div>
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ width: mapPlaneSize, height: mapPlaneSize }}
        >
          {tiles.map((tile) => (
            <img
              key={tile.key}
              src={`https://tile.openstreetmap.org/${zoom}/${tile.x}/${tile.y}.png`}
              alt=""
              className="absolute h-64 w-64 select-none bg-[#d8e7d1]"
              draggable={false}
              style={{ left: tile.left, top: tile.top }}
            />
          ))}
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              data-map-marker
              onClick={() => moveToPoint(marker)}
              className="absolute -translate-x-1/2 -translate-y-full focus:outline-none"
              style={{ left: marker.left, top: marker.top }}
              title={`${marker.displayName} (${marker.lat.toFixed(6)}, ${marker.lon.toFixed(6)})`}
            >
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "mb-1 rounded px-1.5 py-0.5 text-[10px] font-medium shadow",
                    selectedId === marker.id ? "bg-amber-300 text-slate-950" : "bg-slate-950/90 text-sky-100",
                  )}
                >
                  {marker.displayName}
                </span>
                <MapPin
                  className={cn(
                    "h-6 w-6 drop-shadow",
                    selectedId === marker.id ? "fill-amber-300 text-slate-950" : "fill-sky-300 text-sky-950",
                  )}
                />
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-2 border-t border-sky-400/20 px-3 py-2 text-[11px] text-muted-foreground sm:grid-cols-2">
        <span>중심: {center.lat.toFixed(6)}, {center.lon.toFixed(6)} · 줌 {zoom}</span>
        <span>위치가 현장과 다르면 기준좌표계를 수정해서 다시 확인하세요.</span>
      </div>
    </div>
  )
}
