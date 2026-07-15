import logging
import numpy as np
from scipy.interpolate import RBFInterpolator

logger = logging.getLogger(__name__)


def merge_nearby_boreholes(
    boreholes: list[dict], threshold_m: float = 2.0
) -> list[dict]:
    """
    평면상 threshold_m(기본 2m) 이내로 겹치는 시추공들을 하나로 병합합니다.

    같은 부지의 다중 로그/재시추(연속 ID 등)는 좌표가 cm 단위로 겹치는데,
    이를 그대로 RBF에 넣으면 보간 행렬이 특이(near-singular)해져 가중치가
    폭주하고 격자 Z 전역이 발산합니다. 보간 전에 군집을 대표 1개로 합쳐
    이 발산을 원천 차단합니다.

    병합 규칙(결정적):
      - 위치: 군집 평균 경위도
      - 표고(elevation): 군집 평균
      - 지층(strata): 군집 내 strata 항목이 가장 많은(가장 완전한) 시추공의 것을 채택
    """
    pts = [
        (b.get("longitude"), b.get("latitude"))
        for b in boreholes
    ]
    valid = [
        i for i, (x, y) in enumerate(pts)
        if x is not None and y is not None
    ]
    if len(valid) <= 1:
        return boreholes

    # 임계거리를 도(degree) 단위로 환산 (위도 기준 근사; 1도 ≈ 111,000m)
    mid_lat = np.mean([boreholes[i]["latitude"] for i in valid])
    cos_lat = np.cos(np.radians(mid_lat))
    coords_m = {
        i: (
            boreholes[i]["longitude"] * 111_320.0 * cos_lat,
            boreholes[i]["latitude"] * 110_540.0,
        )
        for i in valid
    }

    used: set[int] = set()
    merged: list[dict] = []
    n_clusters_collapsed = 0

    for i in valid:
        if i in used:
            continue
        cluster = [i]
        xi, yi = coords_m[i]
        for j in valid:
            if j == i or j in used:
                continue
            xj, yj = coords_m[j]
            if (xi - xj) ** 2 + (yi - yj) ** 2 <= threshold_m ** 2:
                cluster.append(j)
        for k in cluster:
            used.add(k)

        if len(cluster) == 1:
            merged.append(boreholes[i])
            continue

        n_clusters_collapsed += 1
        group = [boreholes[k] for k in cluster]
        # 대표: strata 항목이 가장 많은 시추공
        rep = max(group, key=lambda b: len(b.get("strata", []) or []))
        avg_lng = float(np.mean([b["longitude"] for b in group]))
        avg_lat = float(np.mean([b["latitude"] for b in group]))
        avg_elev = float(np.mean([b.get("elevation", 0.0) for b in group]))
        merged_bh = dict(rep)
        merged_bh["longitude"] = avg_lng
        merged_bh["latitude"] = avg_lat
        merged_bh["elevation"] = avg_elev
        merged_bh["_merged_from"] = [b.get("id") for b in group]
        merged.append(merged_bh)

    if n_clusters_collapsed:
        logger.warning(
            "[RBF] 근접 시추공 병합: %d개 → %d개 (%d개 군집 통합, 임계 %.1fm)",
            len(boreholes), len(merged), n_clusters_collapsed, threshold_m,
        )
    return merged


class GeologicalRBF:
    """
    RBF(Radial Basis Function)를 이용하여 다중 지층의 3D 연속 곡면 격자를 생성하는 보간기입니다.
    """
    def __init__(self, actual_boreholes: list[dict], phantom_boreholes: list[dict]):
        self.all_boreholes = actual_boreholes + phantom_boreholes

        # 평면 vs 수직 고도 스케일 왜곡 방지: 미터(m) 단위 좌표계 변환
        mid_lat = np.mean([bh["latitude"] for bh in self.all_boreholes]) if self.all_boreholes else 37.26
        cos_lat = np.cos(np.radians(mid_lat))

        coords = []
        for bh in self.all_boreholes:
            xm = bh["longitude"] * 111320 * cos_lat
            ym = bh["latitude"]  * 110540
            coords.append([xm, ym])
        self.points = np.array(coords)

        # 수치 발산 방지: 중심 이동(Center Shift) 상대 좌표화
        if len(self.points) > 0:
            self.center_x = np.mean(self.points[:, 0])
            self.center_y = np.mean(self.points[:, 1])
            self.shifted_points = self.points - [self.center_x, self.center_y]
        else:
            self.center_x = 0.0
            self.center_y = 0.0
            self.shifted_points = self.points

    def get_layer_boundary_elevations(self, layer_name: str) -> np.ndarray:
        """
        각 시추공에서 특정 지층 하한면의 절대 표고(m)를 추출합니다.
        해당 지층이 없는 시추공은 상위 지층 바닥을 폴백으로 사용합니다.
        """
        elevations = []
        for bh in self.all_boreholes:
            elev = bh["elevation"]
            found = False
            for s in bh.get("strata", []):
                if s.get("strata_group") == layer_name:
                    elevations.append(elev - s.get("depth_top", 0.0))
                    found = True
                    break

            if not found:
                if layer_name == "soil":
                    elevations.append(elev)  # 토사 없으면 지표면과 동일
                elif layer_name == "weathered_rock":
                    bot = self._get_bh_layer_bottom(bh, "soil")
                    elevations.append(bot if bot is not None else elev)
                elif layer_name == "soft_rock":
                    bot = self._get_bh_layer_bottom(bh, "weathered_rock")
                    if bot is None:
                        bot = self._get_bh_layer_bottom(bh, "soil")
                    elevations.append(bot if bot is not None else elev)
                elif layer_name == "normal_rock":
                    bot = self._get_bh_layer_bottom(bh, "soft_rock")
                    if bot is None:
                        bot = self._get_bh_layer_bottom(bh, "weathered_rock")
                    if bot is None:
                        bot = self._get_bh_layer_bottom(bh, "soil")
                    elevations.append(bot if bot is not None else elev)
                else:  # hard_rock
                    bot = self._get_bh_layer_bottom(bh, "normal_rock")
                    if bot is None:
                        bot = self._get_bh_layer_bottom(bh, "soft_rock")
                    if bot is None:
                        bot = self._get_bh_layer_bottom(bh, "weathered_rock")
                    if bot is None:
                        bot = self._get_bh_layer_bottom(bh, "soil")
                    elevations.append(bot if bot is not None else elev)

        return np.array(elevations)

    def count_layer_real_hits(self, layer_name: str) -> int:
        """
        해당 지층(strata_group)을 실제로 보유한 '실측' 시추공 수를 셉니다.
        팬텀(is_phantom=True)은 인접 실측공의 strata를 복제하므로 제외합니다.

        반환값이 0이면 그 지층은 보간 근거가 없어 폴백(상위 지층 바닥 복제)으로만
        채워지므로, 내보내기에서 실존 경계면처럼 출력하면 안 됩니다.
        """
        n = 0
        for bh in self.all_boreholes:
            if bh.get("is_phantom"):
                continue
            for s in bh.get("strata", []) or []:
                if s.get("strata_group") == layer_name:
                    n += 1
                    break
        return n

    def _get_bh_layer_bottom(self, bh: dict, layer_name: str) -> float | None:
        elev = bh["elevation"]
        for s in bh.get("strata", []):
            if s.get("strata_group") == layer_name:
                return elev - s.get("depth_bottom", 0.0)
        return None

    def build_grid(self, bbox: list[float], res: int = 48,
                   surf_elev_grid: np.ndarray | None = None) -> dict:
        """
        각 지층 경계면의 절대 표고를 시추공에서 직접 추출하여 RBF 보간합니다.
        (구 방식인 비례 심도 보간 대신 절대 표고 직접 보간을 사용하여 형상 왜곡 방지)

        지층 순서 (위→아래):
          ground_surface → soil → weathered_rock → soft_rock → normal_rock → hard_rock
        각 경계면은 반드시 위 경계면보다 낮도록 단조성(monotonicity)을 강제합니다.
        """
        min_lng, min_lat, max_lng, max_lat = bbox

        # 1. 격자 좌표 생성 및 미터 단위 중심 이동 변환
        lngs = np.linspace(min_lng, max_lng, res)
        lats = np.linspace(min_lat, max_lat, res)
        grid_lng, grid_lat = np.meshgrid(lngs, lats)
        mid_lat = (min_lat + max_lat) / 2
        cos_lat = np.cos(np.radians(mid_lat))
        grid_xm = (grid_lng * 111320 * cos_lat) - self.center_x
        grid_ym = (grid_lat * 110540)            - self.center_y
        grid_pts = np.vstack([grid_xm.ravel(), grid_ym.ravel()]).T

        # 2. 지표면 보간
        if surf_elev_grid is not None:
            surf_ceil = np.array(surf_elev_grid, dtype=np.float64)
        else:
            bh_elevations = np.array([bh["elevation"] for bh in self.all_boreholes])
            rbf_surf = RBFInterpolator(
                self.shifted_points, bh_elevations,
                kernel="thin_plate_spline", degree=1,
            )
            surf_ceil = rbf_surf(grid_pts).reshape(grid_lng.shape)

        grids: dict[str, np.ndarray] = {"ground_surface": surf_ceil}

        # 3. 지층별 경계면 절대 표고 직접 보간 (위→아래 순서 고정)
        layer_order = ["soil", "weathered_rock", "soft_rock", "normal_rock", "hard_rock"]
        ceiling = surf_ceil.copy()  # 직전 경계면 — 현재 지층은 이것보다 낮아야 함

        for layer in layer_order:
            elevations = self.get_layer_boundary_elevations(layer)
            if len(elevations) == 0:
                continue
            rbf = RBFInterpolator(
                self.shifted_points, elevations,
                kernel="thin_plate_spline", degree=1,
            )
            grid = rbf(grid_pts).reshape(grid_lng.shape)
            # 단조성 강제: 지층 면은 위 경계보다 낮아야 함
            grid = np.minimum(grid, ceiling)
            grids[layer] = grid
            ceiling = grid

        # 4. JSON 직렬화
        result = {k: v.tolist() for k, v in grids.items()}
        return {"bbox": bbox, "res": res, "grids": result}
