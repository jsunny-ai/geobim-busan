import { getStrataColor, normalizeStrataGroup } from "@shared/strataColor"
import type { Borehole } from "@/lib/types"

interface Props {
  borehole: Borehole
}

const STRATA_LABELS = {
  soil: "토사",
  weathered_rock: "풍화암",
  soft_rock: "연암",
  normal_rock: "보통암",
  hard_rock: "경암",
  unknown: "미분류",
} as const

function getStrataLabel(soilType: string) {
  const group = normalizeStrataGroup(soilType)
  return STRATA_LABELS[group] ?? soilType
}

export default function StratigraphyColumn({ borehole }: Props) {
  const totalDepth = borehole.strata.length > 0
    ? Math.max(...borehole.strata.map((s) => s.depth_bottom))
    : 1

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{borehole.name}</span>
        {borehole.elevation != null && (
          <span className="ml-2">표고 {borehole.elevation.toFixed(1)} m</span>
        )}
        <span className="ml-2 text-xs">
          ({borehole.latitude.toFixed(6)}, {borehole.longitude.toFixed(6)})
        </span>
      </div>

      <div className="flex gap-2">
        {/* 깊이 눈금 */}
        <div className="flex flex-col justify-between py-px text-xs text-muted-foreground w-8">
          <span>0</span>
          <span>{(totalDepth / 2).toFixed(0)}</span>
          <span>{totalDepth.toFixed(0)}</span>
        </div>

        {/* 주상도 바 */}
        <div className="relative flex-1 rounded overflow-hidden border border-border" style={{ minHeight: 200 }}>
          {borehole.strata.map((s) => {
            const top = (s.depth_top / totalDepth) * 100
            const height = ((s.depth_bottom - s.depth_top) / totalDepth) * 100
            const color = getStrataColor(s.soil_type)
            return (
              <div
                key={s.id}
                className="absolute w-full flex items-center justify-center"
                style={{ top: `${top}%`, height: `${height}%`, backgroundColor: color }}
              >
                <span className="text-xs font-medium text-slate-900 drop-shadow-sm select-none">
                  {getStrataLabel(s.soil_type)}
                </span>
              </div>
            )
          })}
        </div>

        {/* 깊이 라벨 */}
        <div className="relative w-10" style={{ minHeight: 200 }}>
          {borehole.strata.map((s) => {
            const top = (s.depth_top / totalDepth) * 100
            return (
              <div
                key={s.id}
                className="absolute text-xs text-muted-foreground leading-none"
                style={{ top: `${top}%` }}
              >
                {s.depth_top}
              </div>
            )
          })}
          <div
            className="absolute text-xs text-muted-foreground leading-none"
            style={{ top: "100%" }}
          >
            {totalDepth}
          </div>
        </div>
      </div>
    </div>
  )
}
