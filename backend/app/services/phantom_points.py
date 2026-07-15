import numpy as np
from scipy.spatial import ConvexHull

def generate_phantom_points(boreholes: list[dict], scale: float = 1.2, count: int = 12) -> list[dict]:
    """
    실제 시추공 좌표군(Convex Hull) 외곽에 수치적 발산 제어를 위한 가상 시추공(Phantom Points)을 생성합니다.
    - scale: 최외곽 거리의 확장 비율 (기본 1.8배)
    - count: 가상 시추공 개수 (기본 12개)
    """
    if not boreholes:
        return []

    # 1. 시추공 평면 좌표 추출 (longitude, latitude)
    pts = []
    for b in boreholes:
        x, y = b.get("longitude"), b.get("latitude")
        if x is not None and y is not None:
            pts.append([x, y])
    
    pts = np.array(pts)
    if len(pts) == 0:
        return []

    # 2. 중심점(Centroid) 및 스케일 반경 계산
    cx, cy = np.mean(pts[:, 0]), np.mean(pts[:, 1])
    
    # Convex Hull을 통한 외곽 벡터 팽창 기법
    phantom_coords = []
    if len(pts) >= 3:
        try:
            hull = ConvexHull(pts)
            hull_pts = pts[hull.vertices]
            
            # 각 Hull 정점들을 중심 기준으로 외곽으로 scale배 팽창시킵니다.
            expanded_pts = []
            for hp in hull_pts:
                vx = hp[0] - cx
                vy = hp[1] - cy
                expanded_pts.append([cx + vx * scale, cy + vy * scale])
            expanded_pts = np.array(expanded_pts)

            # 타겟 개수(count)에 맞게 각도를 등간격으로 등분하여 타원/팽창 궤적상에 보간 배치
            angles = np.arctan2(expanded_pts[:, 1] - cy, expanded_pts[:, 0] - cx)
            # 각도 순서로 정렬
            sort_idx = np.argsort(angles)
            expanded_pts = expanded_pts[sort_idx]
            angles = angles[sort_idx]

            # 0도 ~ 360도 등간격 샘플링
            target_angles = np.linspace(-np.pi, np.pi, count, endpoint=False)
            for ta in target_angles:
                # 가장 가까운 정렬 각도 구간 찾기
                idx = np.searchsorted(angles, ta)
                if idx == 0:
                    p1, p2 = expanded_pts[-1], expanded_pts[0]
                    a1, a2 = angles[-1] - 2 * np.pi, angles[0]
                elif idx >= len(angles):
                    p1, p2 = expanded_pts[-1], expanded_pts[0]
                    a1, a2 = angles[-1], angles[0] + 2 * np.pi
                else:
                    p1, p2 = expanded_pts[idx - 1], expanded_pts[idx]
                    a1, a2 = angles[idx - 1], angles[idx]
                
                # 선형 보간
                t = (ta - a1) / (a2 - a1) if abs(a2 - a1) > 1e-6 else 0.5
                px = p1[0] + t * (p2[0] - p1[0])
                py = p1[1] + t * (p2[1] - p1[1])
                phantom_coords.append((px, py))
        except Exception:
            # Convex Hull 계산 에러 시 원형 팽창 백업
            phantom_coords = _generate_circular_phantoms(pts, cx, cy, scale, count)
    else:
        # 시추공 3개 미만 시 원형 팽창 백업
        phantom_coords = _generate_circular_phantoms(pts, cx, cy, scale, count)

    # 3. 각 가상 시추공에 가장 인접한 실제 시추공 지층 정보(IDW 가중치 기준) 복제 배정
    phantoms = []
    for idx, (px, py) in enumerate(phantom_coords):
        # 가장 가까운 실제 시추공들 찾기
        dists = np.sqrt((pts[:, 0] - px)**2 + (pts[:, 1] - py)**2)
        nearest_idx = np.argmin(dists)
        nearest_bh = boreholes[nearest_idx]

        # 지층구조(strata) 복제 및 절대 표고에 맞게 보정
        # 가상 시추공의 지형 표고는 인접 시추공 표고를 그대로 모방 (Phase 2에서 DEM과 정교하게 결합)
        phantom_elev = nearest_bh.get("elevation", 0.0)
        
        copied_strata = []
        for s in nearest_bh.get("strata", []):
            copied_strata.append({
                "depth_top": s.get("depth_top", 0.0),
                "depth_bottom": s.get("depth_bottom", 0.0),
                "strata_group": s.get("strata_group", "unknown"),
                "soil_type": s.get("soil_type", "미분류")
            })

        phantoms.append({
            "id": -100 - idx,  # 가상 시추공 전용 음수 ID 부여
            "name": f"PHANTOM-{idx+1}",
            "longitude": float(px),
            "latitude": float(py),
            "elevation": float(phantom_elev),
            "is_phantom": True,
            "strata": copied_strata
        })

    return phantoms

def _generate_circular_phantoms(pts, cx, cy, scale, count):
    # 시추공들의 무게중심으로부터 최대 거리(반경)를 구합니다.
    dists_from_center = np.sqrt((pts[:, 0] - cx)**2 + (pts[:, 1] - cy)**2)
    max_r = np.max(dists_from_center) if len(dists_from_center) > 0 else 0.005
    target_r = max(max_r, 0.002) * scale

    phantom_coords = []
    for i in range(count):
        angle = (2 * np.pi * i) / count
        px = cx + target_r * np.cos(angle)
        py = cy + target_r * np.sin(angle)
        phantom_coords.append((px, py))
    return phantom_coords
