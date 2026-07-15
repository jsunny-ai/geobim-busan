import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react"
import * as THREE from "three"
// @ts-ignore
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import {
  createVerticalPlane,
  getSectionAzimuth,
  getSectionDirection,
  getSectionLengthM,
  getSectionNormal,
  isValidSectionLine,
  modelOffsetFromMeters,
} from "@/lib/sectionPlane"
import { DEFAULT_SECTION_FLIPPED } from "@/lib/sectionDefaults"
import {
  projectPointToSection,
  SECTION_BOREHOLE_RIBBON_DEPTH_TEST,
  shouldShowOriginalBoreholeChild,
} from "@/lib/sectionBoreholeProjection"
import type { SectionPoint, VerticalSectionState } from "@/lib/types"

const SHOW_SECTION_HELPER = false

interface SectionTargets {
  smoothMeshRef: RefObject<Record<string, THREE.Mesh>>
  voxelMeshRef: RefObject<Record<string, THREE.Mesh>>
  drapeRef: RefObject<THREE.Mesh | null>
  bhGroupRef: RefObject<THREE.Group | null>
  markerRef: RefObject<THREE.Mesh | null>
  stratumGroupRef: RefObject<THREE.Group | null>
  groundwaterGroupRef: RefObject<THREE.Group | null>
  dimsRef: RefObject<{ boxW: number; boxD: number; lngWidthM: number; latWidthM: number; mScale: number }>
}

interface UseSectionPlaneArgs {
  sceneRef: RefObject<THREE.Scene | null>
  rendererRef: RefObject<THREE.WebGLRenderer | null>
  cameraRef: RefObject<THREE.PerspectiveCamera | null>
  controlsRef: RefObject<OrbitControls | null>
  containerRef: RefObject<HTMLDivElement | null>
  targets: SectionTargets
  state: VerticalSectionState
  setState: React.Dispatch<React.SetStateAction<VerticalSectionState>>
  verticalExag: number
  boreholeColumnsVisible: boolean
  groundwaterVisible: boolean
  setStatus: (message: string) => void
}

const setObjectClipping = (object: THREE.Object3D | null, planes: THREE.Plane[] | null) => {
  object?.traverse((child) => {
    const renderable = child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }
    if (!renderable.material) return
    const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material]
    for (const material of materials) {
      const currentPlane = material.clippingPlanes?.[0] ?? null
      const nextPlane = planes?.[0] ?? null
      if (currentPlane === nextPlane && Boolean(material.clippingPlanes) === Boolean(planes)) continue
      material.clippingPlanes = planes
      material.clipIntersection = false
      material.needsUpdate = true
    }
  })
}

const isEffectivelyVisible = (object: THREE.Object3D | null) => {
  let current = object
  while (current) {
    if (!current.visible) return false
    current = current.parent
  }
  return true
}

const groundwaterSectionSources = (group: THREE.Group | null, enabled: boolean) => {
  if (!enabled || !group || !isEffectivelyVisible(group)) return []
  const sources: THREE.Mesh[] = []
  group.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || mesh.name !== "groundwaterSolid" || !mesh.geometry || !mesh.material) return
    sources.push(mesh)
  })
  return sources
}

const planeSignature = (plane: THREE.Plane) =>
  `${plane.normal.x.toFixed(6)},${plane.normal.y.toFixed(6)},${plane.normal.z.toFixed(6)},${plane.constant.toFixed(6)}`

const boreholeSectionSources = (group: THREE.Group | null, enabled: boolean, plane: THREE.Plane) => {
  if (!enabled || !group || !isEffectivelyVisible(group)) return []
  const sources: THREE.Mesh[] = []
  const center = new THREE.Vector3()
  const worldScale = new THREE.Vector3()
  group.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.userData.isBoreholeColumn || !mesh.geometry || !mesh.material || !isEffectivelyVisible(mesh)) return
    mesh.updateWorldMatrix(true, false)
    mesh.getWorldPosition(center)
    mesh.getWorldScale(worldScale)
    const localRadius = Number(mesh.userData.sectionCapRadius)
    if (!Number.isFinite(localRadius) || localRadius <= 0) return
    const worldRadius = localRadius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.z))
    if (Math.abs(plane.distanceToPoint(center)) <= worldRadius + 1e-7) sources.push(mesh)
  })
  return sources
}

const addGroundwaterSectionLines = (
  group: THREE.Group,
  groundwaterMeshes: THREE.Mesh[],
  plane: THREE.Plane,
) => {
  const points: THREE.Vector3[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const intersection = new THREE.Vector3()

  const addTriangleIntersections = (vertices: THREE.Vector3[]) => {
    const intersections: THREE.Vector3[] = []
    for (let i = 0; i < 3; i++) {
      const start = vertices[i]
      const end = vertices[(i + 1) % 3]
      const startDistance = plane.distanceToPoint(start)
      const endDistance = plane.distanceToPoint(end)
      if (Math.abs(startDistance) < 1e-6) intersections.push(start.clone())
      if (startDistance * endDistance < 0) {
        const t = startDistance / (startDistance - endDistance)
        intersections.push(intersection.copy(start).lerp(end, t).clone())
      } else if (Math.abs(endDistance) < 1e-6) {
        intersections.push(end.clone())
      }
    }
    const unique = intersections.filter((point, index) =>
      intersections.findIndex((other) => other.distanceToSquared(point) < 1e-10) === index
    )
    if (unique.length >= 2) {
      points.push(unique[0], unique[1])
    }
  }

  for (const mesh of groundwaterMeshes) {
    const geometry = mesh.geometry as THREE.BufferGeometry
    const position = geometry.getAttribute("position")
    const index = geometry.getIndex()
    const topIndexCount = Number(mesh.userData.groundwaterTopIndexCount ?? 0)
    if (!position || !index || topIndexCount <= 0) continue
    mesh.updateWorldMatrix(true, false)
    const count = Math.min(topIndexCount, index.count)
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, index.getX(i)).applyMatrix4(mesh.matrixWorld)
      b.fromBufferAttribute(position, index.getX(i + 1)).applyMatrix4(mesh.matrixWorld)
      c.fromBufferAttribute(position, index.getX(i + 2)).applyMatrix4(mesh.matrixWorld)
      // Skip degenerate triangles; they can create zero-length dash segments.
      if (tmp.copy(b).sub(a).cross(c.clone().sub(a)).lengthSq() < 1e-12) continue
      addTriangleIntersections([a, b, c])
    }
  }

  if (points.length < 2) return
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineDashedMaterial({
    color: 0x0891b2,
    dashSize: 0.0018,
    gapSize: 0.0012,
    linewidth: 1,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  })
  const line = new THREE.LineSegments(geometry, material)
  line.name = "groundwater-section-dashed-line"
  line.userData.ownsSectionCapGeometry = true
  line.computeLineDistances()
  line.renderOrder = 2600
  group.add(line)
}

export function useSectionPlane({
  sceneRef,
  rendererRef,
  cameraRef,
  controlsRef,
  containerRef,
  targets,
  state,
  setState,
  verticalExag,
  boreholeColumnsVisible,
  groundwaterVisible,
  setStatus,
}: UseSectionPlaneArgs) {
  const planeRef = useRef<THREE.Plane | null>(null)
  const helperGroupRef = useRef<THREE.Group | null>(null)
  const capGroupRef = useRef<THREE.Group | null>(null)
  const sectionBoreholeGroupRef = useRef<THREE.Group | null>(null)
  const sectionBoreholeIdsRef = useRef<Set<string>>(new Set())
  const placementPreviewGroupRef = useRef<THREE.Group | null>(null)
  const placementStartYRef = useRef(0)
  const capSourceSignatureRef = useRef("")
  const sectionBoreholeSignatureRef = useRef("")
  const boundaryRefreshTimerRef = useRef<number | null>(null)
  const capRefreshTimerRef = useRef<number | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const hasSection = state.enabled && isValidSectionLine(state.start, state.end)
  const metrics = useMemo(() => {
    if (!state.start || !state.end || !isValidSectionLine(state.start, state.end)) {
      return { azimuth: 0, lengthM: 0 }
    }
    return {
      azimuth: getSectionAzimuth(state.start, state.end),
      lengthM: getSectionLengthM(state.start, state.end, targets.dimsRef.current?.mScale || 1),
    }
  }, [state.start, state.end, targets.dimsRef])

  const applyBoreholeSectionVisibility = useCallback(() => {
    const group = targets.bhGroupRef.current
    if (!group) return
    group.visible = boreholeColumnsVisible
    const plane = hasSection && stateRef.current.clipBoreholes ? planeRef.current : null
    const worldPosition = new THREE.Vector3()
    const tolerance = Math.max(Math.hypot(targets.dimsRef.current.boxW, targets.dimsRef.current.boxD) * 1e-7, 1e-7)
    group.updateWorldMatrix(true, true)
    for (const child of group.children) {
      const boreholeId = String(child.userData.bhId ?? "")
      child.getWorldPosition(worldPosition)
      child.visible = shouldShowOriginalBoreholeChild({
        boreholeColumnsVisible,
        sectionActive: Boolean(plane),
        clipBoreholes: stateRef.current.clipBoreholes,
        isSectionBorehole: Boolean(boreholeId && sectionBoreholeIdsRef.current.has(boreholeId)),
        isLabel: Boolean(child.userData.isBoreholeLabel),
        signedDistanceModel: plane?.distanceToPoint(worldPosition) ?? 0,
        toleranceModel: tolerance,
      })
    }
  }, [boreholeColumnsVisible, hasSection, targets.bhGroupRef, targets.dimsRef])

  const clearHelper = useCallback(() => {
    const group = helperGroupRef.current
    if (!group) return
    group.parent?.remove(group)
    group.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose()
    })
    helperGroupRef.current = null
  }, [])

  const clearCaps = useCallback(() => {
    const group = capGroupRef.current
    if (!group) return
    group.parent?.remove(group)
    group.traverse((object) => {
      const mesh = object as THREE.Mesh
      // Stencil clones share the source geometry; only cap planes own theirs.
      if (mesh.userData.ownsSectionCapGeometry) mesh.geometry?.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose()
    })
    capGroupRef.current = null
    capSourceSignatureRef.current = ""
  }, [])

  const clearSectionBoreholes = useCallback(() => {
    const group = sectionBoreholeGroupRef.current
    sectionBoreholeSignatureRef.current = ""
    sectionBoreholeIdsRef.current.clear()
    if (!group) return
    group.parent?.remove(group)
    group.traverse((object) => {
      const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
      renderable.geometry?.dispose()
      const material = renderable.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose()
    })
    sectionBoreholeGroupRef.current = null
  }, [])

  const updateSectionBoreholeLabelScales = useCallback(() => {
    const group = sectionBoreholeGroupRef.current
    const camera = cameraRef.current
    if (!group || !camera) return
    const { boxW, boxD } = targets.dimsRef.current
    const referenceDistance = Math.max(boxW, boxD) * 1.35
    if (!Number.isFinite(referenceDistance) || referenceDistance <= 0) return
    const worldPosition = new THREE.Vector3()
    for (const child of group.children) {
      if (!child.name.startsWith("section-borehole-label-")) continue
      child.getWorldPosition(worldPosition)
      const distance = camera.position.distanceTo(worldPosition)
      const targetFactor = Math.max(0.18, Math.min(1.15, distance / referenceDistance))
      const sourceFactor = Number(child.userData.sourceCameraScaleFactor) || 1
      const scale = targetFactor / sourceFactor
      child.scale.set(scale, scale, 1)
    }
  }, [cameraRef, targets.dimsRef])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    controls.addEventListener("change", updateSectionBoreholeLabelScales)
    updateSectionBoreholeLabelScales()
    return () => controls.removeEventListener("change", updateSectionBoreholeLabelScales)
  }, [controlsRef, updateSectionBoreholeLabelScales])

  const clearPlacementPreview = useCallback(() => {
    const group = placementPreviewGroupRef.current
    if (!group) return
    group.parent?.remove(group)
    group.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose()
    })
    placementPreviewGroupRef.current = null
  }, [])

  const drawPlacementPreview = useCallback((start: SectionPoint, end: SectionPoint | null, startY: number, endY = startY) => {
    const scene = sceneRef.current
    if (!scene) return
    clearPlacementPreview()

    const dims = targets.dimsRef.current
    const size = Math.max(Math.max(dims.boxW, dims.boxD) * 0.0027, 0.006)
    const lift = size * 1.8
    const group = new THREE.Group()
    group.name = "vertical-section-placement-preview"

    const pointGeometry = new THREE.SphereGeometry(size, 18, 12)
    const startMarker = new THREE.Mesh(
      pointGeometry,
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false, depthWrite: false }),
    )
    startMarker.position.set(start.x, startY + lift, start.z)
    startMarker.renderOrder = 2500
    group.add(startMarker)

    if (end) {
      const endMarker = new THREE.Mesh(
        pointGeometry.clone(),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false, depthWrite: false }),
      )
      endMarker.position.set(end.x, endY + lift, end.z)
      endMarker.renderOrder = 2500
      group.add(endMarker)

      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(start.x, startY + lift, start.z),
        new THREE.Vector3(end.x, endY + lift, end.z),
      ])
      const line = new THREE.Line(
        lineGeometry,
        new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false }),
      )
      line.renderOrder = 2501
      group.add(line)
    }

    scene.add(group)
    placementPreviewGroupRef.current = group
  }, [clearPlacementPreview, sceneRef, targets.dimsRef])

  const buildSectionBoreholes = useCallback((start: SectionPoint, end: SectionPoint, plane: THREE.Plane) => {
    const scene = sceneRef.current
    const sourceGroup = targets.bhGroupRef.current
    const current = stateRef.current
    if (!scene || !sourceGroup || !boreholeColumnsVisible || !current.clipBoreholes) {
      clearSectionBoreholes()
      return
    }

    const sourceColumns = sourceGroup.children.filter((child) => child.userData.isBoreholeColumn) as THREE.Mesh[]
    const signature = [
      sourceGroup.uuid,
      planeSignature(plane),
      `${start.x.toFixed(6)},${start.z.toFixed(6)},${end.x.toFixed(6)},${end.z.toFixed(6)}`,
      verticalExag.toFixed(3),
      ...sourceColumns.map((source) => `${source.uuid}:${String(source.userData.sectionCapSignature ?? "")}`),
    ].join("|")
    if (sectionBoreholeGroupRef.current && sectionBoreholeSignatureRef.current === signature) return

    clearSectionBoreholes()
    const dims = targets.dimsRef.current
    const group = new THREE.Group()
    group.name = "vertical-section-borehole-projections"
    const projectedBoreholePositions = new Map<string, { x: number; z: number }>()
    const projectedBoreholeOutlines = new Map<string, {
      x: number
      z: number
      radius: number
      minY: number
      maxY: number
    }>()
    const worldCenter = new THREE.Vector3()
    const worldScale = new THREE.Vector3()
    const planeQuaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      plane.normal,
    )
    const surfaceEpsilon = Math.max(Math.hypot(dims.boxW, dims.boxD) * 1e-5, 1e-5)

    for (const source of sourceColumns) {
      source.updateWorldMatrix(true, false)
      source.getWorldPosition(worldCenter)
      source.getWorldScale(worldScale)
      const localRadius = Number(source.userData.sectionCapRadius)
      const localHeight = Number(source.userData.sectionCapHeight)
      if (!Number.isFinite(localRadius) || !Number.isFinite(localHeight)) continue
      const radius = localRadius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.z))
      const height = localHeight * Math.abs(worldScale.y)
      if (radius <= 0 || height <= 0) continue

      const projection = projectPointToSection({
        point: { x: worldCenter.x, y: worldCenter.y, z: worldCenter.z },
        start,
        end,
        planeNormal: { x: plane.normal.x, z: plane.normal.z },
        planeConstant: plane.constant,
        // Only a borehole cylinder physically intersected by the section is
        // drawn on the section. Nearby holes must not be pulled forward.
        maxDistanceModel: radius + surfaceEpsilon,
        chainageMarginModel: radius,
      })
      if (!projection) continue

      const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material
      const color = "color" in sourceMaterial
        ? (sourceMaterial as THREE.Material & { color: THREE.Color }).color.clone()
        : new THREE.Color(0x374151)
      const geometry = new THREE.PlaneGeometry(radius * 2, height)
      const material = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        depthTest: SECTION_BOREHOLE_RIBBON_DEPTH_TEST,
        depthWrite: false,
      })
      const ribbon = new THREE.Mesh(geometry, material)
      ribbon.name = "section-borehole-ribbon"
      ribbon.userData.bhId = source.userData.bhId
      ribbon.userData.isSectionBoreholeProjection = true
      ribbon.position.set(projection.point.x, projection.point.y, projection.point.z)
      ribbon.position.addScaledVector(plane.normal, surfaceEpsilon)
      ribbon.quaternion.copy(planeQuaternion)
      ribbon.renderOrder = 2450
      group.add(ribbon)

      const boreholeId = String(source.userData.bhId)
      sectionBoreholeIdsRef.current.add(boreholeId)
      projectedBoreholePositions.set(boreholeId, {
        x: projection.point.x,
        z: projection.point.z,
      })
      const segmentMinY = projection.point.y - height / 2
      const segmentMaxY = projection.point.y + height / 2
      const outline = projectedBoreholeOutlines.get(boreholeId)
      if (outline) {
        outline.radius = Math.max(outline.radius, radius)
        outline.minY = Math.min(outline.minY, segmentMinY)
        outline.maxY = Math.max(outline.maxY, segmentMaxY)
      } else {
        projectedBoreholeOutlines.set(boreholeId, {
          x: projection.point.x,
          z: projection.point.z,
          radius,
          minY: segmentMinY,
          maxY: segmentMaxY,
        })
      }
    }

    const sectionDirection = new THREE.Vector3(end.x - start.x, 0, end.z - start.z).normalize()
    for (const [boreholeId, outline] of projectedBoreholeOutlines) {
      const center = new THREE.Vector3(outline.x, 0, outline.z)
      const left = center.clone().addScaledVector(sectionDirection, -outline.radius)
      const right = center.clone().addScaledVector(sectionDirection, outline.radius)
      const points = [
        new THREE.Vector3(left.x, outline.minY, left.z),
        new THREE.Vector3(left.x, outline.maxY, left.z),
        new THREE.Vector3(right.x, outline.minY, right.z),
        new THREE.Vector3(right.x, outline.maxY, right.z),
        new THREE.Vector3(left.x, outline.maxY, left.z),
        new THREE.Vector3(right.x, outline.maxY, right.z),
        new THREE.Vector3(left.x, outline.minY, left.z),
        new THREE.Vector3(right.x, outline.minY, right.z),
      ]
      for (const point of points) point.addScaledVector(plane.normal, surfaceEpsilon * 3)
      const outlineLine = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({
          color: 0x1f2937,
          transparent: true,
          opacity: 0.78,
          depthTest: false,
          depthWrite: false,
        }),
      )
      outlineLine.name = "section-borehole-column-outline"
      outlineLine.userData.bhId = boreholeId
      outlineLine.userData.isSectionBoreholeProjection = true
      outlineLine.renderOrder = 2451
      group.add(outlineLine)
    }

    for (const child of sourceGroup.children) {
      const boreholeId = String(child.userData.bhId)
      const projectedPosition = projectedBoreholePositions.get(boreholeId)
      if (!child.userData.isBoreholeLabel || !projectedPosition) continue
      const source = child as THREE.Sprite
      source.updateWorldMatrix(true, false)
      source.getWorldPosition(worldCenter)
      source.getWorldScale(worldScale)

      const sourceMaterial = source.material as THREE.SpriteMaterial
      const width = Math.max(Math.abs(worldScale.x), surfaceEpsilon * 8)
      const height = Math.max(Math.abs(worldScale.y), surfaceEpsilon * 4)
      const referenceDistance = Math.max(dims.boxW, dims.boxD) * 1.35
      const sourceDistance = cameraRef.current?.position.distanceTo(worldCenter) ?? referenceDistance
      const sourceCameraScaleFactor = Math.max(0.55, Math.min(1.15, sourceDistance / referenceDistance))
      const frontGeometry = new THREE.PlaneGeometry(width, height)
      const backGeometry = new THREE.PlaneGeometry(width, height)
      const backUvs = backGeometry.getAttribute("uv") as THREE.BufferAttribute
      for (let index = 0; index < backUvs.count; index++) {
        backUvs.setX(index, 1 - backUvs.getX(index))
      }
      backUvs.needsUpdate = true

      const addLabelFace = (geometry: THREE.PlaneGeometry, side: THREE.Side, face: "front" | "back") => {
        const material = new THREE.MeshBasicMaterial({
          map: sourceMaterial.map ?? undefined,
          color: sourceMaterial.color.clone(),
          transparent: true,
          alphaTest: 0.04,
          side,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        })
        const label = new THREE.Mesh(geometry, material)
        label.name = `section-borehole-label-${face}`
        label.userData.bhId = source.userData.bhId
        label.userData.isSectionBoreholeProjection = true
        label.userData.sourceCameraScaleFactor = sourceCameraScaleFactor
        label.position.set(projectedPosition.x, worldCenter.y, projectedPosition.z)
        label.position.addScaledVector(plane.normal, surfaceEpsilon * 3)
        label.quaternion.copy(planeQuaternion)
        label.renderOrder = 2452
        group.add(label)
      }
      addLabelFace(frontGeometry, THREE.FrontSide, "front")
      addLabelFace(backGeometry, THREE.BackSide, "back")
    }

    if (group.children.length === 0) {
      sectionBoreholeGroupRef.current = group
      sectionBoreholeSignatureRef.current = signature
      return
    }
    scene.add(group)
    sectionBoreholeGroupRef.current = group
    sectionBoreholeSignatureRef.current = signature
    updateSectionBoreholeLabelScales()
  }, [
    boreholeColumnsVisible,
    cameraRef,
    clearSectionBoreholes,
    sceneRef,
    targets.bhGroupRef,
    targets.dimsRef,
    updateSectionBoreholeLabelScales,
    verticalExag,
  ])

  const buildCaps = useCallback((plane: THREE.Plane) => {
    const scene = sceneRef.current
    if (!scene) return

    const stratumMeshes = [
      ...Object.values(targets.smoothMeshRef.current ?? {}),
      ...Object.values(targets.voxelMeshRef.current ?? {}),
    ].filter((mesh) => isEffectivelyVisible(mesh))
    const boreholeMeshes = boreholeSectionSources(
      targets.bhGroupRef.current,
      stateRef.current.clipBoreholes,
      plane,
    )
    const groundwaterMeshes = groundwaterSectionSources(targets.groundwaterGroupRef.current, groundwaterVisible)
    const sources = [...stratumMeshes]
      .filter((mesh) => mesh.geometry && mesh.material)
    const signature = sources
      .map((mesh) => `${mesh.uuid}:${mesh.visible}:${String(mesh.userData.sectionCapSignature ?? "")}`)
      .concat(boreholeMeshes.map((mesh) => `bh:${mesh.uuid}:${mesh.visible}:${String(mesh.userData.sectionCapSignature ?? "")}`))
      .concat(groundwaterMeshes.map((mesh) => `gw:${mesh.uuid}:${mesh.visible}:${String(mesh.userData.sectionCapSignature ?? "")}`))
      .concat(planeSignature(plane))
      .join("|")
    if (sources.length === 0 && boreholeMeshes.length === 0 && groundwaterMeshes.length === 0) {
      clearCaps()
      return
    }

    const dims = targets.dimsRef.current
    const capSize = Math.max(Math.hypot(dims.boxW, dims.boxD) * 2.2, 4)
    const capHeight = capSize * Math.max(1.5, verticalExag)
    const center = plane.coplanarPoint(new THREE.Vector3())
    if (capGroupRef.current && capSourceSignatureRef.current === signature) {
      const sourcesByUuid = new Map(sources.map((source) => [source.uuid, source]))
      capGroupRef.current.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.name === "section-cap-face") {
          mesh.position.copy(center)
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
        } else if (mesh.name === "section-cap-stencil") {
          const source = sourcesByUuid.get(String(mesh.userData.sectionCapSourceUuid))
          if (source) {
            source.updateWorldMatrix(true, false)
            mesh.matrix.copy(source.matrixWorld)
          }
        }
      })
      return
    }

    clearCaps()
    const group = new THREE.Group()
    group.name = "vertical-section-caps"
    const capGeometry = sources.length > 0 ? new THREE.PlaneGeometry(capSize, capHeight) : null

    sources.forEach((source, index) => {
      source.updateWorldMatrix(true, false)
      const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material
      const color = "color" in sourceMaterial
        ? (sourceMaterial as THREE.Material & { color: THREE.Color }).color.clone()
        : new THREE.Color(0x8b7355)
      const sourceMap = "map" in sourceMaterial
        ? (sourceMaterial as THREE.Material & { map?: THREE.Texture | null }).map ?? null
        : null
      const sectionCapMap = source.userData.sectionCapMap as THREE.Texture | null | undefined
      const map = sectionCapMap ?? sourceMap
      const baseOrder = 2000 + index * 3

      const makeStencilClone = (side: THREE.Side, operation: THREE.StencilOp) => {
        const material = new THREE.MeshBasicMaterial({
          colorWrite: false,
          depthWrite: false,
          depthTest: false,
          side,
          clippingPlanes: [plane],
          stencilWrite: true,
          stencilFunc: THREE.AlwaysStencilFunc,
          stencilFail: operation,
          stencilZFail: operation,
          stencilZPass: operation,
        })
        const clone = new THREE.Mesh(source.geometry, material)
        clone.name = "section-cap-stencil"
        clone.userData.sectionCapSourceUuid = source.uuid
        clone.matrixAutoUpdate = false
        clone.matrix.copy(source.matrixWorld)
        clone.renderOrder = baseOrder
        group.add(clone)
      }
      makeStencilClone(THREE.BackSide, THREE.IncrementWrapStencilOp)
      makeStencilClone(THREE.FrontSide, THREE.DecrementWrapStencilOp)

      const capMaterial = new THREE.MeshBasicMaterial({
        color: sectionCapMap ? 0xffffff : color,
        map: map ?? undefined,
        transparent: Boolean(sectionCapMap),
        alphaTest: sectionCapMap ? 0.08 : 0,
        opacity: 1,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      })
      const cap = new THREE.Mesh(capGeometry!, capMaterial)
      cap.name = "section-cap-face"
      cap.userData.ownsSectionCapGeometry = index === 0
      cap.position.copy(center)
      cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
      cap.renderOrder = baseOrder + 1
      cap.onAfterRender = (renderer) => renderer.clearStencil()
      group.add(cap)
    })

    // A borehole column is a vertical cylinder. Its intersection with a
    // vertical section plane is a small rectangle whose width is the cylinder
    // chord at that plane. Build that cap directly instead of reusing the
    // model-wide stencil plane, which can leak a large black quad when many
    // tiny cylinders share the stencil buffer.
    const worldCenter = new THREE.Vector3()
    const worldScale = new THREE.Vector3()
    const projectedCenter = new THREE.Vector3()
    boreholeMeshes.forEach((source, index) => {
      source.updateWorldMatrix(true, false)
      source.getWorldPosition(worldCenter)
      source.getWorldScale(worldScale)
      const localRadius = Number(source.userData.sectionCapRadius)
      const localHeight = Number(source.userData.sectionCapHeight)
      if (!Number.isFinite(localRadius) || !Number.isFinite(localHeight)) return
      const worldRadius = localRadius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.z))
      const worldHeight = localHeight * Math.abs(worldScale.y)
      const signedDistance = plane.distanceToPoint(worldCenter)
      const halfChordSq = worldRadius * worldRadius - signedDistance * signedDistance
      if (halfChordSq <= 1e-12 || worldHeight <= 1e-12) return
      const chordWidth = 2 * Math.sqrt(halfChordSq)
      projectedCenter.copy(worldCenter).addScaledVector(plane.normal, -signedDistance)

      const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material
      const color = "color" in sourceMaterial
        ? (sourceMaterial as THREE.Material & { color: THREE.Color }).color.clone()
        : new THREE.Color(0x8b7355)
      const geometry = new THREE.PlaneGeometry(chordWidth, worldHeight)
      const material = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const cap = new THREE.Mesh(geometry, material)
      cap.name = "borehole-section-cap-face"
      cap.userData.ownsSectionCapGeometry = true
      cap.position.copy(projectedCenter)
      cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
      cap.renderOrder = 2400 + index
      group.add(cap)
    })

    addGroundwaterSectionLines(group, groundwaterMeshes, plane)

    scene.add(group)
    capGroupRef.current = group
    capSourceSignatureRef.current = signature
  }, [
    clearCaps,
    sceneRef,
    targets.bhGroupRef,
    targets.dimsRef,
    targets.groundwaterGroupRef,
    targets.smoothMeshRef,
    targets.voxelMeshRef,
    verticalExag,
    groundwaterVisible,
  ])

  const buildHelper = useCallback((
    start: SectionPoint,
    end: SectionPoint,
    plane: THREE.Plane,
    sampleBoundary = false,
  ) => {
    clearHelper()
    const scene = sceneRef.current
    if (!scene || !SHOW_SECTION_HELPER) return

    const dims = targets.dimsRef.current
    const width = Math.max(Math.hypot(dims.boxW, dims.boxD) * 1.35, 1)
    const height = Math.max(dims.boxW, dims.boxD) * Math.max(1.5, verticalExag * 0.8)
    const center = new THREE.Vector3((start.x + end.x) / 2, 0, (start.z + end.z) / 2)
    const baseNormal = getSectionNormal(start, end, stateRef.current.flipped)
    const offsetModel = modelOffsetFromMeters(stateRef.current.offsetM, dims.mScale)
    const offsetVector = baseNormal.clone().multiplyScalar(offsetModel)
    center.add(offsetVector)

    const group = new THREE.Group()
    group.name = "vertical-section-helper"

    const planeMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        color: 0x0891b2,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    planeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
    planeMesh.position.copy(center)
    planeMesh.renderOrder = 900
    group.add(planeMesh)

    const direction = getSectionDirection(start, end)
    const half = width / 2
    const lineY = height / 2
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      center.clone().addScaledVector(direction, -half).setY(lineY),
      center.clone().addScaledVector(direction, half).setY(lineY),
    ])
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: 0x06b6d4, depthTest: false }),
    )
    line.renderOrder = 902
    group.add(line)

    const handleGeometry = new THREE.SphereGeometry(Math.max(width * 0.012, 0.018), 16, 12)
    const addHandle = (point: SectionPoint, color: number) => {
      const handle = new THREE.Mesh(
        handleGeometry.clone(),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      )
      handle.position.set(point.x, lineY, point.z)
      handle.position.addScaledVector(baseNormal, modelOffsetFromMeters(stateRef.current.offsetM, dims.mScale))
      handle.renderOrder = 903
      group.add(handle)
    }
    addHandle(start, 0x22d3ee)
    addHandle(end, 0xf59e0b)
    handleGeometry.dispose()

    const arrow = new THREE.ArrowHelper(
      plane.normal,
      center.clone().setY(0),
      Math.max(width * 0.12, 0.15),
      0xef4444,
      Math.max(width * 0.035, 0.04),
      Math.max(width * 0.02, 0.025),
    )
    arrow.renderOrder = 904
    group.add(arrow)

    // Cut boundary highlight: the section face color (LAYER_COLOR — natural
    // soil/rock tones) can visually blend into the drape's aerial-photo
    // texture right at the cut, since both are clipped by the same plane at
    // nearly the same height. Trace the real cut line by raycasting straight
    // down along the section segment against whatever surface is actually
    // on top (drape if shown, otherwise the exposed stratum/voxel meshes) and
    // draw it in a color no other helper element uses, so the boundary reads
    // clearly regardless of which layer color is exposed.
    const surfaceCandidates: THREE.Object3D[] = []
    const drape = targets.drapeRef.current
    if (drape?.visible) surfaceCandidates.push(drape)
    if (sampleBoundary && surfaceCandidates.length > 0) {
      const raycaster = new THREE.Raycaster()
      const down = new THREE.Vector3(0, -1, 0)
      const rayHeight = Math.max(dims.boxW, dims.boxD) * 2 + 50
      const sampleCount = 32
      const boundaryPoints: THREE.Vector3[] = []
      for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount
        const x = start.x + (end.x - start.x) * t + offsetVector.x
        const z = start.z + (end.z - start.z) * t + offsetVector.z
        raycaster.set(new THREE.Vector3(x, rayHeight, z), down)
        raycaster.far = rayHeight * 2
        const hits = raycaster.intersectObjects(surfaceCandidates, false)
        if (hits.length === 0) continue
        const topHit = hits.reduce((top, hit) => (hit.point.y > top.point.y ? hit : top))
        boundaryPoints.push(topHit.point)
      }
      if (boundaryPoints.length >= 2) {
        const boundaryGeometry = new THREE.BufferGeometry().setFromPoints(boundaryPoints)
        const boundaryLine = new THREE.Line(
          boundaryGeometry,
          new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false }),
        )
        boundaryLine.name = "section-cut-boundary"
        boundaryLine.renderOrder = 905
        group.add(boundaryLine)
      }
    }

    scene.add(group)
    helperGroupRef.current = group
  }, [clearHelper, sceneRef, targets.dimsRef, targets.drapeRef, targets.smoothMeshRef, targets.voxelMeshRef, verticalExag])

  useEffect(() => {
    const start = state.start
    const end = state.end
    let plane: THREE.Plane | null = null
    if (state.enabled && start && end && isValidSectionLine(start, end)) {
      const nextPlane = createVerticalPlane(
        start,
        end,
        modelOffsetFromMeters(state.offsetM, targets.dimsRef.current?.mScale || 1),
        state.flipped,
      )
      if (planeRef.current) planeRef.current.copy(nextPlane)
      else planeRef.current = nextPlane
      plane = planeRef.current
    } else {
      planeRef.current = null
    }
    const planes = plane ? [plane] : null

    for (const mesh of Object.values(targets.smoothMeshRef.current ?? {})) setObjectClipping(mesh, planes)
    for (const mesh of Object.values(targets.voxelMeshRef.current ?? {})) setObjectClipping(mesh, planes)
    setObjectClipping(targets.drapeRef.current, state.clipDrape ? planes : null)
    // Original borehole children are filtered explicitly below. In particular,
    // Sprite labels must not also be shader-clipped or the retained-side name
    // can disappear depending on the sprite clipping transform.
    setObjectClipping(targets.bhGroupRef.current, null)
    setObjectClipping(targets.markerRef.current, planes)
    setObjectClipping(targets.groundwaterGroupRef.current, planes)
    if (plane && start && end) {
      buildSectionBoreholes(start, end, plane)
      applyBoreholeSectionVisibility()
      buildHelper(start, end, plane, false)
      if (boundaryRefreshTimerRef.current !== null) {
        window.clearTimeout(boundaryRefreshTimerRef.current)
      }
      boundaryRefreshTimerRef.current = window.setTimeout(() => {
        const currentPlane = planeRef.current
        const current = stateRef.current
        if (currentPlane && current.start && current.end) {
          buildHelper(current.start, current.end, currentPlane, true)
        }
        boundaryRefreshTimerRef.current = null
      }, 160)
      if (capRefreshTimerRef.current !== null) {
        window.clearTimeout(capRefreshTimerRef.current)
      }
      capRefreshTimerRef.current = window.setTimeout(() => {
        const currentPlane = planeRef.current
        if (currentPlane) buildCaps(currentPlane)
        capRefreshTimerRef.current = null
      }, 120)
    } else {
      if (boundaryRefreshTimerRef.current !== null) {
        window.clearTimeout(boundaryRefreshTimerRef.current)
        boundaryRefreshTimerRef.current = null
      }
      if (capRefreshTimerRef.current !== null) {
        window.clearTimeout(capRefreshTimerRef.current)
        capRefreshTimerRef.current = null
      }
      clearHelper()
      clearCaps()
      clearSectionBoreholes()
      applyBoreholeSectionVisibility()
    }
  }, [
    buildHelper,
    buildCaps,
    buildSectionBoreholes,
    applyBoreholeSectionVisibility,
    clearCaps,
    clearHelper,
    clearSectionBoreholes,
    state.clipDrape,
    state.clipBoreholes,
    state.enabled,
    state.end,
    state.flipped,
    state.offsetM,
    state.start,
    groundwaterVisible,
    targets.bhGroupRef,
    targets.drapeRef,
    targets.dimsRef,
    targets.groundwaterGroupRef,
    targets.markerRef,
    targets.smoothMeshRef,
    targets.voxelMeshRef,
  ])

  // Newly generated meshes need the current plane even if the section state itself did not change.
  useEffect(() => {
    if (!hasSection) return
    const timer = window.setInterval(() => {
      const plane = planeRef.current
      if (!plane) return
      const planes = [plane]
      for (const mesh of Object.values(targets.smoothMeshRef.current ?? {})) {
        const material = mesh.material as THREE.Material
        if (material.clippingPlanes?.[0] !== plane) setObjectClipping(mesh, planes)
      }
      for (const mesh of Object.values(targets.voxelMeshRef.current ?? {})) {
        const material = mesh.material as THREE.Material
        if (material.clippingPlanes?.[0] !== plane) setObjectClipping(mesh, planes)
      }
      if (stateRef.current.clipDrape) setObjectClipping(targets.drapeRef.current, planes)
      setObjectClipping(targets.bhGroupRef.current, null)
      setObjectClipping(targets.markerRef.current, planes)
      setObjectClipping(targets.groundwaterGroupRef.current, planes)
      const current = stateRef.current
      if (current.start && current.end) buildSectionBoreholes(current.start, current.end, plane)
      applyBoreholeSectionVisibility()
      const activeStratumSources = [
        ...Object.values(targets.smoothMeshRef.current ?? {}),
        ...Object.values(targets.voxelMeshRef.current ?? {}),
      ].filter((mesh) => isEffectivelyVisible(mesh))
      const activeGroundwaterSources = groundwaterSectionSources(targets.groundwaterGroupRef.current, groundwaterVisible)
      const activeBoreholeSources = boreholeSectionSources(
        targets.bhGroupRef.current,
        stateRef.current.clipBoreholes,
        plane,
      )
      const signature = activeStratumSources
        .map((mesh) => `${mesh.uuid}:${mesh.visible}:${String(mesh.userData.sectionCapSignature ?? "")}`)
        .concat(activeBoreholeSources.map((mesh) => `bh:${mesh.uuid}:${mesh.visible}:${String(mesh.userData.sectionCapSignature ?? "")}`))
        .concat(activeGroundwaterSources.map((mesh) => `gw:${mesh.uuid}:${mesh.visible}:${String(mesh.userData.sectionCapSignature ?? "")}`))
        .concat(planeSignature(plane))
        .join("|")
      if (signature !== capSourceSignatureRef.current) {
        buildCaps(plane)
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [applyBoreholeSectionVisibility, buildCaps, buildSectionBoreholes, groundwaterVisible, hasSection, targets.bhGroupRef, targets.drapeRef, targets.groundwaterGroupRef, targets.markerRef, targets.smoothMeshRef, targets.voxelMeshRef])

  useEffect(() => {
    if (!state.enabled || (state.interactionMode !== "placing-start" && state.interactionMode !== "placing-end")) {
      clearPlacementPreview()
      return
    }
    const container = containerRef.current
    if (!container) return
    const raycaster = new THREE.Raycaster()
    const fallbackPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    let pointerDown = { x: 0, y: 0, at: 0 }

    const resolveWorldPoint = (event: PointerEvent) => {
      const camera = cameraRef.current
      if (!camera) return null
      const rect = rendererRef.current?.domElement.getBoundingClientRect() ?? container.getBoundingClientRect()
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)

      const drape = targets.drapeRef.current
      if (drape?.visible) {
        const drapeHit = raycaster.intersectObject(drape, false)[0]
        if (drapeHit) return drapeHit.point
      }

      const candidates = [
        ...Object.values(targets.smoothMeshRef.current ?? {}),
        ...Object.values(targets.voxelMeshRef.current ?? {}),
      ].filter((mesh) => mesh.visible)
      const hit = raycaster.intersectObjects(candidates, false)[0]
      return hit?.point ?? raycaster.ray.intersectPlane(fallbackPlane, new THREE.Vector3())
    }

    const onPointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY, at: performance.now() }
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return
      const dx = event.clientX - pointerDown.x
      const dy = event.clientY - pointerDown.y
      if (dx * dx + dy * dy > 25 || performance.now() - pointerDown.at > 500) return
      const worldPoint = resolveWorldPoint(event)
      if (!worldPoint) {
        setStatus("모델 영역 안에서 절단점을 선택하세요.")
        return
      }
      const point = { x: worldPoint.x, z: worldPoint.z }
      const current = stateRef.current
      if (current.interactionMode === "placing-start") {
        setState((previous) => ({
          ...previous,
          start: point,
          end: null,
          offsetM: 0,
          interactionMode: "placing-end",
        }))
        placementStartYRef.current = worldPoint.y
        drawPlacementPreview(point, null, worldPoint.y)
        setStatus("절단선의 끝점을 선택하세요.")
        return
      }
      if (!current.start || !isValidSectionLine(current.start, point, targets.dimsRef.current.mScale)) {
        setStatus("두 점이 너무 가깝습니다. 1m 이상 떨어진 위치를 선택하세요.")
        return
      }
      clearPlacementPreview()
      setState((previous) => ({ ...previous, end: point, interactionMode: "editing" }))
      setStatus("수직 단면이 생성되었습니다.")
    }
    const onPointerMove = (event: PointerEvent) => {
      const current = stateRef.current
      if (current.interactionMode !== "placing-end" || !current.start) return
      const worldPoint = resolveWorldPoint(event)
      if (!worldPoint) return
      drawPlacementPreview(
        current.start,
        { x: worldPoint.x, z: worldPoint.z },
        placementStartYRef.current,
        worldPoint.y,
      )
    }

    container.style.cursor = "crosshair"
    container.addEventListener("pointerdown", onPointerDown, true)
    container.addEventListener("pointerup", onPointerUp, true)
    container.addEventListener("pointermove", onPointerMove, true)
    return () => {
      container.style.cursor = ""
      container.removeEventListener("pointerdown", onPointerDown, true)
      container.removeEventListener("pointerup", onPointerUp, true)
      container.removeEventListener("pointermove", onPointerMove, true)
    }
  }, [
    cameraRef,
    clearPlacementPreview,
    containerRef,
    drawPlacementPreview,
    rendererRef,
    setState,
    setStatus,
    state.enabled,
    state.interactionMode,
    targets.dimsRef,
    targets.drapeRef,
    targets.smoothMeshRef,
    targets.voxelMeshRef,
  ])

  const focusSection = useCallback(() => {
    const current = stateRef.current
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!current.start || !current.end || !camera || !controls || !isValidSectionLine(current.start, current.end)) return
    const dims = targets.dimsRef.current
    const normal = getSectionNormal(current.start, current.end, current.flipped)
    const center = new THREE.Vector3(
      (current.start.x + current.end.x) / 2,
      0,
      (current.start.z + current.end.z) / 2,
    )
    center.addScaledVector(normal, modelOffsetFromMeters(current.offsetM, dims.mScale))
    const distance = Math.max(dims.boxW, dims.boxD) * 1.35
    camera.up.set(0, 1, 0)
    camera.position.copy(center).addScaledVector(normal, distance)
    controls.target.copy(center)
    camera.lookAt(center)
    controls.update()
  }, [cameraRef, controlsRef, targets.dimsRef])

  const redrawSection = useCallback(() => {
    setState((previous) => ({
      ...previous,
      enabled: true,
      interactionMode: "placing-start",
      start: null,
      end: null,
      offsetM: 0,
      flipped: DEFAULT_SECTION_FLIPPED,
    }))
    setStatus("절단선의 시작점을 선택하세요.")
  }, [setState, setStatus])

  const resetSection = useCallback(() => {
    setState((previous) => ({
      ...previous,
      enabled: false,
      interactionMode: "idle",
      start: null,
      end: null,
      offsetM: 0,
      flipped: DEFAULT_SECTION_FLIPPED,
    }))
    setStatus("수직 단면을 종료했습니다.")
  }, [setState, setStatus])

  useEffect(() => {
    if (!state.enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") return
      if (event.key === "Escape") {
        if (stateRef.current.interactionMode === "placing-end") {
          setState((previous) => ({ ...previous, start: null, interactionMode: "placing-start" }))
          setStatus("절단선의 시작점을 선택하세요.")
        } else {
          resetSection()
        }
      } else if (event.key.toLowerCase() === "f" && hasSection) {
        setState((previous) => ({ ...previous, flipped: !previous.flipped }))
      } else if (event.key.toLowerCase() === "c" && hasSection) {
        focusSection()
      } else if ((event.key === "[" || event.key === "]") && hasSection) {
        const step = event.shiftKey ? 10 : 1
        setState((previous) => ({
          ...previous,
          offsetM: previous.offsetM + (event.key === "]" ? step : -step),
        }))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [focusSection, hasSection, resetSection, setState, setStatus, state.enabled])

  useEffect(() => () => {
    if (boundaryRefreshTimerRef.current !== null) {
      window.clearTimeout(boundaryRefreshTimerRef.current)
      boundaryRefreshTimerRef.current = null
    }
    if (capRefreshTimerRef.current !== null) {
      window.clearTimeout(capRefreshTimerRef.current)
      capRefreshTimerRef.current = null
    }
    clearHelper()
    clearCaps()
    clearSectionBoreholes()
    clearPlacementPreview()
    const allTargets: THREE.Object3D[] = [
      ...Object.values(targets.smoothMeshRef.current ?? {}),
      ...Object.values(targets.voxelMeshRef.current ?? {}),
    ]
    if (targets.drapeRef.current) allTargets.push(targets.drapeRef.current)
    if (targets.bhGroupRef.current) allTargets.push(targets.bhGroupRef.current)
    if (targets.markerRef.current) allTargets.push(targets.markerRef.current)
    if (targets.groundwaterGroupRef.current) allTargets.push(targets.groundwaterGroupRef.current)
    allTargets.forEach((object) => setObjectClipping(object, null))
  }, [clearCaps, clearHelper, clearPlacementPreview, clearSectionBoreholes, targets.bhGroupRef, targets.drapeRef, targets.groundwaterGroupRef, targets.markerRef, targets.smoothMeshRef, targets.voxelMeshRef])

  return {
    hasSection,
    metrics,
    focusSection,
    redrawSection,
    resetSection,
  }
}
