import { useEffect, useRef, RefObject } from "react"
// @ts-ignore
import * as THREE from "three"
// @ts-ignore
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

export function useThreeScene(containerRef: RefObject<HTMLDivElement | null>) {
  const sceneRef = useRef<THREE.Scene | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    // 1) scene / renderer / camera 설정
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf0ece4)
    sceneRef.current = scene

    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true })
    renderer.localClippingEnabled = true
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    
    // 이전 렌더러 캔버스 중복 누수를 방지하기 위해 컨테이너 청소 후 마운트!
    container.innerHTML = ""
    container.appendChild(renderer.domElement)
    
    rendererRef.current = renderer

    const camera = new THREE.PerspectiveCamera(
      45, container.clientWidth / container.clientHeight, 0.001, 1000
    )
    camera.position.set(2.4, 2.0, 2.4)
    cameraRef.current = camera

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controlsRef.current = controls

    // 조명
    scene.add(new THREE.AmbientLight(0xffffff, 0.65))
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8)
    d1.position.set(3, 5, 2); scene.add(d1)
    const d2 = new THREE.DirectionalLight(0xfff8f0, 0.35)
    d2.position.set(-2, 3, -2); scene.add(d2)

    // 바닥 격자선 추가
    const gridHelper = new THREE.GridHelper(6, 12, 0xc8c2b8, 0xd8d2c8)
    gridHelper.position.y = -1.6
    scene.add(gridHelper)

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      if (!cameraRef.current || !rendererRef.current || !containerRef.current) return
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      cameraRef.current.aspect = w / h
      cameraRef.current.updateProjectionMatrix()
      rendererRef.current.setSize(w, h)
    }
    window.addEventListener("resize", onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", onResize)
      renderer.dispose()
      try { container.removeChild(renderer.domElement) } catch {}
      sceneRef.current = null
      rendererRef.current = null
      cameraRef.current = null
      controlsRef.current = null
    }
  }, [containerRef])

  return {
    sceneRef,
    rendererRef,
    cameraRef,
    controlsRef,
  }
}
