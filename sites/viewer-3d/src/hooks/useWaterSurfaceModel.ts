import { useEffect, useRef, useState, type RefObject } from "react"
import * as THREE from "three"
import type { AuthoritativeTerrainGrid } from "@/lib/authoritativeTerrain"
import type { CoastalLandMask } from "@/lib/coastalLandMask"
import type { Bbox } from "@/lib/projection"
import { buildWaterSurfaceGeometry, type WaterSurfaceGeometryDiagnostic } from "@/lib/waterSurfaceGeometry"
import { buildWaterSurfaceMask } from "@/lib/waterSurfaceMask"
import { apiUrl } from "@shared/urls"

interface WaterSurfaceSettings {
  visible: boolean
  opacity: number
  verticalExag: number
}

const EMPTY_DIAGNOSTIC: WaterSurfaceGeometryDiagnostic & {
  waterFeatureCount: number
  status: string
} = {
  cellCount: 0,
  seaCellCount: 0,
  inlandWaterCellCount: 0,
  seaLevelM: 0,
  waterFeatureCount: 0,
  status: "not_configured",
}

export function useWaterSurfaceModel(
  sceneRef: RefObject<THREE.Scene | null>,
  bbox: Bbox | null,
  authoritativeTerrain: AuthoritativeTerrainGrid | null,
  coastalLandMask: CoastalLandMask | undefined,
  settings: WaterSurfaceSettings,
) {
  const groupRef = useRef<THREE.Group | null>(null)
  const [diagnostic, setDiagnostic] = useState(EMPTY_DIAGNOSTIC)

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !bbox || !authoritativeTerrain) return
    let cancelled = false
    const group = new THREE.Group()
    group.name = "waterSurfaceGroup"
    group.scale.y = settings.verticalExag
    group.visible = settings.visible
    scene.add(group)
    groupRef.current = group

    void (async () => {
      let payloadFeatures = []
      let status = "not_configured"
      try {
        const response = await fetch(apiUrl(`/api/v1/water-surfaces?bbox=${bbox.join(",")}`))
        if (response.ok) {
          const payload = await response.json()
          payloadFeatures = payload.features ?? []
          status = payload.status ?? "unknown"
        } else {
          status = `error_${response.status}`
        }
      } catch {
        status = "unavailable"
      }
      if (cancelled) return

      const waterMask = buildWaterSurfaceMask(payloadFeatures, authoritativeTerrain)
      const { geometry, diagnostic: geometryDiagnostic } = buildWaterSurfaceGeometry(
        bbox,
        authoritativeTerrain,
        waterMask,
        coastalLandMask,
      )
      if (geometryDiagnostic.cellCount > 0) {
        const material = new THREE.MeshStandardMaterial({
          color: 0x4fb3d9,
          emissive: 0x0a4d68,
          emissiveIntensity: 0.2,
          transparent: true,
          opacity: settings.opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
          roughness: 0.18,
          metalness: 0.05,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.name = "waterSurface"
        mesh.renderOrder = 820
        group.add(mesh)
      } else {
        geometry.dispose()
      }
      setDiagnostic({
        ...geometryDiagnostic,
        waterFeatureCount: waterMask.featureCount,
        status,
      })
    })()

    return () => {
      cancelled = true
      scene.remove(group)
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material.dispose()
      })
      if (groupRef.current === group) groupRef.current = null
    }
  }, [authoritativeTerrain, bbox, coastalLandMask, sceneRef, settings.opacity, settings.verticalExag])

  useEffect(() => {
    if (groupRef.current) groupRef.current.visible = settings.visible
  }, [settings.visible])

  return {
    waterSurfaceGroupRef: groupRef,
    diagnostic,
  }
}
