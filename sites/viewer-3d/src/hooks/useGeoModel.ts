import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
// @ts-ignore
import * as THREE from "three"
// @ts-ignore
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { buildAreaCanvas } from "@/lib/terrain"
import { buildBoxesMesh, buildSurfaceMesh } from "../lib/geoGeometry"
import { createLocalProjection, type Bbox } from "@/lib/projection"
import type { Borehole } from "@/lib/types"
import { createAuthoritativeTerrainGrid, type AuthoritativeTerrainGrid } from "@/lib/authoritativeTerrain"
import { coastalDisplayTerrainElevation } from "@/lib/coastalDisplayTerrain"
import type { CoastalLandMask } from "@/lib/coastalLandMask"
import { normalizeSoilDetailName } from "@/lib/soilDetail"
import { layerColorNumber, type LayerColorOverrides } from "@/lib/layerColors"

export interface GeoModelSettings {
  verticalExag: number
  depthBelowMSL: number
  basemap: "Satellite" | "Hybrid" | "Base"
  visibility: Record<string, boolean>
  showColumns: boolean
  soilDetailVisibility: Record<string, boolean>
  layerColorOverrides: LayerColorOverrides
  showDrape: boolean
  renderMode: "smooth" | "voxel"
  basementMode: "extend" | "unknown"
  selectedBh: string | null
  setSelectedBh: (id: string | null) => void
  pickMode?: "normal" | "virtual-copy" | "section"
  onBoreholePick?: (id: string) => void
  setStatus: (msg: string) => void
  bhPosRef: RefObject<Record<string, { x: number; y: number; z: number }>>
}

const LAYER_STACK = ["soil", "weathered_rock", "soft_rock", "normal_rock", "hard_rock", "unknown"]
const stripExtSuffix = (type: string) =>
  type.endsWith("@ext") ? type.slice(0, -4) : type
const isExtLayer = (type: string) => type.endsWith("@ext")
const soilDetailFromLayer = (type: string) => {
  const base = stripExtSuffix(type)
  if (!base.startsWith("soil_detail:")) return null
  return base.slice("soil_detail:".length).replace(/#\d+$/, "")
}
const majorLayerFromType = (type: string) =>
  soilDetailFromLayer(type) ? "soil" : stripExtSuffix(type)
const layerColorKeyFromType = (type: string) => {
  const detail = soilDetailFromLayer(type)
  return detail ? `soil_detail:${detail}` : majorLayerFromType(type)
}
const overlayLocalY = (surfaceY: number, offsetY: number, verticalExag: number) =>
  surfaceY + offsetY / Math.max(verticalExag, 1e-6)

function applyPlanarUv(geometry: THREE.BufferGeometry, boxW: number, boxD: number) {
  const position = geometry.getAttribute("position")
  if (!position) return
  const uvs: number[] = []
  const safeW = Math.max(boxW, 1e-9)
  const safeD = Math.max(boxD, 1e-9)
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const z = position.getZ(i)
    uvs.push(x / safeW + 0.5, z / safeD + 0.5)
  }
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
}

// [v4] 표시 규칙 — 미분류 구간 처리 세그먼트 토글:
//   연장 모드("extend")   → "@ext" 메쉬 5개만 표시 (연장분이 흡수된 단일 솔리드)
//   미분류 유지("unknown") → 관측 메쉬 5개 + 미분류 회색 솔리드 표시
const layerVisible = (type: string, vis: Record<string, boolean>, mode: "extend" | "unknown") => {
  const isExt = isExtLayer(type)
  const base = majorLayerFromType(type)
  if (mode === "extend") return isExt && (vis[base] ?? true)
  return !isExt && (vis[base] ?? true)
}
const LAYER_SETS: Record<GeoModelSettings["basemap"], string[]> = {
  Base: ["Base"],
  Satellite: ["Satellite"],
  Hybrid: ["Satellite", "Hybrid"],
}

function buildBoreholeLabel(text: string, isVirtual: boolean, unit: number) {
  const fontSize = 30
  const paddingX = 16
  const paddingY = 9
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")!
  context.font = `700 ${fontSize}px "Noto Sans KR", sans-serif`
  const measured = Math.ceil(context.measureText(text).width)
  canvas.width = measured + paddingX * 2
  canvas.height = fontSize + paddingY * 2

  context.font = `700 ${fontSize}px "Noto Sans KR", sans-serif`
  context.fillStyle = isVirtual ? "rgba(91,33,182,.94)" : "rgba(255,255,255,.94)"
  context.strokeStyle = isVirtual ? "rgba(233,213,255,1)" : "rgba(68,64,60,.9)"
  context.lineWidth = 3
  context.beginPath()
  context.roundRect(1.5, 1.5, canvas.width - 3, canvas.height - 3, 9)
  context.fill()
  context.stroke()
  context.fillStyle = isVirtual ? "#ffffff" : "#1c1917"
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 1)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  // 전체 사업영역을 한 화면에 담은 기본 시점에서도 공명이 읽히도록
  // 시추공 기둥 반경보다 충분히 큰 비율을 사용한다.
  const height = unit * 8.2
  sprite.scale.set(height * (canvas.width / canvas.height), height, 1)
  sprite.renderOrder = 1002
  return sprite
}

export function useGeoModel(
  sceneRef: RefObject<THREE.Scene | null>,
  rendererRef: RefObject<THREE.WebGLRenderer | null>,
  cameraRef: RefObject<THREE.PerspectiveCamera | null>,
  controlsRef: RefObject<OrbitControls | null>,
  boreholes: Borehole[],
  bbox: number[] | null,
  polygon: { lng: number; lat: number }[] | null,
  settings: GeoModelSettings,
  containerRef: RefObject<HTMLDivElement | null>,
  coastalLandMask?: CoastalLandMask,
) {
  const dimsRef = useRef({ boxW: 2, boxD: 2, lngWidthM: 1, latWidthM: 1, mScale: 1 })
  const smoothMeshRef = useRef<Record<string, THREE.Mesh>>({})
  const voxelMeshRef = useRef<Record<string, THREE.Mesh>>({})
  const drapeRef = useRef<THREE.Mesh | null>(null)
  const drapeMatRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const bhGroupRef = useRef<THREE.Group | null>(null)
  const markerRef = useRef<THREE.Mesh | null>(null)
  const stratumGroupRef = useRef<THREE.Group | null>(null)
  const drapeTextureSeqRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const [authoritativeTerrain, setAuthoritativeTerrain] = useState<AuthoritativeTerrainGrid | null>(null)
  const polygonRef = useRef(polygon)
  polygonRef.current = polygon

  const {
    verticalExag,
    depthBelowMSL,
    basemap,
    visibility,
    showColumns,
    soilDetailVisibility,
    layerColorOverrides,
    showDrape,
    renderMode,
    basementMode,
    selectedBh,
    setSelectedBh,
    pickMode = "normal",
    onBoreholePick,
    setStatus,
    bhPosRef,
  } = settings

  const visibilityRef = useRef(visibility)
  const showColumnsRef = useRef(showColumns)
  const soilDetailVisibilityRef = useRef(soilDetailVisibility)
  const layerColorOverridesRef = useRef(layerColorOverrides)
  const showDrapeRef = useRef(showDrape)
  const renderModeRef = useRef(renderMode)
  const basementModeRef = useRef(basementMode)
  const basemapRef = useRef(basemap)
  const verticalExagRef = useRef(verticalExag)

  visibilityRef.current = visibility
  showColumnsRef.current = showColumns
  soilDetailVisibilityRef.current = soilDetailVisibility
  layerColorOverridesRef.current = layerColorOverrides
  showDrapeRef.current = showDrape
  renderModeRef.current = renderMode
  basementModeRef.current = basementMode
  basemapRef.current = basemap
  verticalExagRef.current = verticalExag

  const applyDrapeTexture = useCallback(
    (targetBasemap: GeoModelSettings["basemap"], targetBbox: number[]) => {
      const drapeMat = drapeMatRef.current
      if (!drapeMat || targetBbox.length !== 4) return

      const seq = ++drapeTextureSeqRef.current
      buildAreaCanvas(targetBbox as [number, number, number, number], LAYER_SETS[targetBasemap], polygonRef.current || undefined)
        .then((drapeCanvas) => {
          if (seq !== drapeTextureSeqRef.current || drapeMatRef.current !== drapeMat) return
          const loadedTex = new THREE.CanvasTexture(drapeCanvas)
          loadedTex.colorSpace = THREE.SRGBColorSpace
          loadedTex.wrapS = THREE.ClampToEdgeWrapping
          loadedTex.wrapT = THREE.ClampToEdgeWrapping
          loadedTex.anisotropy = 4
          loadedTex.needsUpdate = true

          if (drapeMat.map && typeof drapeMat.map.dispose === "function") drapeMat.map.dispose()
          drapeMat.color.setHex(0xffffff)
          drapeMat.transparent = false
          drapeMat.opacity = 1.0
          drapeMat.map = loadedTex
          drapeMat.needsUpdate = true
        })
        .catch((err) => {
          console.error("V-World texture load failed:", err)
        })
    },
    [],
  )

  // 시추공명 라벨(Sprite)은 카메라 거리와 무관한 고정 월드 크기라서, 확대할수록
  // 다른 3D 오브젝트처럼 화면상 크기가 커진다 — buildBoreholeLabel()의 스케일은
  // "전체 영역 조망" 거리에서 읽히도록 튜닝된 값이라 그 이상 가까워지면 과도하게
  // 커져 보인다. 여기서는 그 기준 거리(다른 곳에서도 쓰는 "전체 모델이 보이는
  // 거리" 상수 boxW/boxD * 1.35)보다 카메라가 가까워질 때만 비율만큼 축소해서,
  // 기준 거리 이상에서는 기존 동작을 그대로 유지한다.
  const updateBoreholeLabelScales = useCallback(() => {
    const camera = cameraRef.current
    const group = bhGroupRef.current
    if (!camera || !group) return
    const { boxW, boxD } = dimsRef.current
    const referenceDistance = Math.max(boxW, boxD) * 1.35
    if (!Number.isFinite(referenceDistance) || referenceDistance <= 0) return
    const worldPos = new THREE.Vector3()
    for (const child of group.children) {
      if (!child.userData.isBoreholeLabel) continue
      const sprite = child as THREE.Sprite
      const base = sprite.userData.baseScale as { x: number; y: number } | undefined
      if (!base) continue
      sprite.getWorldPosition(worldPos)
      const distance = camera.position.distanceTo(worldPos)
      const factor = Math.max(0.55, Math.min(1.15, distance / referenceDistance))
      sprite.scale.set(base.x * factor, (base.y * factor) / Math.max(verticalExagRef.current, 1e-6), 1)
    }
  }, [cameraRef])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    controls.addEventListener("change", updateBoreholeLabelScales)
    updateBoreholeLabelScales()
    return () => controls.removeEventListener("change", updateBoreholeLabelScales)
  }, [controlsRef, updateBoreholeLabelScales])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !bbox) return

    let active = true
    let displayedModelQuality: "none" | "preview" | "final" = "none"
    setAuthoritativeTerrain(null)

    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }

    let marker = markerRef.current
    if (!marker) {
      marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.02, 0.05, 4),
        new THREE.MeshStandardMaterial({
          color: 0xffd24a,
          emissive: 0x6b5410,
          roughness: 0.4,
        }),
      )
      marker.rotation.x = Math.PI
      marker.visible = false
      scene.add(marker)
      markerRef.current = marker
    }

    let stratumGroup = stratumGroupRef.current
    if (!stratumGroup) {
      stratumGroup = new THREE.Group()
      scene.add(stratumGroup)
      stratumGroupRef.current = stratumGroup
    }
    stratumGroup.scale.set(1, verticalExagRef.current, 1)

    const projection = createLocalProjection(bbox as Bbox)
    const lngWidthM = projection.widthM
    const latWidthM = projection.heightM
    const boxW = projection.modelWidth
    const boxD = projection.modelDepth
    const mScale = projection.metersToModel
    dimsRef.current = { boxW, boxD, lngWidthM, latWidthM, mScale }

    const lngToX = (lng: number, lat: number) => projection.lngLatToModel(lng, lat).x
    const latToZ = (lng: number, lat: number) => projection.lngLatToModel(lng, lat).z

    const fitCamera = () => {
      const cam = cameraRef.current
      const ctr = controlsRef.current
      if (!cam || !ctr) return
      ctr.target.set(0, -0.1 * verticalExagRef.current, 0)
      cam.position.set(boxW * 1.0, boxW * 0.9, boxD * 1.1)
      ctr.update()
    }

    const disposeMaterial = (material: THREE.Material) => {
      const materialWithMaps = material as THREE.Material & Record<string, any>
      for (const key of ["map", "alphaMap", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"]) {
        const texture = materialWithMaps[key] as THREE.Texture | undefined
        if (texture && typeof texture.dispose === "function") texture.dispose()
      }
      material.dispose()
    }

    const clearStratumGroup = () => {
      while (stratumGroup.children.length > 0) {
      const child = stratumGroup.children[0]
      stratumGroup.remove(child)
        child.traverse((object) => {
          if (!(object as THREE.Mesh).isMesh) return
          const mesh = object as THREE.Mesh
          mesh.geometry?.dispose()
          const material = mesh.material
          if (Array.isArray(material)) material.forEach(disposeMaterial)
          else if (material) disposeMaterial(material)
        })
      }
      smoothMeshRef.current = {}
      voxelMeshRef.current = {}
      bhGroupRef.current = null
      drapeRef.current = null
      drapeMatRef.current = null
    }
    clearStratumGroup()

    setStatus("지표면 지도 텍스처 생성 중...")
    if (boreholes.length === 0) {
      if (markerRef.current) markerRef.current.visible = false
      bhPosRef.current = {}
      smoothMeshRef.current = {}
      voxelMeshRef.current = {}
      bhGroupRef.current = null
      drapeRef.current = null
      drapeMatRef.current = null
      setStatus("선택한 데이터 조건에 해당하는 시추공이 없습니다.")
      return
    }

    const drapeSeq = ++drapeTextureSeqRef.current
    const drapeCanvasPromise = buildAreaCanvas(bbox as [number, number, number, number], LAYER_SETS[basemapRef.current])
      .then((drapeCanvas) => {
        const loadedTex = new THREE.CanvasTexture(drapeCanvas)
        loadedTex.colorSpace = THREE.SRGBColorSpace
        loadedTex.wrapS = THREE.ClampToEdgeWrapping
        loadedTex.wrapT = THREE.ClampToEdgeWrapping
        loadedTex.anisotropy = 4
        loadedTex.needsUpdate = true
        return loadedTex
      })
      .catch((err) => {
        console.error("V-World texture load failed:", err)
        return null
      })

    const PREVIEW_GRID_N = 64
    const FINAL_GRID_N = 192
    let worker: Worker | null = null

    const startModelWorker = (N: number, quality: "preview" | "final") => {
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
      setStatus(quality === "preview" ? "빠른 지층 모델 계산 중..." : "정밀 지층 모델 계산 중...")
      worker = new Worker(new URL("../workers/geoWorker.ts", import.meta.url), { type: "module" })
      workerRef.current = worker

      worker.postMessage({
        boreholes,
        bbox,
        N,
        depthBelowMSL,
        mScale,
        boxW,
        boxD,
        renderMode,
        includeSoilDetails: true,
        coastalPolygons: coastalLandMask?.polygons ?? null,
        coastalStatus: coastalLandMask?.status ?? "not_configured",
      })

      worker.onmessage = (event) => {
      if (!active) return
      const msg = event.data

      if (msg.type === "progress") {
        setStatus(`${quality === "preview" ? "빠른 표시" : "정밀 모델"} · ${msg.step}`)
        return
      }

      if (msg.type === "error") {
        setStatus(`로드 실패: ${msg.error}`)
        return
      }

      if (msg.type !== "done") return
      if (displayedModelQuality !== "none") {
        clearStratumGroup()
      }
      displayedModelQuality = quality

      const {
        elevGrid,
        gx,
        gy,
        smoothMeshData,
        voxelCells,
        dz,
        MZ,
        confRadiusM,
        lngWidthM: resultLngWidthM,
        latWidthM: resultLatWidthM,
        skippedDeep,
        diag,
      } = msg
      setAuthoritativeTerrain(createAuthoritativeTerrainGrid(gx, gy, elevGrid))

      const xGrid = Array.from({ length: gy.length }, (_, j) =>
        Array.from({ length: gx.length }, (__, i) => projection.lngLatToModel(gx[i], gy[j]).x),
      )
      const zGrid = Array.from({ length: gy.length }, (_, j) =>
        Array.from({ length: gx.length }, (__, i) => projection.lngLatToModel(gx[i], gy[j]).z),
      )
      const drapeElevGrid = (elevGrid as number[][]).map((row: number[], j: number) =>
        row.map((elevationM: number, i: number) =>
          coastalDisplayTerrainElevation(gx[i], gy[j], elevationM, coastalLandMask),
        ),
      )

      const drapeGeo = buildSurfaceMesh(
        drapeElevGrid,
        boxW,
        boxD,
        mScale,
        xGrid,
        zGrid,
        undefined,
        gy,
        gx,
      )
      const drapeMat = new THREE.MeshBasicMaterial({
        color: 0x4e6e58,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        transparent: true,
        opacity: 0.55,
      })
      drapeMatRef.current = drapeMat
      const drape = new THREE.Mesh(drapeGeo, drapeMat)
      drape.position.y += 0.002
      drape.visible = showDrapeRef.current
      stratumGroup.add(drape)
      drapeRef.current = drape

      if (drapeMat && bbox.length === 4) {
        const drapeSeq = ++drapeTextureSeqRef.current
        const drapeCanvasPromise = buildAreaCanvas(bbox as [number, number, number, number], LAYER_SETS[basemapRef.current], polygonRef.current || undefined)
        drapeCanvasPromise.then((drapeCanvas) => {
          if (!active || drapeSeq !== drapeTextureSeqRef.current) return
          if (!drapeCanvas) return
          
          const loadedTex = new THREE.CanvasTexture(drapeCanvas)
          loadedTex.colorSpace = THREE.SRGBColorSpace
          loadedTex.wrapS = THREE.ClampToEdgeWrapping
          loadedTex.wrapT = THREE.ClampToEdgeWrapping
          loadedTex.anisotropy = 4
          loadedTex.needsUpdate = true

          if (drapeMat.map && typeof drapeMat.map.dispose === "function") drapeMat.map.dispose()
          drapeMat.color.setHex(0xffffff)
          drapeMat.transparent = false
          drapeMat.opacity = 1.0
          drapeMat.map = loadedTex
          drapeMat.needsUpdate = true
        })
      }

      const smoothMeshes: Record<string, THREE.Mesh> = {}
      for (const [type, data] of Object.entries(smoothMeshData)) {
        const { positions, normals, indices } = data as any
        const geo = new THREE.BufferGeometry()
        geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
        
        if (indices) {
          geo.setIndex(new THREE.BufferAttribute(indices, 1))
        } else if (normals) {
          geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
        }
        applyPlanarUv(geo, boxW, boxD)
        geo.computeVertexNormals()

        // 지층 퇴적 순서(s)에 따라 계단식 polygonOffset을 부여하여 겹치는 구역의 Z-Fighting을 원천 차단
        // "@ext" = 연장 모드 메쉬 — 연장분이 유효 두께에 흡수된 동일 지층이므로 관측 메쉬와 동일 재질
        const baseType = majorLayerFromType(type)
        const soilDetail = soilDetailFromLayer(type)
        const s = LAYER_STACK.indexOf(baseType as any)
        const baseOpacity = 1.0
        const meshColor = layerColorNumber(layerColorKeyFromType(type), layerColorOverridesRef.current)
        const mat = new THREE.MeshStandardMaterial({
          color: meshColor,
          roughness: 0.92,
          side: THREE.DoubleSide,
          transparent: false,
          opacity: baseOpacity,
          depthWrite: true,
          polygonOffset: true,
          polygonOffsetFactor: (s >= 0 ? s + 1 : 1) * 1.5,
          polygonOffsetUnits: (s >= 0 ? s + 1 : 1) * 1.5,
        })
        const mesh = new THREE.Mesh(geo, mat)
        mesh.userData.layerType = type
        mesh.userData.soilDetail = soilDetail
        mesh.userData.isSoilDetailSolid = Boolean(soilDetail)
        mesh.userData.baseOpacity = baseOpacity
        mesh.userData.sectionCapMap = null
        mesh.userData.sectionCapSignature = `${type}:solid-color:${meshColor.toString(16)}`
        stratumGroup.add(mesh)
        smoothMeshes[type] = mesh
      }
      smoothMeshRef.current = smoothMeshes

      const voxelMeshes: Record<string, THREE.Mesh> = {}
      for (const type of Object.keys(voxelCells)) {
        const cells = voxelCells[type]
        if (!cells?.length) continue
        const baseType = majorLayerFromType(type)
        const soilDetail = soilDetailFromLayer(type)
        const meshColor = layerColorNumber(layerColorKeyFromType(type), layerColorOverridesRef.current)
        const mat = new THREE.MeshStandardMaterial({
          color: meshColor,
          roughness: 0.92,
          side: THREE.DoubleSide,
        })
        const geo = buildBoxesMesh(cells)
        applyPlanarUv(geo, boxW, boxD)
        const mesh = new THREE.Mesh(geo, mat)
        mesh.userData.layerType = type
        mesh.userData.soilDetail = soilDetail
        mesh.userData.isSoilDetailSolid = Boolean(soilDetail)
        mesh.userData.baseOpacity = 1.0
        mesh.userData.sectionCapMap = null
        mesh.userData.sectionCapSignature = `${type}:solid-color:${meshColor.toString(16)}`
        stratumGroup.add(mesh)
        voxelMeshes[type] = mesh
      }
      voxelMeshRef.current = voxelMeshes

      const applyVis = (meshes: Record<string, THREE.Mesh>, activeMode: boolean) => {
        const hasSoilDetailSolids = Object.keys(meshes).some((type) => soilDetailFromLayer(type))
        for (const [type, mesh] of Object.entries(meshes)) {
          const detail = soilDetailFromLayer(type)
          const isBaseSoil = majorLayerFromType(type) === "soil" && !detail
          const detailVisible = !detail || soilDetailVisibilityRef.current[detail] !== false
          mesh.visible =
            activeMode &&
            layerVisible(type, visibilityRef.current, basementModeRef.current) &&
            detailVisible &&
            !(isBaseSoil && hasSoilDetailSolids)
        }
      }
      const applyColumnVis = () => {
        const columnsVisible = showColumnsRef.current
        for (const child of bhGroupRef.current?.children ?? []) {
          child.visible = columnsVisible
        }
      }
      applyVis(smoothMeshes, renderModeRef.current === "smooth")
      applyVis(voxelMeshes, renderModeRef.current === "voxel")

      const axisSegment = (axis: number[], value: number) => {
        const n = axis.length
        if (n < 2) return { i0: 0, t: 0 }
        if (value <= axis[0]) return { i0: 0, t: 0 }
        if (value >= axis[n - 1]) return { i0: n - 2, t: 1 }
        let lo = 0
        let hi = n - 1
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          if (axis[mid] <= value) lo = mid
          else hi = mid
        }
        const denom = axis[lo + 1] - axis[lo]
        return { i0: lo, t: denom === 0 ? 0 : Math.max(0, Math.min(1, (value - axis[lo]) / denom)) }
      }
      const sampleElevGrid = (lng: number, lat: number) => {
        const sx = axisSegment(gx, lng)
        const sy = axisSegment(gy, lat)
        const i0 = sx.i0
        const j0 = sy.i0
        const s = sx.t
        const t = sy.t
        const elev00 = elevGrid[j0][i0]
        const elev10 = elevGrid[j0][i0 + 1]
        const elev01 = elevGrid[j0 + 1][i0]
        const elev11 = elevGrid[j0 + 1][i0 + 1]
        return (1 - s) * (1 - t) * elev00 + s * (1 - t) * elev10 + (1 - s) * t * elev01 + s * t * elev11
      }

      const colRadius = Math.max(boxW, boxD) * 0.002
      const bhGroup = new THREE.Group()
      const posMap: Record<string, { x: number; y: number; z: number }> = {}
      for (const b of boreholes) {
        if (!Number.isFinite(b.longitude) || !Number.isFinite(b.latitude) || !Number.isFinite(b.elevation)) continue
        const isVirtual = Boolean((b as any).is_virtual)
        const bx = lngToX(b.longitude, b.latitude)
        const bz = latToZ(b.longitude, b.latitude)

        // 쌍선형 보간(Bilinear Interpolation)을 통해 시추공 위치의 정밀 지표면 고도(surfElev) 계산
        const surfElev = sampleElevGrid(b.longitude, b.latitude)
        const surfaceY = surfElev * mScale

        posMap[b.id] = { x: bx, y: surfElev * mScale * verticalExagRef.current, z: bz }

        // 표면 지도는 지표보다 약간 위에 렌더링되므로 시추공 상단과 이름을
        // depth test에서 제외한 오버레이 마커로 표시한다.
        const markerColor = isVirtual ? 0x7c3aed : 0xb91c1c
        const topMarkerRadius = Math.max(colRadius * 0.45, Math.max(boxW, boxD) * 0.001)
        const markerOffsetY = topMarkerRadius * 1.1
        const topMarker = new THREE.Mesh(
          new THREE.SphereGeometry(topMarkerRadius, 12, 8),
          new THREE.MeshBasicMaterial({
            color: markerColor,
            depthTest: false,
            depthWrite: false,
          }),
        )
        topMarker.position.set(bx, overlayLocalY(surfaceY, markerOffsetY, verticalExagRef.current), bz)
        topMarker.scale.y = 1 / Math.max(verticalExagRef.current, 1e-6)
        topMarker.renderOrder = 1001
        topMarker.userData.bhId = b.id
        topMarker.userData.isBoreholeOverlay = true
        topMarker.userData.isBoreholeTopMarker = true
        topMarker.userData.baseColor = markerColor
        topMarker.userData.surfaceY = surfaceY
        topMarker.userData.offsetY = markerOffsetY
        bhGroup.add(topMarker)

        const displayName = String((b as any).name || b.id).replace(/^◆\s*/, "")
        const label = buildBoreholeLabel(displayName, isVirtual, colRadius)
        const labelOffsetY = colRadius * 1.6
        label.position.set(bx, overlayLocalY(surfaceY, labelOffsetY, verticalExagRef.current), bz)
        label.userData.bhId = b.id
        label.userData.isBoreholeOverlay = true
        label.userData.isBoreholeLabel = true
        label.userData.surfaceY = surfaceY
        label.userData.offsetY = labelOffsetY
        // 확대 시 라벨이 화면을 뒤덮지 않도록 하는 거리 기반 축소의 기준값.
        // updateBoreholeLabelScales()가 이 값과 현재 스케일 비율로 축소 배율을 계산한다.
        label.userData.baseScale = { x: label.scale.x, y: label.scale.y }
        bhGroup.add(label)

        let minY = Number.POSITIVE_INFINITY
        let maxY = Number.NEGATIVE_INFINITY
        for (const seg of b.strata || []) {
          if (!Number.isFinite(seg.depth_top) || !Number.isFinite(seg.depth_bottom)) continue
          const yTop = (surfElev - seg.depth_top) * mScale
          const yBot = (surfElev - seg.depth_bottom) * mScale
          minY = Math.min(minY, yTop, yBot)
          maxY = Math.max(maxY, yTop, yBot)
          const h = Math.max(yTop - yBot, 1e-5)
          const geo = new THREE.CylinderGeometry(colRadius, colRadius, h, 10)
          const layerType = seg.strata_group ?? "unknown"
          const soilDetail = layerType === "soil" ? normalizeSoilDetailName(seg.soil_type) : null
          const mat = new THREE.MeshStandardMaterial({
            color: layerColorNumber(soilDetail ? `soil_detail:${soilDetail}` : layerType, layerColorOverridesRef.current),
            emissive: isVirtual ? 0x6d28d9 : 0x1f2937,
            emissiveIntensity: isVirtual ? 0.45 : 0.08,
            roughness: 0.7,
            transparent: true,
            opacity: 0.96,
            depthTest: false,
            depthWrite: false,
          })
          const cyl = new THREE.Mesh(geo, mat)
          cyl.renderOrder = 1002
          cyl.userData.bhId = b.id
          cyl.userData.isBoreholeColumn = true
          cyl.userData.sectionCapRadius = colRadius
          cyl.userData.sectionCapHeight = h
          cyl.userData.sectionCapMap = null
          cyl.userData.sectionCapSignature = `borehole:${String(b.id)}:${layerType}:${mat.color.getHexString()}`
          bhGroup.add(cyl)

          const edge = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo, 18),
            new THREE.LineBasicMaterial({
              color: 0x111827,
              transparent: true,
              opacity: 0.72,
              depthTest: false,
              depthWrite: false,
            }),
          )
          edge.renderOrder = 1003
          edge.userData.bhId = b.id
          edge.userData.isBoreholeColumnEdge = true
          bhGroup.add(edge)
          cyl.position.set(bx, (yTop + yBot) / 2, bz)
          edge.position.copy(cyl.position)
          cyl.userData.layerType = layerType
          cyl.userData.soilDetail = soilDetail
          cyl.userData.soilType = seg.soil_type
          edge.userData.layerType = layerType
          edge.userData.soilDetail = soilDetail
          edge.userData.soilType = seg.soil_type
          cyl.userData.bhId = b.id  // 클릭 감지용 시추공 ID 저장
          bhGroup.add(cyl)
        }
      }
      bhGroup.visible = showColumnsRef.current
      stratumGroup.add(bhGroup)
      bhGroupRef.current = bhGroup
      applyColumnVis()

      bhPosRef.current = posMap
      fitCamera()
      updateBoreholeLabelScales()
      const LAYER_KO = ["토사", "풍화암", "연암", "보통암", "경암"]
      const soilAbsenceCenters = diag?.soilAbsenceCenters ?? []
      const soilAbsenceInside = soilAbsenceCenters.filter((item: any) => item.inside).length
      const interpolationStability = diag?.interpolationStability
      const stabilityStr = interpolationStability?.mode === "stable-fallback"
        ? ` · 안전 보간 적용(TPS→IDW ${interpolationStability.rbfIdwFallbacks}회, 국부 스냅 ${interpolationStability.snapNodeFallbacks}회, 최소 간격 ${interpolationStability.input?.minSeparationM ?? "-"}m, 근접 ${interpolationStability.input?.nearPairCount ?? 0}쌍)`
        : ""
      const diagStr = diag
        ? ` · [진단] 최심관측 토${diag.bhByDeepest[0]}/풍${diag.bhByDeepest[1]}/연${diag.bhByDeepest[2]}/보${diag.bhByDeepest[3]}/경${diag.bhByDeepest[4]}` +
          ` · 연장점유 토${diag.bottomFill[0]}/풍${diag.bottomFill[1]}/연${diag.bottomFill[2]}/보${diag.bottomFill[3]}/경${diag.bottomFill[4]}` +
          ` · 최대경사 ${diag.maxSlope} m/m(${LAYER_KO[diag.maxSlopeLayer] ?? "-"})` +
          ` · 시추공경계오차 최대 ${diag.boundarySnap?.maxAbsError ?? 0}m` +
          ` · 무토사중심 ${soilAbsenceInside}/${soilAbsenceCenters.length} 내부`
        : ""
      setStatus(
        `${quality === "preview" ? "빠른 모델 표시 완료" : "정밀 모델 완료"} · 시추공 ${boreholes.length}개 · 격자 ${gx.length}x${gy.length}x${MZ} (dz ${dz.toFixed(1)}m) · ` +
          `유효 반경 ${confRadiusM.toFixed(0)}m · 영역 ${resultLngWidthM.toFixed(0)}m x ${resultLatWidthM.toFixed(0)}m` +
          (skippedDeep > 0 ? ` · ⚠️ 심도 이상 ${skippedDeep}공 보간 제외 — 확인 필요` : "") +
          diagStr + stabilityStr,
      )
      if (quality === "preview" && active) {
        startModelWorker(FINAL_GRID_N, "final")
      }
      }

      worker.onerror = (err) => {
        setStatus(`${quality === "preview" ? "빠른 모델" : "정밀 모델"} 계산 오류: ${err.message}`)
      }
    }
    startModelWorker(PREVIEW_GRID_N, "preview")

    return () => {
      active = false
      drapeTextureSeqRef.current += 1
      worker?.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [bbox, boreholes, coastalLandMask, depthBelowMSL, sceneRef, cameraRef, controlsRef, setStatus, bhPosRef, renderMode, updateBoreholeLabelScales])

  useEffect(() => {
    const applyMeshColors = (meshes: Record<string, THREE.Mesh>) => {
      for (const [type, mesh] of Object.entries(meshes)) {
        const material = mesh.material as THREE.MeshStandardMaterial
        const meshColor = layerColorNumber(layerColorKeyFromType(type), layerColorOverrides)
        material.color.setHex(meshColor)
        material.needsUpdate = true
        mesh.userData.sectionCapSignature = `${type}:solid-color:${meshColor.toString(16)}`
      }
    }
    applyMeshColors(smoothMeshRef.current)
    applyMeshColors(voxelMeshRef.current)

    const bhGroup = bhGroupRef.current
    if (bhGroup) {
      for (const child of bhGroup.children) {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh || !child.userData.layerType || child.userData.isBoreholeTopMarker) continue
        const material = mesh.material as THREE.MeshStandardMaterial
        const detail = child.userData.soilDetail as string | null | undefined
        const layerType = String(child.userData.layerType ?? "unknown")
        material.color.setHex(layerColorNumber(detail ? `soil_detail:${detail}` : layerType, layerColorOverrides))
        if (child.userData.isBoreholeColumn) {
          child.userData.sectionCapSignature = `borehole:${String(child.userData.bhId)}:${layerType}:${material.color.getHexString()}`
        }
        material.needsUpdate = true
      }
    }
  }, [layerColorOverrides])

  useEffect(() => {
    const apply = (meshes: Record<string, THREE.Mesh>, activeMode: boolean) => {
      const hasSoilDetailSolids = Object.keys(meshes).some((type) => soilDetailFromLayer(type))
      for (const [type, mesh] of Object.entries(meshes)) {
        const detail = soilDetailFromLayer(type)
        const isBaseSoil = majorLayerFromType(type) === "soil" && !detail
        const detailVisible = !detail || soilDetailVisibility[detail] !== false
        mesh.visible =
          activeMode &&
          layerVisible(type, visibility, basementMode) &&
          detailVisible &&
          !(isBaseSoil && hasSoilDetailSolids)
      }
    }
    apply(smoothMeshRef.current, renderMode === "smooth")
    apply(voxelMeshRef.current, renderMode === "voxel")

    const bhGroup = bhGroupRef.current
    if (bhGroup) {
      bhGroup.visible = showColumns
      for (const child of bhGroup.children) child.visible = showColumns
    }

    const drape = drapeRef.current
    if (drape) {
      drape.visible = showDrape
    }
  }, [visibility, renderMode, showColumns, showDrape, basementMode, soilDetailVisibility])

  useEffect(() => {
    if (drapeRef.current) drapeRef.current.visible = showDrape
  }, [showDrape])

  useEffect(() => {
    if (!bbox || !drapeMatRef.current) return
    applyDrapeTexture(basemap, bbox)
  }, [basemap, bbox, applyDrapeTexture])

  useEffect(() => {
    if (bhGroupRef.current) bhGroupRef.current.visible = showColumns
  }, [showColumns])

  useEffect(() => {
    if (pickMode !== "virtual-copy") return
    const bhGroup = bhGroupRef.current
    if (!bhGroup) return
    bhGroup.visible = true
    for (const child of bhGroup.children) child.visible = true
  }, [pickMode])

  useEffect(() => {
    if (stratumGroupRef.current) {
      stratumGroupRef.current.scale.set(1, verticalExag, 1)
    }
    for (const child of bhGroupRef.current?.children ?? []) {
      if (!child.userData.isBoreholeTopMarker && !child.userData.isBoreholeLabel) continue
      const surfaceY = Number(child.userData.surfaceY)
      const offsetY = Number(child.userData.offsetY)
      if (Number.isFinite(surfaceY) && Number.isFinite(offsetY)) {
        child.position.y = overlayLocalY(surfaceY, offsetY, verticalExag)
      }
      if (child.userData.isBoreholeTopMarker) {
        child.scale.y = 1 / Math.max(verticalExag, 1e-6)
      }
    }
    updateBoreholeLabelScales()
  }, [updateBoreholeLabelScales, verticalExag])

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || !bbox) return

    // 선택된 원본 시추공의 공명 박스를 강조하고 선택 해제 시 복원한다.
    for (const child of bhGroupRef.current?.children ?? []) {
      if (!child.userData.isBoreholeLabel) continue
      const material = (child as THREE.Sprite).material as THREE.SpriteMaterial
      const isSelected = selectedBh !== null && String(child.userData.bhId) === String(selectedBh)
      material.color.setHex(isSelected ? 0xffc928 : 0xffffff)
      material.needsUpdate = true
    }

    // ── 지층 투명도: 선택 시 0.25, 해제 시 불투명 복원 ──────────────────
    const allLayerMeshes = [
      ...Object.values(smoothMeshRef.current),
      ...Object.values(voxelMeshRef.current),
    ]
    if (selectedBh === null) {
      marker.visible = false
      // 선택 해제 → 지층 불투명 복원
      for (const mesh of allLayerMeshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial
        const base = (mesh.userData.baseOpacity as number) ?? 0.68
        mat.transparent = base < 1
        mat.opacity = base
        mat.depthWrite = base >= 1
        mat.needsUpdate = true
      }
      return
    }

    // 선택됨 → 지층 반투명 처리. 선택 마커를 보이게 하되 지층 구조가 흐려지지 않도록 유지한다.
    for (const mesh of allLayerMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.transparent = true
      mat.opacity = 0.62
      mat.depthWrite = false
      mat.needsUpdate = true
    }

    const b = boreholes.find((h) => h.id === selectedBh)
    if (!b) {
      marker.visible = false
      return
    }
    const { mScale } = dimsRef.current
    const pModel = createLocalProjection(bbox as Bbox).lngLatToModel(b.longitude, b.latitude)
    const bx = pModel.x
    const bz = pModel.z
    const p = bhPosRef.current?.[b.id]
    const by = p ? p.y : (b.elevation || 0) * mScale * verticalExag
    marker.position.set(bx, by + 0.05, bz)
    marker.visible = true
  }, [selectedBh, boreholes, bbox, verticalExag])

  const focusBorehole = useCallback((id: string) => {
    const p = bhPosRef.current?.[id]
    const cam = cameraRef.current
    const ctr = controlsRef.current
    if (!p || !cam || !ctr) return

    setSelectedBh(id)
    const dist = Math.max(dimsRef.current.boxW, dimsRef.current.boxD) * 0.55
    const startT = ctr.target.clone()
    const startP = cam.position.clone()
    const endT = new THREE.Vector3(p.x, p.y, p.z)
    const endP = new THREE.Vector3(p.x + dist, p.y + dist * 0.8, p.z + dist)
    let t = 0

    const step = () => {
      t += 0.055
      const e = t < 1 ? 1 - Math.pow(1 - t, 3) : 1
      ctr.target.lerpVectors(startT, endT, e)
      cam.position.lerpVectors(startP, endP, e)
      ctr.update()
      if (t < 1) requestAnimationFrame(step)
    }
    step()
  }, [setSelectedBh])

  // ── 3D 시추공 클릭 → 테이블 선택 동기화 ─────────────────────────────────
  // Raycaster로 클릭된 실린더의 userData.bhId를 읽어 focusBorehole 호출
  // 드래그(OrbitControls 회전)와 클릭을 구분하기 위해 pointerdown 위치 추적
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const raycaster = new THREE.Raycaster()
    let clickStart = { x: 0, y: 0 }
    let lastPointerUpAt = 0
    let hoveredId: string | null = null

    const applyHover = (nextId: string | null) => {
      hoveredId = nextId
      for (const child of bhGroupRef.current?.children ?? []) {
        const id = String(child.userData.bhId ?? "")
        const isHovered = nextId !== null && id === nextId
        const isSelected = selectedBh !== null && id === String(selectedBh)
        if (child.userData.isBoreholeLabel) {
          const material = (child as THREE.Sprite).material as THREE.SpriteMaterial
          material.color.setHex(isSelected ? 0xffc928 : isHovered ? 0x67e8f9 : 0xffffff)
          material.needsUpdate = true
        } else if (child.userData.isBoreholeTopMarker) {
          const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
          material.color.setHex(isHovered ? 0x06b6d4 : child.userData.baseColor)
          material.needsUpdate = true
        }
      }
      container.style.cursor = nextId ? "pointer" : ""
    }

    const resolveHoverId = (e: PointerEvent) => {
      if (e.buttons !== 0) return null
      const cam = cameraRef.current
      const bhGroup = bhGroupRef.current
      if (!cam || !bhGroup || !bhGroup.visible) return null
      const rect = rendererRef.current?.domElement.getBoundingClientRect() ?? container.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new THREE.Vector2(x, y), cam)
      const directHit = raycaster.intersectObjects(bhGroup.children, false)
        .find((hit: THREE.Intersection) => hit.object.userData.bhId)
      if (directHit) return String(directHit.object.userData.bhId)

      const world = new THREE.Vector3()
      const projected = new THREE.Vector3()
      let nearestId: string | null = null
      const hoverRadius = pickMode === "virtual-copy" ? 48 : 28
      let nearestDistanceSq = hoverRadius * hoverRadius
      for (const child of bhGroup.children) {
        if (!child.userData.isBoreholeLabel || !child.visible) continue
        child.getWorldPosition(world)
        projected.copy(world).project(cam)
        if (projected.z < -1 || projected.z > 1) continue
        const screenX = rect.left + (projected.x + 1) * rect.width / 2
        const screenY = rect.top + (1 - projected.y) * rect.height / 2
        const distanceSq = (e.clientX - screenX) ** 2 + (e.clientY - screenY) ** 2
        if (distanceSq < nearestDistanceSq) {
          nearestDistanceSq = distanceSq
          nearestId = String(child.userData.bhId)
        }
      }
      return nearestId
    }

    const onPointerDown = (e: PointerEvent) => {
      clickStart = { x: e.clientX, y: e.clientY }
    }

    const handleSelection = (e: MouseEvent) => {
      if (pickMode === "section") return
      // 미세한 손떨림은 클릭으로 인정하고, 명확한 드래그만 무시한다.
      const dx = e.clientX - clickStart.x
      const dy = e.clientY - clickStart.y
      if (dx * dx + dy * dy > 36) return

      const cam = cameraRef.current
      const bhGroup = bhGroupRef.current
      if (!cam || !bhGroup || !bhGroup.visible) return

      const rect = rendererRef.current?.domElement.getBoundingClientRect() ?? container.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width)  * 2 - 1
      const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1

      raycaster.setFromCamera(new THREE.Vector2(x, y), cam)

      const selectBorehole = (rawId: unknown) => {
        const bhId = String(rawId ?? "")
        if (!bhId) return false
        if (pickMode === "virtual-copy" && onBoreholePick) {
          onBoreholePick(bhId)
        } else {
          focusBorehole(bhId)
        }
        return true
      }

      // 사용자가 색상으로 확인한 호버 대상과 클릭 결과를 항상 일치시킨다.
      if (hoveredId && selectBorehole(hoveredId)) return

      sceneRef.current?.updateMatrixWorld(true)
      cam.updateMatrixWorld(true)

      const toScreen = (point: THREE.Vector3) => {
        const projected = point.clone().project(cam)
        return {
          x: rect.left + (projected.x + 1) * rect.width / 2,
          y: rect.top + (1 - projected.y) * rect.height / 2,
          z: projected.z,
        }
      }
      const labelCandidates: Array<{ id: unknown; distanceSq: number; z: number }> = []
      const nearestCandidates: Array<{ id: unknown; distanceSq: number; z: number }> = []
      const center = new THREE.Vector3()
      const scale = new THREE.Vector3()
      const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
      const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion)

      for (const child of bhGroup.children) {
        if (!child.userData.isBoreholeLabel || !child.visible) continue
        child.getWorldPosition(center)
        child.getWorldScale(scale)
        const centerScreen = toScreen(center)
        if (centerScreen.z < -1 || centerScreen.z > 1) continue

        const halfRight = cameraRight.clone().multiplyScalar(scale.x / 2)
        const halfUp = cameraUp.clone().multiplyScalar(scale.y / 2)
        const corners = [
          toScreen(center.clone().add(halfRight).add(halfUp)),
          toScreen(center.clone().add(halfRight).sub(halfUp)),
          toScreen(center.clone().sub(halfRight).add(halfUp)),
          toScreen(center.clone().sub(halfRight).sub(halfUp)),
        ]
        const minX = Math.min(...corners.map((point) => point.x)) - 5
        const maxX = Math.max(...corners.map((point) => point.x)) + 5
        const minY = Math.min(...corners.map((point) => point.y)) - 5
        const maxY = Math.max(...corners.map((point) => point.y)) + 5
        const distanceSq = (e.clientX - centerScreen.x) ** 2 + (e.clientY - centerScreen.y) ** 2
        const candidate = { id: child.userData.bhId, distanceSq, z: centerScreen.z }
        nearestCandidates.push(candidate)
        if (e.clientX >= minX && e.clientX <= maxX && e.clientY >= minY && e.clientY <= maxY) {
          labelCandidates.push(candidate)
        }
      }

      // 공명 박스 내부 후보를 가장 먼저 선택한다. 겹친 경우 클릭점에 더
      // 가까운 라벨, 거리가 같으면 카메라에 가까운 라벨을 우선한다.
      labelCandidates.sort((a, b) => a.distanceSq - b.distanceSq || a.z - b.z)
      if (labelCandidates.length > 0 && selectBorehole(labelCandidates[0].id)) return

      // 라벨 외에는 상단 마커와 시추공 기둥의 실제 교차만 인정한다.
      const hits = raycaster.intersectObjects(
        bhGroup.children.filter((child: THREE.Object3D) => !child.userData.isBoreholeLabel),
        false,
      )
      if (hits.length > 0 && selectBorehole(hits[0].object.userData.bhId)) return

      // 마지막 보조 판정은 최대 28px까지만 허용한다.
      nearestCandidates.sort((a, b) => a.distanceSq - b.distanceSq || a.z - b.z)
      const nearest = nearestCandidates[0]
      if (nearest && nearest.distanceSq <= 28 * 28 && selectBorehole(nearest.id)) return

      if (pickMode !== "virtual-copy") {
        // 빈 공간 클릭 → 일반 선택만 해제한다. 복사 모드는 계속 유지한다.
        setSelectedBh(null)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      lastPointerUpAt = Date.now()
      handleSelection(e)
    }
    const onClick = (e: MouseEvent) => {
      // 일부 브라우저/입력장치는 pointerup 대신 click만 안정적으로 전달한다.
      if (Date.now() - lastPointerUpAt > 200) {
        clickStart = { x: e.clientX, y: e.clientY }
        handleSelection(e)
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (pickMode !== "virtual-copy") return
      const nextId = resolveHoverId(e)
      if (nextId !== hoveredId) applyHover(nextId)
    }
    const onPointerLeave = () => applyHover(null)

    container.addEventListener("pointerdown", onPointerDown, true)
    container.addEventListener("pointerup", onPointerUp, true)
    container.addEventListener("pointermove", onPointerMove, true)
    container.addEventListener("pointerleave", onPointerLeave, true)
    container.addEventListener("click", onClick, true)
    return () => {
      applyHover(null)
      container.removeEventListener("pointerdown", onPointerDown, true)
      container.removeEventListener("pointerup", onPointerUp, true)
      container.removeEventListener("pointermove", onPointerMove, true)
      container.removeEventListener("pointerleave", onPointerLeave, true)
      container.removeEventListener("click", onClick, true)
    }
  }, [containerRef, rendererRef, cameraRef, focusBorehole, onBoreholePick, pickMode, setSelectedBh])

  return {
    focusBorehole,
    dimsRef,
    smoothMeshRef,
    voxelMeshRef,
    drapeRef,
    bhGroupRef,
    markerRef,
    stratumGroupRef,
    authoritativeTerrain,
  }
}
