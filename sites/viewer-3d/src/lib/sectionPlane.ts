import * as THREE from "three"
import type { SectionPoint } from "./types"

const EPSILON = 1e-9

export function getSectionDirection(start: SectionPoint, end: SectionPoint) {
  return new THREE.Vector3(end.x - start.x, 0, end.z - start.z).normalize()
}

export function isValidSectionLine(start: SectionPoint | null, end: SectionPoint | null, minModelLength = 0.01) {
  if (!start || !end) return false
  return Math.hypot(end.x - start.x, end.z - start.z) >= minModelLength
}

export function getSectionNormal(start: SectionPoint, end: SectionPoint, flipped = false) {
  if (!isValidSectionLine(start, end, EPSILON)) {
    throw new Error("Section start and end points must be different.")
  }
  const normal = new THREE.Vector3().crossVectors(
    getSectionDirection(start, end),
    new THREE.Vector3(0, 1, 0),
  ).normalize()
  return flipped ? normal.negate() : normal
}

export function createVerticalPlane(
  start: SectionPoint,
  end: SectionPoint,
  offsetModel = 0,
  flipped = false,
) {
  const normal = getSectionNormal(start, end, flipped)
  const center = new THREE.Vector3((start.x + end.x) / 2, 0, (start.z + end.z) / 2)
  center.addScaledVector(normal, offsetModel)
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center)
}

export function getSectionLengthM(start: SectionPoint, end: SectionPoint, metersToModel: number) {
  if (metersToModel <= 0) return 0
  return Math.hypot(end.x - start.x, end.z - start.z) / metersToModel
}

// Model Z increases southward in the local projection, so north is -Z.
export function getSectionAzimuth(start: SectionPoint, end: SectionPoint) {
  const dx = end.x - start.x
  const north = -(end.z - start.z)
  if (Math.hypot(dx, north) < EPSILON) return 0
  return (Math.atan2(dx, north) * 180 / Math.PI + 360) % 360
}

export function modelOffsetFromMeters(offsetM: number, metersToModel: number) {
  return offsetM * metersToModel
}
