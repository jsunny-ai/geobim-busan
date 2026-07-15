import json
import os
import logging
import math
import numpy as np

try:
    from sklearn.cluster import DBSCAN
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

logger = logging.getLogger(__name__)

class SpatialValidator:
    """지능형 공간 검증 엔진 — 3단계 판정 및 프로젝트 군집 검증 지원"""
    
    # 1. 대한민국 영토 유효 범위 (Macro-Boundary)
    MACRO_BOUNDS = {
        "lon_min": 124.0, "lon_max": 132.0,
        "lat_min": 33.0, "lat_max": 39.0
    }

    def __init__(self, region="suwon", config_path=None):
        if config_path is None:
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            config_path = os.path.join(base_dir, 'config', 'geo_settings.json')
            
        self.config = self._load_config(config_path)
        if region not in self.config['regions']:
            logger.warning(f"Region '{region}' not found in config. Falling back to 'suwon'.")
            region = "suwon"
        self.region_config = self.config['regions'][region]
        self.zones = self.region_config['zones']

    def _load_config(self, path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load geo_settings.json: {e}")
            return {
                "regions": {
                    "suwon": {
                        "zones": {
                            "hard": {"lon_min": 126.920, "lon_max": 127.085, "lat_min": 37.225, "lat_max": 37.320},
                            "soft": {"lon_min": 126.895, "lon_max": 127.115, "lat_min": 37.210, "lat_max": 37.350},
                            "healing": {"lon_min": 126.850, "lon_max": 127.150, "lat_min": 37.180, "lat_max": 37.400}
                        }
                    }
                }
            }

    def is_in_macro_bounds(self, lon, lat):
        """대한민국 영토 범위 내 존재 여부 확인"""
        if lon is None or lat is None: return False
        b = self.MACRO_BOUNDS
        return (b['lon_min'] <= lon <= b['lon_max']) and (b['lat_min'] <= lat <= b['lat_max'])

    def classify(self, lon, lat):
        """기존 3단계 판정 (Bounding Box 기반)"""
        if not self.is_in_macro_bounds(lon, lat):
            return 'reject'
            
        if self._in_zone(lon, lat, 'hard'):
            return 'hard'
        elif self._in_zone(lon, lat, 'soft'):
            return 'soft'
        else:
            # 수원시 경계를 벗어났으나 한국 영토 내인 경우
            return 'out_of_region'

    def _in_zone(self, lon, lat, zone_name):
        zone = self.zones.get(zone_name)
        if not zone: return False
        return (zone['lon_min'] <= lon <= zone['lon_max']) and \
               (zone['lat_min'] <= lat <= zone['lat_max'])

    def validate_project_clustering(self, coords):
        """
        프로젝트 내 시추공들의 군집성을 평가하여 유효성 판정 결과 리스트 반환
        coords: List of (lon, lat) tuples
        Returns: List of bool (True: Valid/Rescued, False: Reject)
        """
        if not coords: return []
        
        results = [False] * len(coords)
        valid_indices = []
        valid_coords = []
        
        # 1차 필터: Macro Bounds
        for i, (lon, lat) in enumerate(coords):
            if self.is_in_macro_bounds(lon, lat):
                valid_indices.append(i)
                valid_coords.append([lon, lat])
        
        if not valid_coords: return results

        points = np.array(valid_coords)
        
        # 2차 필터: 군집 알고리즘 적용
        if len(points) >= 3 and HAS_SKLEARN:
            # DBSCAN 적용 (eps=0.05도: 약 5km, min_samples=2)
            # 위경도 단순 차이를 사용하되, 정밀도가 필요하면 Haversine distance matrix 사용 가능
            # 여기서는 약식으로 위경도 거리 사용
            clustering = DBSCAN(eps=0.05, min_samples=2).fit(points)
            labels = clustering.labels_
            
            # 메인 군집(가장 많은 포인트를 가진 군집) 식별
            unique_labels, counts = np.unique(labels[labels != -1], return_counts=True)
            if len(counts) > 0:
                main_label = unique_labels[np.argmax(counts)]
                for i, idx in enumerate(valid_indices):
                    if labels[i] == main_label:
                        results[idx] = True
            else:
                # 군집이 형성되지 않은 경우 중앙값 기반으로 폴백
                self._fallback_median_check(points, valid_indices, results)
        else:
            # 데이터가 적거나 sklearn 부재 시 중앙값 기반 폴백
            self._fallback_median_check(points, valid_indices, results)
            
        return results

    def _fallback_median_check(self, points, valid_indices, results, radius_km=20):
        """중앙값(Median) 기반 반경 검사 (Haversine 공식 적용)"""
        median_lon = np.median(points[:, 0])
        median_lat = np.median(points[:, 1])
        
        for i, idx in enumerate(valid_indices):
            lon, lat = points[i]
            dist = self._haversine(median_lon, median_lat, lon, lat)
            if dist <= radius_km:
                results[idx] = True

    @staticmethod
    def _haversine(lon1, lat1, lon2, lat2):
        """두 지점 사이의 대원거리 계산 (km)"""
        R = 6371.0
        d_lat = math.radians(lat2 - lat1)
        d_lon = math.radians(lon2 - lon1)
        a = math.sin(d_lat / 2)**2 + math.cos(math.radians(lat1)) * \
            math.cos(math.radians(lat2)) * math.sin(d_lon / 2)**2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    @staticmethod
    def from_project_name(project_name):
        return SpatialValidator(region="suwon")
