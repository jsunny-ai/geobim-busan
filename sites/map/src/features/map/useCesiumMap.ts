import { useEffect, useRef, useState } from "react"
import * as Cesium from "cesium"
import "cesium/Build/Cesium/Widgets/widgets.css"
import type { Borehole } from "@/lib/types"

// V-World API Key
const VWORLD_KEY = import.meta.env.VITE_VWORLD_KEY || "A5DB0E26-36FA-35BE-8E1A-283E1232A2CA"

export function useCesiumMap(
  containerRef: React.RefObject<HTMLDivElement | null>,
  boreholes: Borehole[],
  basemap: string = "Base",
  vexag: number = 15,
  radius: number = 10,
  alpha: number = 235,
  zMode: "gl" | "absolute" = "gl",
  layerVisible: boolean[] = [true, true, true, true],
  onBoreholeClick?: (borehole: Borehole) => void,
) {
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null)
  
  // 영역 그리기 관련 상태
  const [isDrawing, setIsDrawing] = useState(false)
  const [polygon, setPolygon] = useState<Cesium.Cartographic[] | null>(null)
  const [selectedBoreholes, setSelectedBoreholes] = useState<Borehole[]>([])

  const activePointsRef = useRef<Cesium.Entity[]>([])
  const activePolygonRef = useRef<Cesium.Entity | null>(null)
  const drawingPointsRef = useRef<Cesium.Cartesian3[]>([])
  const boreholesEntitiesRef = useRef<Cesium.Entity[]>([])
  const vworldLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const clusterDataSourceRef = useRef<Cesium.CustomDataSource | null>(null)
  const lastAutoFitKeyRef = useRef<string | null>(null)
  
  // 편집 기능 상태
  const editRectangleRef = useRef<Cesium.Rectangle | null>(null)
  const activeHandlesRef = useRef<Cesium.Entity[]>([])
  const draggingHandleRef = useRef<number | null>(null)

  // 클릭 핸들러 내부에서 최신 값을 읽기 위한 ref 미러 (init effect deps 제거용)
  const boreholesRef = useRef(boreholes)
  boreholesRef.current = boreholes
  const onBoreholeClickRef = useRef(onBoreholeClick)
  onBoreholeClickRef.current = onBoreholeClick

  // 1. Cesium Viewer 초기화 및 V-World 타일 적용
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    // 전 세계를 덮는 기본 베이스 맵(OSM) 주입 (배경 공백 및 에러 방지)
    const osmProvider = new Cesium.UrlTemplateImageryProvider({
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      subdomains: ["a", "b", "c"],
      credit: "© OpenStreetMap contributors",
      maximumLevel: 19,
    })

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: new Cesium.ImageryLayer(osmProvider), // 기본 지도를 OSM으로
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      navigationHelpButton: false,
      timeline: false,
      animation: false,
      fullscreenButton: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      sceneMode: Cesium.SceneMode.SCENE2D, // 2D 평면 맵 모드로 구동 설정
    })

    // V-World Base 레이어 초기 추가 (basemap effect보다 먼저 실행 보장)
    if (basemap !== "osm") {
      const initProvider = new Cesium.UrlTemplateImageryProvider({
        url: `/api/v1/tiles/vworld/${basemap}/{z}/{x}/{y}`,
        credit: `V-World ${basemap} Map`,
        minimumLevel: 6,
        maximumLevel: 19,
        rectangle: Cesium.Rectangle.fromDegrees(124.0, 31.0, 132.0, 43.0),
      })
      vworldLayerRef.current = viewer.imageryLayers.addImageryProvider(initProvider)
    }

    viewerRef.current = viewer

    // 남한 전역 광역 뷰로 초기화 (Rectangle 기반 — 창 크기와 무관하게 전국이 한눈에 들어옴)
    // 좌하단(서·남) lng/lat, 우상단(동·북) lng/lat. 동쪽은 울릉도·독도까지 포함.
    viewer.camera.setView({
      destination: Cesium.Rectangle.fromDegrees(125.0, 33.5, 131.0, 38.7),
    })

    // 클릭 이벤트용 ScreenSpaceEventHandler 등록
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    handlerRef.current = handler

    // 시추공 및 클러스터 클릭 감지
    handler.setInputAction((click: any) => {
      const pickedObject = viewer.scene.pick(click.position)
      if (Cesium.defined(pickedObject) && pickedObject.id) {
        const entity = pickedObject.id
        
        const entityId = entity.id

        // 개별 시추공 포인트 클릭 — 패널 표시 + 줌인
        if (typeof entityId === "string" && entityId.startsWith("bh-")) {
          const bh = boreholesRef.current.find((b) => `bh-${b.id}` === entityId)
          if (bh) {
            if (onBoreholeClickRef.current) {
              onBoreholeClickRef.current(bh)
            }
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(bh.longitude, bh.latitude, 1500),
              duration: 1.0,
            })
          }
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      if (handlerRef.current) {
        handlerRef.current.destroy()
        handlerRef.current = null
      }
      if (viewerRef.current) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
    }
  }, [containerRef]) // eslint-disable-line react-hooks/exhaustive-deps

  // 1-1. 배경지도(basemap) 변경 시 V-World 레이어 교체
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    // OSM은 유지해야 하므로, basemap이 osm이면 vworld 레이어만 제거
    if (vworldLayerRef.current) {
      viewer.imageryLayers.remove(vworldLayerRef.current)
      vworldLayerRef.current = null
    }

    if (basemap !== "osm") {
      const newProvider = new Cesium.UrlTemplateImageryProvider({
        url: `/api/v1/tiles/vworld/${basemap}/{z}/{x}/{y}`,
        credit: `V-World ${basemap} Map`,
        minimumLevel: 6,
        maximumLevel: 19,
        rectangle: Cesium.Rectangle.fromDegrees(124.0, 31.0, 132.0, 43.0),
      })
      vworldLayerRef.current = viewer.imageryLayers.addImageryProvider(newProvider)
    }
    
    viewer.scene.requestRender()
  }, [basemap])

  // 2. 시추공 데이터 렌더링 (클러스터링 포인트 + 지하 실린더)
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    // 지하 3D 실린더 엔티티 초기화
    boreholesEntitiesRef.current.forEach((entity) => viewer.entities.remove(entity))
    boreholesEntitiesRef.current = []

    // 데이터소스(클러스터링용) 초기화
    if (clusterDataSourceRef.current) {
      viewer.dataSources.remove(clusterDataSourceRef.current)
      clusterDataSourceRef.current = null
    }

    const dataSource = new Cesium.CustomDataSource("boreholes")
    clusterDataSourceRef.current = dataSource

    // 클러스터링 비활성화 (모든 마커를 개별적으로 지도에 표기)
    dataSource.clustering.enabled = false

    viewer.dataSources.add(dataSource)

    boreholes.forEach((b) => {
      const elev = b.elevation || 0
      const groundZ = zMode === 'gl' ? 0.5 : elev * vexag + 0.5
      const centerCartesian = Cesium.Cartesian3.fromDegrees(b.longitude, b.latitude, groundZ)

      // 지표면 시추공 점 마커
      dataSource.entities.add({
        id: `bh-${b.id}`,
        position: centerCartesian,
        point: {
          pixelSize: 7,
          color: Cesium.Color.fromCssColorString("#0B4EA2"),
          outlineColor: Cesium.Color.fromCssColorString("#EAF3FF"),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, // 항상 지표면 위에 표현
          scaleByDistance: new Cesium.NearFarScalar(1500, 1.0, 15000, 0.45),
        },
        label: {
          text: b.name,
          font: "11px sans-serif",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          pixelOffset: new Cesium.Cartesian2(0, -12), // 회색 점 위쪽으로 텍스트 오프셋 조정
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000), // 3000m 이상 멀어지면 이름 숨김
        }
      })

    })

    viewer.scene.requestRender()
  }, [boreholes, vexag, radius, alpha, zMode, layerVisible])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || boreholes.length === 0 || isDrawing || editRectangleRef.current) return

    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    let validCount = 0

    for (const bh of boreholes) {
      if (!Number.isFinite(bh.longitude) || !Number.isFinite(bh.latitude)) continue
      minLng = Math.min(minLng, bh.longitude)
      minLat = Math.min(minLat, bh.latitude)
      maxLng = Math.max(maxLng, bh.longitude)
      maxLat = Math.max(maxLat, bh.latitude)
      validCount += 1
    }

    if (validCount === 0) return

    const key = `${validCount}:${minLng.toFixed(5)},${minLat.toFixed(5)},${maxLng.toFixed(5)},${maxLat.toFixed(5)}`
    if (lastAutoFitKeyRef.current === key) return
    lastAutoFitKeyRef.current = key

    const lngSpan = Math.max(maxLng - minLng, 0.01)
    const latSpan = Math.max(maxLat - minLat, 0.01)
    const padLng = lngSpan * 0.25
    const padLat = latSpan * 0.25

    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        minLng - padLng,
        minLat - padLat,
        maxLng + padLng,
        maxLat + padLat,
      ),
      duration: 1.0,
    })
    viewer.scene.requestRender()
  }, [boreholes, isDrawing])

  // 3. 영역 그리기 (다각형 드로잉 도구)
  const startDrawing = () => {
    const viewer = viewerRef.current
    const handler = handlerRef.current
    if (!viewer || !handler) return

    setIsDrawing(true)
    setPolygon(null)
    setSelectedBoreholes([])
    drawingPointsRef.current = []

    // 마우스 드래그 이벤트 시 카메라 이동 방지
    viewer.scene.screenSpaceCameraController.enableInputs = false

    // 기존 영역 엔티티 제거
    activePointsRef.current.forEach((p) => viewer.entities.remove(p))
    activePointsRef.current = []
    if (activePolygonRef.current) {
      viewer.entities.remove(activePolygonRef.current)
      activePolygonRef.current = null
    }

    let startCartesian: Cesium.Cartesian3 | null = null
    let currentRectangle: Cesium.Rectangle | null = null

    // 좌클릭 누름: 사각형 시작점
    handler.setInputAction((click: any) => {
      const cartesian = viewer.scene.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid)
      if (cartesian) {
        startCartesian = cartesian
        drawingPointsRef.current = [cartesian, cartesian]
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    // 마우스 무브: 사각형 크기 조절
    handler.setInputAction((movement: any) => {
      if (!startCartesian) return
      const cartesian = viewer.scene.camera.pickEllipsoid(movement.endPosition, viewer.scene.globe.ellipsoid)
      if (cartesian) {
        drawingPointsRef.current[1] = cartesian
        const c1 = Cesium.Cartographic.fromCartesian(startCartesian)
        const c2 = Cesium.Cartographic.fromCartesian(cartesian)
        
        // 면적이 0이 되지 않도록 약간의 오프셋 추가
        if (Math.abs(c1.longitude - c2.longitude) > 1e-7 && Math.abs(c1.latitude - c2.latitude) > 1e-7) {
          currentRectangle = Cesium.Rectangle.fromCartographicArray([c1, c2])

          if (!activePolygonRef.current && currentRectangle) {
            activePolygonRef.current = viewer.entities.add({
              rectangle: {
                coordinates: new Cesium.CallbackProperty(() => {
                  return editRectangleRef.current || currentRectangle
                }, false),
                material: Cesium.Color.RED.withAlpha(0.2),
                outline: true,
                outlineColor: Cesium.Color.RED,
                outlineWidth: 2,
              },
            })
          }
        }
        
        viewer.scene.requestRender()
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // 마우스 뗌: 그리기 완료 및 공간 쿼리(시추공 추출)
    handler.setInputAction((click: any) => {
      if (!startCartesian) return
      const cartesian = viewer.scene.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid)
      if (cartesian) {
        drawingPointsRef.current[1] = cartesian
      }

      viewer.scene.screenSpaceCameraController.enableInputs = true

      if (!currentRectangle) {
        startCartesian = null
        return
      }

      setIsDrawing(false)
      
      // 상태 저장
      editRectangleRef.current = Cesium.Rectangle.clone(currentRectangle)
      
      // 모서리 핸들(조절점) 4개 생성
      if (activeHandlesRef.current.length === 0) {
        for (let i = 0; i < 4; i++) {
          const handle = viewer.entities.add({
            position: new Cesium.CallbackProperty(() => {
              const r = editRectangleRef.current
              if (!r) return undefined
              if (i === 0) return Cesium.Cartesian3.fromRadians(r.west, r.north)
              if (i === 1) return Cesium.Cartesian3.fromRadians(r.east, r.north)
              if (i === 2) return Cesium.Cartesian3.fromRadians(r.east, r.south)
              if (i === 3) return Cesium.Cartesian3.fromRadians(r.west, r.south)
            }, false) as any,
            point: {
              pixelSize: 12,
              color: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.RED,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          })
          activeHandlesRef.current.push(handle)
        }
      }

      // 그리기 핸들러 원복 및 편집 모드 핸들러 등록
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN)
      handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE)
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP)

      // 편집용 공통 필터링 로직
      const updateSelection = () => {
        const rect = editRectangleRef.current
        if (!rect) return
        const nw = new Cesium.Cartographic(rect.west, rect.north)
        const ne = new Cesium.Cartographic(rect.east, rect.north)
        const se = new Cesium.Cartographic(rect.east, rect.south)
        const sw = new Cesium.Cartographic(rect.west, rect.south)
        setPolygon([nw, ne, se, sw, nw])

        const minLng = Cesium.Math.toDegrees(rect.west)
        const maxLng = Cesium.Math.toDegrees(rect.east)
        const minLat = Cesium.Math.toDegrees(rect.south)
        const maxLat = Cesium.Math.toDegrees(rect.north)

        const selected = boreholesRef.current.filter((bh) => {
          return bh.longitude >= minLng && bh.longitude <= maxLng &&
                 bh.latitude >= minLat && bh.latitude <= maxLat
        })
        setSelectedBoreholes(selected)
      }

      updateSelection()
      viewer.scene.requestRender()
      
      // ----- 편집 모드 이벤트 -----
      // 1. 핸들 다운
      handler.setInputAction((e: any) => {
        const picked = viewer.scene.pick(e.position)
        if (Cesium.defined(picked) && picked.id) {
          const idx = activeHandlesRef.current.findIndex((h) => h.id === picked.id.id)
          if (idx !== -1) {
            draggingHandleRef.current = idx
            viewer.scene.screenSpaceCameraController.enableInputs = false
            return
          }
          
          // 핸들이 아닌 시추공 클릭 시
          const entityId = picked.id.id
          if (entityId) {
            const bh = boreholesRef.current.find((b) => `bh-${b.id}` === entityId)
            if (bh && onBoreholeClickRef.current) {
              onBoreholeClickRef.current(bh)
            }
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

      // 2. 핸들 드래그
      handler.setInputAction((movement: any) => {
        const idx = draggingHandleRef.current
        if (idx !== null && editRectangleRef.current) {
          const cartesian = viewer.scene.camera.pickEllipsoid(movement.endPosition, viewer.scene.globe.ellipsoid)
          if (cartesian) {
            const carto = Cesium.Cartographic.fromCartesian(cartesian)
            const rect = Cesium.Rectangle.clone(editRectangleRef.current)
            
            if (idx === 0) { // NW
              rect.west = Math.min(carto.longitude, rect.east - 1e-7)
              rect.north = Math.max(carto.latitude, rect.south + 1e-7)
            } else if (idx === 1) { // NE
              rect.east = Math.max(carto.longitude, rect.west + 1e-7)
              rect.north = Math.max(carto.latitude, rect.south + 1e-7)
            } else if (idx === 2) { // SE
              rect.east = Math.max(carto.longitude, rect.west + 1e-7)
              rect.south = Math.min(carto.latitude, rect.north - 1e-7)
            } else if (idx === 3) { // SW
              rect.west = Math.min(carto.longitude, rect.east - 1e-7)
              rect.south = Math.min(carto.latitude, rect.north - 1e-7)
            }
            
            editRectangleRef.current = rect
            updateSelection()
            viewer.scene.requestRender()
          }
        }
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

      // 3. 핸들 드래그 종료
      handler.setInputAction(() => {
        if (draggingHandleRef.current !== null) {
          draggingHandleRef.current = null
          viewer.scene.screenSpaceCameraController.enableInputs = true
        }
      }, Cesium.ScreenSpaceEventType.LEFT_UP)

      // 원본 LEFT_CLICK 유지 (일반 클릭용)
      handler.setInputAction((click: any) => {
        if (draggingHandleRef.current !== null) return
        const picked = viewer.scene.pick(click.position)
        if (Cesium.defined(picked) && picked.id) {
          const entityId = picked.id.id
          if (entityId) {
            const bh = boreholesRef.current.find((b) => `bh-${b.id}` === entityId)
            if (bh && onBoreholeClickRef.current) {
              onBoreholeClickRef.current(bh)
            }
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

      startCartesian = null
      currentRectangle = null

    }, Cesium.ScreenSpaceEventType.LEFT_UP)
  }

  // 그리기 취소 및 초기화
  const cancelDrawing = () => {
    const viewer = viewerRef.current
    const handler = handlerRef.current
    if (!viewer) return

    setIsDrawing(false)
    setPolygon(null)
    setSelectedBoreholes([])
    drawingPointsRef.current = []

    activePointsRef.current.forEach((p) => viewer.entities.remove(p))
    activePointsRef.current = []
    if (activePolygonRef.current) {
      viewer.entities.remove(activePolygonRef.current)
      activePolygonRef.current = null
    }

    activeHandlesRef.current.forEach((h) => viewer.entities.remove(h))
    activeHandlesRef.current = []
    editRectangleRef.current = null
    draggingHandleRef.current = null

    if (handler) {
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN)
      handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE)
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP)

      handler.setInputAction((click: any) => {
        const pickedObject = viewer.scene.pick(click.position)
        if (Cesium.defined(pickedObject) && pickedObject.id) {
          const entityId = pickedObject.id.id
          const bh = boreholesRef.current.find((b) => `bh-${b.id}` === entityId)
          if (bh && onBoreholeClickRef.current) {
            onBoreholeClickRef.current(bh)
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }

    viewer.scene.screenSpaceCameraController.enableInputs = true
    viewer.scene.requestRender()
  }

  const setSelection = (
    bbox: [number, number, number, number],
    polyPoints: { lng: number; lat: number }[],
    bhIds: number[]
  ) => {
    const viewer = viewerRef.current
    if (!viewer) return

    cancelDrawing()

    const [minLng, minLat, maxLng, maxLat] = bbox
    const rect = Cesium.Rectangle.fromDegrees(minLng, minLat, maxLng, maxLat)
    editRectangleRef.current = rect

    const nw = new Cesium.Cartographic(rect.west, rect.north)
    const ne = new Cesium.Cartographic(rect.east, rect.north)
    const se = new Cesium.Cartographic(rect.east, rect.south)
    const sw = new Cesium.Cartographic(rect.west, rect.south)
    setPolygon([nw, ne, se, sw, nw])

    const selected = boreholesRef.current.filter((bh) => bhIds.includes(bh.id))
    setSelectedBoreholes(selected)

    activePolygonRef.current = viewer.entities.add({
      rectangle: {
        coordinates: new Cesium.CallbackProperty(() => editRectangleRef.current, false),
        material: Cesium.Color.RED.withAlpha(0.2),
        outline: true,
        outlineColor: Cesium.Color.RED,
        outlineWidth: 2,
      },
    })

    for (let i = 0; i < 4; i++) {
      const handle = viewer.entities.add({
        position: new Cesium.CallbackProperty(() => {
          const r = editRectangleRef.current
          if (!r) return undefined
          if (i === 0) return Cesium.Cartesian3.fromRadians(r.west, r.north)
          if (i === 1) return Cesium.Cartesian3.fromRadians(r.east, r.north)
          if (i === 2) return Cesium.Cartesian3.fromRadians(r.east, r.south)
          if (i === 3) return Cesium.Cartesian3.fromRadians(r.west, r.south)
        }, false) as any,
        point: {
          pixelSize: 12,
          color: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.RED,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }
      })
      activeHandlesRef.current.push(handle)
    }

    // 선택한 영역이 뷰포트의 약 65% 수준으로 여유 있게 보이도록 줌 아웃 비율을 계산하여 BBox를 확장
    const centerLng = (minLng + maxLng) / 2
    const centerLat = (minLat + maxLat) / 2
    const halfLngSpan = (maxLng - minLng) / 2
    const halfLatSpan = (maxLat - minLat) / 2

    const expandedMinLng = centerLng - (halfLngSpan / 0.65)
    const expandedMinLat = centerLat - (halfLatSpan / 0.65)
    const expandedMaxLng = centerLng + (halfLngSpan / 0.65)
    const expandedMaxLat = centerLat + (halfLatSpan / 0.65)

    const flyRect = Cesium.Rectangle.fromDegrees(
      expandedMinLng,
      expandedMinLat,
      expandedMaxLng,
      expandedMaxLat
    )

    viewer.camera.flyTo({
      destination: flyRect,
      duration: 1.5,
    })

    viewer.scene.requestRender()
  }

  const zoomIn = () => {
    const v = viewerRef.current
    if (!v) return
    v.camera.zoomIn(v.camera.positionCartographic.height * 0.3)
    v.scene.requestRender()
  }

  const zoomOut = () => {
    const v = viewerRef.current
    if (!v) return
    v.camera.zoomOut(v.camera.positionCartographic.height * 0.5)
    v.scene.requestRender()
  }

  return {
    isDrawing,
    polygon,
    selectedBoreholes,
    startDrawing,
    cancelDrawing,
    zoomIn,
    zoomOut,
    setSelection,
  }
}

// Ray-Casting 기반 다각형 내 점 판별 함수
function isPointInPolygon(point: { x: number; y: number }, vs: { x: number; y: number }[]) {
  const x = point.x, y = point.y
  let inside = false
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y
    const xj = vs[j].x, yj = vs[j].y
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1) + xi
    if (intersect) inside = !inside
  }
  return inside
}
