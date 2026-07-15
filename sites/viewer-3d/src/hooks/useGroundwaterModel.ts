import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import * as THREE from "three"
import type { Borehole } from "@/lib/types"
import { groundwaterObservationsFromBoreholes, meanDepthBelowGroundM } from "@/lib/groundwaterData"
import { buildGroundwaterGeometry } from "@/lib/groundwaterGeometry"
import type { Bbox } from "@/lib/projection"
import type { AuthoritativeTerrainGrid } from "@/lib/authoritativeTerrain"
import type { CoastalLandMask } from "@/lib/coastalLandMask"
import { buildWaterSurfaceMask } from "@/lib/waterSurfaceMask"
import { combinedWaterElevationAt } from "@/lib/waterSurfaceGeometry"
import { apiUrl } from "@shared/urls"

interface GroundwaterSettings {
  visible: boolean
  opacity: number
  verticalExag: number
  depthBelowMSL: number
}

export function useGroundwaterModel(
  sceneRef: RefObject<THREE.Scene | null>,
  boreholes: readonly Borehole[],
  bbox: Bbox | null,
  polygon: { lng: number; lat: number }[] | null,
  authoritativeTerrain: AuthoritativeTerrainGrid | null,
  coastalLandMask: CoastalLandMask | undefined,
  settings: GroundwaterSettings,
) {
  const groupRef = useRef<THREE.Group | null>(null)
  const [constraintDiagnostic, setConstraintDiagnostic] = useState({
    terrainCapCount: 0,
    maxTerrainExcessBeforeCapM: 0,
    anchorAboveTerrainCount: 0,
    waterSurfaceCapCount: 0,
    displayCappedAnchorCount: 0,
    waterFeatureCount: 0,
    waterSurfaceStatus: "not_configured",
    coastalExcludedCellCount: 0,
    clearanceM: 0.05,
  })
  const observations = useMemo(() => groundwaterObservationsFromBoreholes(boreholes), [boreholes])
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !bbox) return
    let cancelled = false
    const group = new THREE.Group()
    group.name = "groundwaterGroup"; group.scale.y = settings.verticalExag; scene.add(group); groupRef.current = group
    void (async () => {
      if (!authoritativeTerrain) return
      let waterMask = buildWaterSurfaceMask([], authoritativeTerrain)
      let waterSurfaceStatus = "not_configured"
      try {
        const response = await fetch(apiUrl(`/api/v1/water-surfaces?bbox=${bbox.join(",")}`))
        if (response.ok) {
          const payload = await response.json()
          waterMask = buildWaterSurfaceMask(payload.features ?? [], authoritativeTerrain)
          waterSurfaceStatus = payload.status ?? "unknown"
        }
      } catch {
        // Safe fallback: no water exception; terrain cap remains active everywhere.
      }
      if (cancelled) return
      let trendAt: ((lng: number, lat: number) => number) | undefined
      if (observations.length >= 3 && authoritativeTerrain) {
        const meanDepth = meanDepthBelowGroundM(observations)
        trendAt = (lng: number, lat: number) => authoritativeTerrain.elevationAt(lng, lat) - meanDepth
      }
      if (cancelled) return
      const selectionContains = (lng: number, lat: number) => {
        if (!polygon || polygon.length < 3) return true
        let inside = false
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const xi = polygon[i].lng
          const yi = polygon[i].lat
          const xj = polygon[j].lng
          const yj = polygon[j].lat
          const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
          if (intersects) inside = !inside
        }
        return inside
      }

      const geometryData = buildGroundwaterGeometry(
        observations,
        bbox,
        2,
        42,
        settings.depthBelowMSL,
        trendAt,
        authoritativeTerrain?.elevationAt,
        0.05,
        (lng, lat) => combinedWaterElevationAt(waterMask, coastalLandMask, lng, lat)?.elevationM ?? null,
        (lng, lat) => selectionContains(lng, lat) && (coastalLandMask?.containsWithBuffer(lng, lat, 5) ?? true),
        true,
      )
      if (cancelled) return
      if (geometryData) {
        setConstraintDiagnostic({
          ...geometryData.constraintDiagnostic,
          waterFeatureCount: waterMask.featureCount,
          waterSurfaceStatus,
        })
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.BufferAttribute(geometryData.positions, 3))
        geometry.setIndex(new THREE.BufferAttribute(geometryData.indices, 1)); geometry.computeVertexNormals()
        geometry.clearGroups()
        geometry.addGroup(0, geometryData.topIndexCount, 0)
        geometry.addGroup(
          geometryData.topIndexCount,
          geometryData.indices.length - geometryData.topIndexCount,
          1,
        )
        const material = new THREE.MeshStandardMaterial({
          color: 0x22b8cf, emissive: 0x063d48, emissiveIntensity: 0.16, transparent: true,
          opacity: settings.opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.35,
        })
        // Keep bottom/outer walls in the geometry so stencil capping can treat
        // groundwater as a closed solid, but never draw those walls in the
        // normal scene: transparent bbox walls otherwise show through strata.
        const stencilOnlyMaterial = new THREE.MeshBasicMaterial({
          colorWrite: false,
          depthWrite: false,
          transparent: true,
          opacity: 0,
        })
        const mesh = new THREE.Mesh(geometry, [material, stencilOnlyMaterial])
        mesh.name = "groundwaterSolid"
        mesh.renderOrder = 900
        mesh.userData.constraintDiagnostic = geometryData.diagnostic
        mesh.userData.sectionCapSignature = `groundwater:${settings.opacity.toFixed(3)}:${settings.depthBelowMSL}`
        mesh.userData.groundwaterTopIndexCount = geometryData.topIndexCount
        group.add(mesh)
      }
      group.visible = settings.visible
    })()

    return () => {
      cancelled = true
      scene.remove(group)
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose()); else mesh.material?.dispose()
      })
      if (groupRef.current === group) groupRef.current = null
    }
  }, [authoritativeTerrain, bbox, coastalLandMask, observations, polygon, sceneRef, settings.depthBelowMSL, settings.opacity, settings.verticalExag, settings.visible])
  return {
    groundwaterGroupRef: groupRef,
    observationCount: observations.length,
    canBuildSurface: observations.length >= 3,
    constraintDiagnostic,
  }
}
