import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getStrataColor } from "@shared/strataColor"
import type { Borehole } from "@/lib/types"

interface Props {
  borehole: Borehole
  onClose: () => void
}

export default function StratigraphyPanel({ borehole, onClose }: Props) {
  const totalDepth = borehole.strata.length > 0
    ? Math.max(...borehole.strata.map((s) => s.depth_bottom))
    : 1

  return (
    <div className="absolute right-4 top-16 bottom-4 w-64 bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <p className="text-sm font-semibold">{borehole.name}</p>
          {borehole.elevation != null && (
            <p className="text-xs text-muted-foreground">표고 {borehole.elevation.toFixed(1)} m</p>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex gap-2" style={{ minHeight: 240 }}>
          {/* 눈금 */}
          <div className="flex flex-col justify-between text-xs text-muted-foreground w-6">
            <span>0</span>
            <span>{(totalDepth / 2).toFixed(0)}</span>
            <span>{totalDepth.toFixed(0)}</span>
          </div>

          {/* 주상도 */}
          <div className="relative flex-1 rounded overflow-hidden border border-border">
            {borehole.strata.map((s) => {
              const top = (s.depth_top / totalDepth) * 100
              const height = ((s.depth_bottom - s.depth_top) / totalDepth) * 100
              return (
                <div
                  key={s.id}
                  className="absolute w-full flex items-center justify-center"
                  style={{ top: `${top}%`, height: `${height}%`, backgroundColor: getStrataColor(s.soil_type) }}
                >
                  <span className="text-xs font-medium text-slate-900 select-none">{s.soil_type}</span>
                </div>
              )
            })}
          </div>

          {/* 깊이 */}
          <div className="relative w-8" style={{ minHeight: 240 }}>
            {borehole.strata.map((s) => (
              <div
                key={s.id}
                className="absolute text-xs text-muted-foreground"
                style={{ top: `${(s.depth_top / totalDepth) * 100}%` }}
              >
                {s.depth_top}
              </div>
            ))}
            <div className="absolute text-xs text-muted-foreground" style={{ top: "100%" }}>
              {totalDepth}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
