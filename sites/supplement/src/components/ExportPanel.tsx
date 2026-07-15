import type { ExportOptions, InterpolationMode } from "@/lib/types"

const C = {
  border:    "#e9e4da",
  text:      "#1c1917",
  secondary: "#44403c",
  tertiary:  "#78716c",
  inner:     "#f2ede6",
  btnActive: "#D4D1CB",
  btnBorder: "#BEBAB3",
  btnIdle:   "#f2ede6",
  btnIdleBd: "#e9e4da",
  red:       "#dc2626",
  green:     "#D4D1CB",
  greenBd:   "#BEBAB3",
} as const

// 체크박스 목록 (위→아래 지질 순서)
const LAYER_CONFIG = [
  { key: "ground_surface", label: "지표면",     color: "#4a7c35" },
  { key: "weathered_rock", label: "풍화암 상부면", color: "#C4A57B" },
  { key: "soft_rock",      label: "연암 상부면",   color: "#6B8E5A" },
  { key: "normal_rock",    label: "보통암 상부면", color: "#5F6552" },
  { key: "hard_rock",      label: "경암 상부면",   color: "#3D3D3D" },
]

// 단면 시각화 지층 블록 (위→아래)
const SECTION_LAYERS = [
  { label: "지표면", color: "#a3c98a", height: 14 },
  { label: "토사",   color: "#c9b89a", height: 30 },
  { label: "풍화암", color: "#c4a57b", height: 30 },
  { label: "연암",   color: "#7da86e", height: 30 },
  { label: "보통암", color: "#6b7a5a", height: 30 },
  { label: "경암",   color: "#4a4a4a", height: 30 },
]

const RES_OPTIONS = [24, 32, 48, 64, 96]

interface Props {
  opts: ExportOptions
  setOpts: React.Dispatch<React.SetStateAction<ExportOptions>>
  newBhCount: number
  existingBhCount: number
  exportState: "idle" | "loading" | "done" | "error"
  exportErr: string | null
  onExport: () => void
  availableGroups?: Set<string>
}

function SectionPreview({ layers }: { layers: string[] }) {
  const selected = new Set(layers)
  const W = 220

  // 누적 y 오프셋 계산
  const yOffsets: number[] = []
  let acc = 0
  for (const sl of SECTION_LAYERS) {
    yOffsets.push(acc)
    acc += sl.height
  }
  const totalH = acc
  yOffsets.push(totalH) // index 6 = 다이어그램 하단

  // 각 경계면의 y 위치 (지층 블록 사이 경계)
  // ground_surface : 지표면 하단 = 토사 상단 = yOffsets[1]
  // weathered_rock : 풍화암 상단 = yOffsets[2]
  // soft_rock      : 연암 상단  = yOffsets[3]
  // normal_rock    : 보통암 상단 = yOffsets[4]
  // hard_rock      : 경암 상단  = yOffsets[5]
  const BOUNDARIES = [
    { key: "ground_surface", y: yOffsets[1],     color: "#4a7c35", label: "지표면"     },
    { key: "weathered_rock", y: yOffsets[2],     color: "#C4A57B", label: "풍화암 상부면" },
    { key: "soft_rock",      y: yOffsets[3],     color: "#6B8E5A", label: "연암 상부면"   },
    { key: "normal_rock",    y: yOffsets[4],     color: "#5F6552", label: "보통암 상부면" },
    { key: "hard_rock",      y: yOffsets[5],     color: "#3D3D3D", label: "경암 상부면"   },
  ]

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 6 }}>내보낼 경계면 미리보기</div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <svg width={W} height={totalH}
          style={{ border: `1px solid ${C.border}`, borderRadius: 6, display: "block", overflow: "visible" }}>

          {/* 지층 배경 블록 */}
          {SECTION_LAYERS.map((sl, idx) => (
            <g key={idx}>
              <rect x={0} y={yOffsets[idx]} width={W} height={sl.height}
                fill={sl.color} opacity={0.55} />
              <text x={8} y={yOffsets[idx] + sl.height / 2 + 4}
                fontSize={9} fill="#1c1917" fontFamily="'Noto Sans KR',sans-serif" opacity={0.85}>
                {sl.label}
              </text>
            </g>
          ))}

          {/* 경계면 선 */}
          {BOUNDARIES.map(({ key, y, color, label }) => {
            const isActive = selected.has(key)
            return (
              <g key={key}>
                {isActive ? (
                  <>
                    <line x1={0} y1={y} x2={W} y2={y}
                      stroke={color} strokeWidth={2.5} strokeDasharray="6 3" />
                    <rect x={W - 102} y={y - 9} width={98} height={14}
                      fill={color} rx={3} opacity={0.92} />
                    <text x={W - 53} y={y + 1.5}
                      fontSize={8} fill="#fff" textAnchor="middle"
                      fontFamily="'Noto Sans KR',sans-serif" fontWeight="bold">
                      {label}
                    </text>
                  </>
                ) : (
                  <line x1={0} y1={y} x2={W} y2={y}
                    stroke="#bbb" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.5} />
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <div style={{ fontSize: 10, color: C.tertiary, marginTop: 5, textAlign: "center" }}>
        강조된 경계면이 지층별 LandXML COGO Point Group으로 내보내집니다
      </div>
    </div>
  )
}

export default function ExportPanel({
  opts, setOpts, newBhCount, existingBhCount,
  exportState, exportErr, onExport,
  availableGroups,
}: Props) {
  // availableGroups 미전달 시 전체 허용
  const isAvailable = (key: string) => !availableGroups || availableGroups.has(key)

  const toggleLayer = (key: string) => {
    if (!isAvailable(key)) return
    setOpts(prev => ({
      ...prev,
      layers: prev.layers.includes(key)
        ? prev.layers.filter(l => l !== key)
        : [...prev.layers, key],
    }))
  }

  const setMode = (mode: InterpolationMode) => setOpts(prev => ({ ...prev, mode }))

  const canExport = existingBhCount > 0 || newBhCount > 0
  const newOnlyWarn = opts.mode === "new_only" && newBhCount === 0

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.tertiary, marginBottom: 2 }}>내보내기</div>
      <h2 style={{ margin: "0 0 16px 0", fontSize: 14, fontWeight: 700 }}>
        Civil 3D · LandXML 출력
      </h2>

      {/* ── 보간 방식 ── */}
      <section style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 8 }}>보간 방식</div>
        {(["merge", "new_only"] as const).map((mode) => {
          const active = opts.mode === mode
          const labels = {
            merge:    { title: "기존 + 신규 합산 (권장)", desc: "DB 기존 시추공과 신규 입력 데이터를 합쳐 보간합니다." },
            new_only: { title: "신규 데이터만",           desc: "새로 입력한 시추공만으로 독립적인 지층 모델을 생성합니다." },
          }
          return (
            <div key={mode} onClick={() => setMode(mode)} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "10px 12px", marginBottom: 6, borderRadius: 8, cursor: "pointer",
              background: active ? "rgba(160,155,148,.18)" : C.inner,
              border: `1px solid ${active ? C.btnBorder : C.border}`,
            }}>
              <span style={{
                width: 14, height: 14, borderRadius: "50%", flexShrink: 0, marginTop: 1,
                border: `2px solid ${active ? C.btnActive : C.btnIdleBd}`,
                background: active ? C.btnActive : "transparent",
              }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: active ? 700 : 400, color: C.text }}>
                  {labels[mode].title}
                </div>
                <div style={{ fontSize: 11, color: C.tertiary, marginTop: 2 }}>
                  {labels[mode].desc}
                </div>
              </div>
            </div>
          )
        })}
        <div style={{
          fontSize: 11, color: C.tertiary, marginTop: 8, padding: "8px 10px",
          background: C.inner, borderRadius: 6, border: `1px solid ${C.border}`,
        }}>
          {opts.mode === "merge" ? (
            <>보간에 사용될 시추공: <strong style={{ color: C.secondary }}>{existingBhCount + newBhCount}개</strong>
              {" "}(기존 {existingBhCount} + 신규 {newBhCount})</>
          ) : (
            <>보간에 사용될 시추공: <strong style={{ color: newBhCount > 0 ? "#1c1917" : C.red }}>
              {newBhCount}개
            </strong> (신규만)</>
          )}
        </div>
        {newOnlyWarn && (
          <div style={{
            marginTop: 6, padding: "7px 10px", borderRadius: 6,
            background: "rgba(232,83,58,.1)", border: `1px solid ${C.red}`,
            fontSize: 11, color: C.red,
          }}>
            ⚠ 중앙 패널에서 신규 시추공을 먼저 추가해야 합니다.
          </div>
        )}
      </section>

      {/* ── 내보낼 경계면 선택 ── */}
      <section style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 8 }}>내보낼 지층 경계면</div>
        {LAYER_CONFIG.map(({ key, label, color }) => {
          const checked = opts.layers.includes(key)
          const available = isAvailable(key)
          return (
            <div key={key} onClick={() => toggleLayer(key)} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "5px 8px", marginBottom: 3, borderRadius: 5,
              cursor: available ? "pointer" : "not-allowed",
              opacity: available ? (checked ? 1 : 0.4) : 0.25,
            }}>
              <span style={{
                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                background: available && checked ? color : C.btnIdle,
                border: `1px solid ${available && checked ? color : C.btnIdleBd}`,
              }} />
              <span style={{ fontSize: 12, color: C.secondary }}>{label}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: C.tertiary }}>
                {!available ? "데이터 없음" : checked ? "포함" : "제외"}
              </span>
            </div>
          )
        })}
        {opts.layers.length === 0 && (
          <p style={{ fontSize: 11, color: C.red, marginTop: 4 }}>
            1개 이상의 경계면을 선택하세요.
          </p>
        )}
      </section>

      {/* ── 단면 미리보기 ── */}
      <SectionPreview layers={opts.layers} />

      {/* ── 격자 해상도 ── */}
      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: C.tertiary, marginBottom: 8 }}>
          격자 해상도 (점 개수): <strong style={{ color: C.secondary }}>{opts.gridRes} × {opts.gridRes}</strong>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {RES_OPTIONS.map((r) => (
            <button key={r} onClick={() => setOpts(prev => ({ ...prev, gridRes: r }))} style={{
              flex: 1, padding: "5px 0", borderRadius: 5, fontSize: 11, cursor: "pointer",
              background: opts.gridRes === r ? C.btnActive : C.btnIdle,
              border: `1px solid ${opts.gridRes === r ? C.btnBorder : C.btnIdleBd}`,
              color: opts.gridRes === r ? "#1c1917" : C.secondary,
              fontWeight: opts.gridRes === r ? 700 : 400,
            }}>{r}</button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: C.tertiary, marginTop: 5 }}>
          높을수록 정밀하지만 파일 크기가 커집니다 (권장: 48).
        </div>
      </section>

      {/* ── 출력 형식 정보 ── */}
      <div style={{
        marginBottom: 16, padding: "10px 12px", borderRadius: 7,
        background: C.inner, border: `1px solid ${C.border}`, fontSize: 11, color: C.tertiary,
      }}>
        <div style={{ fontWeight: 600, color: C.secondary, marginBottom: 4 }}>출력 형식</div>
        <div>· LandXML 1.2 (Civil 3D 호환)</div>
        <div>· COGO Points — 각 지층 Point Group 분리</div>
        <div>· 시추공 실측 접촉점과 RBF 보간점 구분</div>
        <div>· 좌표계: Korea 2000 Central Belt 2010 (EPSG:5186, meter)</div>
        <div>· 파일명: geobim_stratum_YYYYMMDD.xml</div>
      </div>

      {/* ── 내보내기 버튼 ── */}
      <button
        onClick={onExport}
        disabled={!canExport || newOnlyWarn || opts.layers.length === 0 || exportState === "loading"}
        style={{
          width: "100%", padding: "12px 0", borderRadius: 8,
          fontSize: 14, fontWeight: 700,
          cursor: canExport && !newOnlyWarn && opts.layers.length > 0 ? "pointer" : "not-allowed",
          background: exportState === "done"
            ? C.green : exportState === "error"
            ? "rgba(232,83,58,.2)"
            : canExport && !newOnlyWarn && opts.layers.length > 0 ? C.btnActive : C.btnIdle,
          border: `1px solid ${
            exportState === "done"  ? C.greenBd :
            exportState === "error" ? C.red :
            canExport && !newOnlyWarn && opts.layers.length > 0 ? C.btnBorder : C.btnIdleBd}`,
          color: canExport && !newOnlyWarn && opts.layers.length > 0 ? "#1c1917" : C.tertiary,
          opacity: exportState === "loading" ? 0.7 : 1,
          transition: "all .2s",
        }}
      >
        {exportState === "loading" ? "⏳ 보간 및 생성 중..." :
         exportState === "done"    ? "✓ 파일 다운로드 완료" :
         exportState === "error"   ? "⚠ 오류 발생 (재시도)" :
         "📥 Civil 3D용 COGO 점 내보내기"}
      </button>

      {exportErr && (
        <div style={{
          marginTop: 8, padding: "8px 10px", borderRadius: 6,
          background: "rgba(232,83,58,.1)", border: `1px solid ${C.red}`,
          fontSize: 11, color: C.red, wordBreak: "break-all",
        }}>
          {exportErr}
        </div>
      )}

      {exportState === "done" && (
        <div style={{
          marginTop: 8, padding: "8px 10px", borderRadius: 6,
          background: "rgba(160,155,148,.12)", border: "1px solid rgba(160,155,148,.40)",
          fontSize: 11, color: C.secondary,
        }}>
          Civil 3D에서 '가져오기 → LandXML'로 파일을 불러오세요.
        </div>
      )}
    </div>
  )
}
