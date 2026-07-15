"""CSV/XLSX 시추공 표 인제스트 서비스 (옵션 B).

PDF·수동입력에 이어 CSV·XLSX 를 세 번째 인입 경로로 추가한다. 파일 구조에
의존하지 않고 (1) 인코딩/구분자 자동감지 → (2) 컬럼 역할 휴리스틱 추론 →
(3) wide(두께)·long(상하심도) 포맷 판별 → (4) 캐노니컬 변환 한다.

설계 원칙: infer_mapping() 결과는 "매핑 마법사" 가 사용자에게 보여줄 *제안* 이다.
좌표계(CRS)·컬럼 역할을 사용자가 확정한 뒤 build_boreholes() → to_persist_rows()
순으로 적재한다. 완전 무인 자동화가 아니라 "자동 추론 + 사용자 확인" 패턴.
토목 데이터 특성상 심도/좌표계 오인이 3D 모델 오류로 직결되기 때문이다.

적재는 PdfService.persist_rows 를 그대로 재사용한다(중복 검사·프로젝트 링크·
data_origin 일원화). 따라서 본 모듈의 출력 long-row 스키마는 persist_rows 입력과
동일하다: 시추공명, lon_wgs84, lat_wgs84, 표고, meta_crs, 상심도, 하심도, 지층명.
"""

from __future__ import annotations

import csv
import io
import math
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any

from app.services.coordinate_service import CoordinateService
from app.services.normalization import normalize_soil_detail, normalize_strata_group

MAX_TABLE_ROWS = 100_000
MAX_XLSX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024

# 영문 그룹코드 → 한글 5대 분류. 기존 PDF 파이프라인(table_merger.STRATA_GROUP_MAP)이
# DB soil_type 으로 저장하는 한글 표기와 동일하게 맞춘다.
_GROUP_KR = {
    "soil": "토사",
    "weathered_rock": "풍화암",
    "soft_rock": "연암",
    "normal_rock": "보통암",
    "hard_rock": "경암",
}


def _group_kr(raw: str | None) -> str:
    """Preserve soil details for display, while retaining broad rock groups."""
    detail = normalize_soil_detail(raw)
    if detail:
        return detail
    g = normalize_strata_group(raw)
    if g == "unknown":
        return (str(raw).strip() if raw else "") or "미분류"
    return _GROUP_KR[g]


def _merge_adjacent(strata: list[dict]) -> list[dict]:
    """같은 시추공 내 인접 동일 지층명 층 병합 (경계 tol 0.05m).
    기존 pdf_service._merge_adjacent_strata_rows 와 동일 규칙. 매립층+풍화토 등
    연속 토사층을 하나로 합쳐 PDF 적재 데이터와 구조를 일치시킨다.
    """
    out: list[dict] = []
    for s in strata:
        if (
            out
            and out[-1]["지층명"] == s["지층명"]
            and abs(out[-1]["하심도"] - s["상심도"]) <= 0.05
        ):
            out[-1]["하심도"] = s["하심도"]
            out[-1]["_raw"] = f"{out[-1]['_raw']}+{s['_raw']}"
        else:
            out.append(dict(s))
    return out


# ---------------------------------------------------------------------------
# 표 읽기 (CSV 인코딩/구분자 자동감지 + XLSX)
# ---------------------------------------------------------------------------
def read_table(path: str) -> list[list[Any]]:
    """파일 → 2차원 셀 배열(헤더 포함). 완전 빈 행 제거."""
    if path.lower().endswith((".xlsx", ".xlsm")):
        import openpyxl

        with zipfile.ZipFile(path) as archive:
            expanded_size = sum(info.file_size for info in archive.infolist())
            if expanded_size > MAX_XLSX_UNCOMPRESSED_BYTES:
                raise ValueError("압축 해제된 엑셀 파일이 허용 크기(100MB)를 초과합니다.")
        workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
        try:
            if not workbook.worksheets:
                return []
            rows = []
            for row_number, row in enumerate(
                workbook.worksheets[0].iter_rows(values_only=True), start=1
            ):
                if row_number > MAX_TABLE_ROWS:
                    raise ValueError(f"데이터 행이 허용 개수({MAX_TABLE_ROWS:,})를 초과합니다.")
                rows.append(list(row))
        finally:
            workbook.close()
    else:
        text = _decode(open(path, "rb").read())
        rows = list(csv.reader(io.StringIO(text), _sniff_dialect(text)))
        if len(rows) > MAX_TABLE_ROWS:
            raise ValueError(f"데이터 행이 허용 개수({MAX_TABLE_ROWS:,})를 초과합니다.")
    return [r for r in rows if any(c not in (None, "") for c in r)]


def _decode(raw: bytes) -> str:
    """한국 CSV 다발 인코딩(utf-8-sig / cp949 / euc-kr) 순차 시도."""
    for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _sniff_dialect(text: str) -> Any:
    sample = "\n".join(text.splitlines()[:20])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        class _D(csv.Dialect):
            delimiter = ","
            quotechar = '"'
            doublequote = True
            skipinitialspace = True
            lineterminator = "\n"
            quoting = csv.QUOTE_MINIMAL

        return _D()


# ---------------------------------------------------------------------------
# 컬럼 역할 휴리스틱 추론
# ---------------------------------------------------------------------------
ROLE_PATTERNS = {
    "project_name": [r"프로젝트\s*명", r"조사\s*명", r"사업\s*명", r"project\s*name", r"survey\s*name"],
    "name":         [r"공번", r"시추공", r"공\s*명", r"\bbh\b", r"hole", r"^명칭$"],
    "lon":          [r"경도", r"\blon", r"longitude"],
    "lat":          [r"위도", r"\blat", r"latitude"],
    "x":            [r"^x$", r"x\s*좌표", r"easting", r"tm_?x"],
    "y":            [r"^y$", r"y\s*좌표", r"northing", r"tm_?y"],
    "elevation":    [r"표고", r"^el\b", r"고도", r"elevation", r"^z$"],
    "depth_top":    [r"상심도", r"시작\s*심도", r"상단", r"top", r"from", r"_top"],
    "depth_bottom": [r"하심도", r"종료\s*심도", r"하단", r"bottom", r"\bto\b", r"_bot"],
    "soil_type":    [r"지층명", r"^지층$", r"토질", r"soil", r"layer\s*name"],
    "total_depth":  [r"시추\s*심도", r"전체\s*심도", r"공\s*심도"],
    # 지하수위 — 현재 DB 컬럼 없음. 추후 '지하수위 지층' 작업용으로 추출만 해 둔다.
    "water_gl":     [r"수위.*gl", r"지하수위.*gl", r"gl.*수위"],
    "water_el":     [r"수위.*el", r"지하수위.*el", r"el.*수위"],
    "water_level":  [r"수위", r"지하수위"],
    "crs":          [r"좌표계", r"원점", r"\bcrs\b", r"datum"],
    "ignore":       [r"연번", r"일련", r"연도", r"비고", r"remark", r"note", r"^no$"],
}


# ---------------------------------------------------------------------------
# 비고/좌표계 메모 → EPSG 추정 (규칙 출처: docs/좌표계_레퍼런스.md)
# ---------------------------------------------------------------------------
# 비고·좌표계류 컬럼을 식별하는 헤더 패턴
_CRS_HINT_HEADER = re.compile(r"비고|좌표계|원점|좌표|remark|note|crs|datum", re.IGNORECASE)


def _crs_from_remark(text: str | None, year: Any = None) -> str | None:
    """시추 비고 텍스트(예: '동부(60만,20만)') → EPSG 문자열.

    규칙(docs/좌표계_레퍼런스.md):
      - 원점: 중부 127°(central) / 동부 129°(east). 서부·동해는 현재 미지원 → None.
      - false N: 60만=600000(현행 GRS80 2010) / 50만=500000(datum 2종 공존).
      - 50만은 datum 키워드(GRS80/Bessel)가 없으면 단정 불가 → None.
    매칭 실패 시 None — 절대 임의 추측하지 않는다(틀린 좌표계가 더 위험).
    """
    if not text:
        return None
    t = str(text).replace(" ", "").lower()

    if "중부" in t:
        belt = "central"
    elif "동부" in t:
        belt = "east"
    elif "서부" in t or "동해" in t:
        return None  # 지원 목록(중부/동부)에 없음
    else:
        return None

    if re.search(r"60만|600,?000", t):
        false_n = 600000
    elif re.search(r"50만|500,?000", t):
        false_n = 500000
    else:
        return None

    if false_n == 600000:  # 현행 GRS80/KGD2002 2010 계열로 확정
        return "EPSG:5186" if belt == "central" else "EPSG:5187"

    # false N 500000 — datum 구분 필요
    is_bessel = bool(re.search(r"bessel|베셀|지적|동경|tokyo|1985", t))
    is_grs80 = bool(re.search(r"grs80|세계측지계|kgd|2000|2002", t))
    if is_bessel and not is_grs80:
        return "EPSG:5174" if belt == "central" else "EPSG:5176"
    if is_grs80 and not is_bessel:
        return "EPSG:5181" if belt == "central" else "EPSG:5183"
    try:
        numeric_year = int(float(str(year).strip()))
    except (TypeError, ValueError):
        numeric_year = None
    if numeric_year is not None:
        # 한국측지계2000이 도입된 2003년 이후 성과는 GRS80 계열을 우선한다.
        if numeric_year >= 2003:
            return "EPSG:5181" if belt == "central" else "EPSG:5183"
        return "EPSG:5174" if belt == "central" else "EPSG:5176"
    # 연도가 제거된 취합 CSV에서는 현행 프로젝트 기본값인 GRS80을 사용한다.
    # 사용자가 전역 CRS를 직접 확정하면 이 자동값보다 우선한다.
    return "EPSG:5181" if belt == "central" else "EPSG:5183"


def _normalize_crs_hint(value: Any, year: Any = None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    epsg = re.search(r"(?:EPSG[:\s-]*)?(\d{4})", text, re.IGNORECASE)
    if epsg:
        return f"EPSG:{epsg.group(1)}"
    if "WGS84" in text.upper() or "경위도" in text:
        return "EPSG:4326"
    return _crs_from_remark(text, year=year)


def _detect_crs_from_data(
    rows: list[list[Any]], header_row: int, headers: list[Any]
) -> str | None:
    """비고/좌표계류 컬럼(없으면 상위 데이터 행 전체)에서 CRS 힌트 → EPSG."""
    data = rows[header_row + 1:]
    if not data:
        return None
    hint_cols = [i for i, h in enumerate(headers) if h and _CRS_HINT_HEADER.search(str(h))]
    for row in data[:50]:
        cells = (
            [_cell(row, i) for i in hint_cols] if hint_cols else list(row)
        )
        for cell in cells:
            epsg = _crs_from_remark(str(cell) if cell is not None else None)
            if epsg:
                return epsg
    return None


@dataclass
class ColumnMapping:
    fmt: str  # "wide" | "long" | "ambiguous"
    roles: dict[int, str] = field(default_factory=dict)
    stratum_cols: list[tuple[int, str]] = field(default_factory=list)  # (idx, eng_group) 상부→하부
    header_row: int = 0
    headers: list[str] = field(default_factory=list)
    source_crs: str | None = None
    source_crs_explicit: bool = False
    warnings: list[str] = field(default_factory=list)
    confidence: float = 0.0

    def to_dict(self) -> dict:
        return {
            "fmt": self.fmt,
            "header_row": self.header_row,
            "roles": {self.headers[i]: r for i, r in self.roles.items()},
            "stratum_columns": [
                {"header": self.headers[i], "group": _GROUP_KR.get(g, g)}
                for i, g in self.stratum_cols
            ],
            "source_crs": self.source_crs,
            "confidence": self.confidence,
            "warnings": self.warnings,
            "headers": self.headers,
        }


def _match_role(header: Any) -> str | None:
    h = str(header or "").strip().lower()
    if not h:
        return None
    for role, pats in ROLE_PATTERNS.items():
        for p in pats:
            if re.search(p, h):
                return role
    return None


def infer_mapping(rows: list[list[Any]], source_crs: str | None = None) -> ColumnMapping:
    """헤더 추론 → 컬럼 역할/포맷 판별. 마법사에 제시할 '제안'."""
    header_row, headers = _find_header(rows)
    source_crs_explicit = bool(source_crs)
    source_crs = source_crs or _detect_crs_from_data(rows, header_row, headers)
    roles: dict[int, str] = {}
    stratum_cols: list[tuple[int, str]] = []
    warnings: list[str] = []

    for idx, h in enumerate(headers):
        role = _match_role(h)
        grp = normalize_strata_group(str(h) if h is not None else None)
        if grp != "unknown" and role not in ("soil_type", "depth_top", "depth_bottom"):
            stratum_cols.append((idx, grp))
        elif role and role != "ignore":
            roles[idx] = role

    role_vals = set(roles.values())
    if {"depth_top", "depth_bottom", "soil_type"} <= role_vals:
        fmt = "long"
    elif len(stratum_cols) >= 2:
        fmt = "wide"
    else:
        fmt = "ambiguous"
        warnings.append("포맷을 단정할 수 없음 — 마법사에서 컬럼 역할을 수동 지정 필요.")

    if "lon" not in role_vals and not ("x" in role_vals and "y" in role_vals):
        warnings.append("좌표 컬럼(경위도 또는 X/Y)을 찾지 못함.")
    if "name" not in role_vals:
        warnings.append("시추공명 컬럼을 찾지 못함 — 행 번호로 대체.")
    if (
        ("x" in role_vals and "y" in role_vals)
        and "lon" not in role_vals
        and "crs" not in role_vals
        and not source_crs
    ):
        warnings.append("평면좌표(X/Y) 감지 — 좌표계(CRS)를 마법사에서 반드시 확정해야 함.")

    return ColumnMapping(
        fmt=fmt,
        roles=roles,
        stratum_cols=stratum_cols,
        header_row=header_row,
        headers=[("" if h is None else str(h)) for h in headers],
        source_crs=source_crs,
        source_crs_explicit=source_crs_explicit,
        warnings=warnings,
        confidence=_score(fmt, role_vals, stratum_cols, warnings),
    )


def _find_header(rows: list[list[Any]]) -> tuple[int, list[Any]]:
    """역할 매칭이 가장 많이 되는 행을 헤더로 선택(상단 5행 내)."""
    best_i, best_n = 0, -1
    for idx in range(min(5, len(rows))):
        n = sum(
            1
            for c in rows[idx]
            if _match_role(c) or normalize_strata_group(str(c)) != "unknown"
        )
        if n > best_n:
            best_i, best_n = idx, n
    return best_i, rows[best_i]


def _score(fmt, role_vals, stratum_cols, warnings) -> float:
    s = 0.0
    if fmt in ("wide", "long"):
        s += 0.5
    if "name" in role_vals:
        s += 0.15
    if "lon" in role_vals or ("x" in role_vals and "y" in role_vals):
        s += 0.2
    if fmt == "wide" and stratum_cols:
        s += 0.15
    if fmt == "long":
        s += 0.15
    return round(max(0.0, s - 0.1 * len(warnings)), 2)


# ---------------------------------------------------------------------------
# 캐노니컬 변환
# ---------------------------------------------------------------------------
def _num(v: Any) -> float | None:
    if v is None:
        return None
    s = str(v).strip()
    if s in ("", "-", "—", "N/A", "na", "NA"):
        return None
    try:
        value = float(s.replace(",", ""))
        return value if math.isfinite(value) else None
    except ValueError:
        return None


def _normalize_tm_scale(value: float | None) -> tuple[float | None, bool]:
    """Correct an isolated decimal-place error in supported Korean TM values.

    Central/east-belt coordinates used by this service are below 1,000,000 m.
    Some source spreadsheets contain a single value with the decimal point
    shifted one place (for example 2,040,401.48 instead of 204,040.148).
    Only correct the value when dividing by ten lands in the supported range.
    """
    if value is None:
        return None, False
    corrected = value / 10.0
    if abs(value) >= 1_000_000 and 50_000 <= abs(corrected) <= 800_000:
        return corrected, True
    return value, False


_KOREAN_TM_CRS_CANDIDATES = (
    "EPSG:5186",
    "EPSG:5187",
    "EPSG:5181",
    "EPSG:5183",
    "EPSG:5174",
    "EPSG:5176",
)


def _distance_sq(point: tuple[float, float], anchor: tuple[float, float]) -> float:
    lon, lat = point
    anchor_lon, anchor_lat = anchor
    return (lon - anchor_lon) ** 2 + (lat - anchor_lat) ** 2


def _coordinate_candidates(
    cs: CoordinateService,
    x: float,
    y: float,
    preferred_crs: str | None,
) -> list[dict[str, Any]]:
    """Return plausible Korean TM conversions for project-anchor validation."""
    crs_values = list(_KOREAN_TM_CRS_CANDIDATES)
    if preferred_crs and preferred_crs not in crs_values and preferred_crs != "EPSG:4326":
        crs_values.insert(0, preferred_crs)

    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for crs in crs_values:
        for order, tx, ty in (("xy", x, y), ("yx", y, x)):
            key = (crs, order)
            if key in seen:
                continue
            seen.add(key)
            try:
                lon, lat = cs.to_wgs84(
                    tx,
                    ty,
                    crs,
                    coordinate_order="easting_northing",
                )
            except Exception:  # noqa: BLE001
                continue
            if 120 <= lon <= 135 and 30 <= lat <= 40:
                candidates.append({
                    "lon": lon,
                    "lat": lat,
                    "crs": crs,
                    "order": order,
                })
    return candidates


def _auto_correct_coordinates_to_anchor(
    boreholes: list[dict],
    mapping: ColumnMapping,
    cs: CoordinateService,
    issues: list[str],
    coordinate_anchor: tuple[float, float] | None,
) -> None:
    """Correct obvious CRS/order outliers against a project coordinate anchor."""
    if (
        not coordinate_anchor
        or mapping.source_crs_explicit
        or "x" not in set(mapping.roles.values())
        or "y" not in set(mapping.roles.values())
    ):
        return

    for borehole in boreholes:
        x = borehole.get("raw_x")
        y = borehole.get("raw_y")
        if x is None or y is None:
            continue
        current = (float(borehole["longitude"]), float(borehole["latitude"]))
        current_distance = _distance_sq(current, coordinate_anchor)
        candidates = _coordinate_candidates(
            cs,
            float(x),
            float(y),
            borehole.get("source_crs") or mapping.source_crs,
        )
        if not candidates:
            continue
        best = min(
            candidates,
            key=lambda candidate: _distance_sq(
                (candidate["lon"], candidate["lat"]),
                coordinate_anchor,
            ),
        )
        best_distance = _distance_sq((best["lon"], best["lat"]), coordinate_anchor)

        if current_distance <= 0.05 ** 2:
            continue
        if best_distance > 0.5 ** 2:
            continue
        if current_distance <= best_distance + 0.05 ** 2:
            continue

        before = (
            borehole["longitude"],
            borehole["latitude"],
            borehole.get("source_crs"),
        )
        borehole["longitude"] = best["lon"]
        borehole["latitude"] = best["lat"]
        borehole["source_crs"] = best["crs"]
        issues.append(
            f"{borehole['name']}: coordinate auto-corrected to project anchor "
            f"({before[2]} {before[0]:.7f},{before[1]:.7f} -> "
            f"{best['crs']} {best['lon']:.7f},{best['lat']:.7f}, order={best['order']})"
        )


def _cell(row: list[Any], idx: int | None) -> Any:
    return row[idx] if idx is not None and 0 <= idx < len(row) else None


def apply_overrides(mapping: ColumnMapping, role_overrides: dict[str, str] | None) -> ColumnMapping:
    """마법사에서 사용자가 수정한 컬럼 역할(헤더명→역할)을 매핑에 반영."""
    if not role_overrides:
        return mapping
    header_to_idx = {h: i for i, h in enumerate(mapping.headers)}
    for header, role in role_overrides.items():
        idx = header_to_idx.get(header)
        if idx is None:
            continue
        # 기존 역할/지층 컬럼에서 제거 후 재배정
        mapping.roles.pop(idx, None)
        mapping.stratum_cols = [(i, g) for i, g in mapping.stratum_cols if i != idx]
        grp = normalize_strata_group(header)
        if role == "stratum":
            mapping.stratum_cols.append((idx, grp))
        elif role and role not in ("ignore", "stratum"):
            mapping.roles[idx] = role
    mapping.stratum_cols.sort()
    _refresh_mapping_state(mapping)
    return mapping


def _refresh_mapping_state(mapping: ColumnMapping) -> None:
    """사용자 override 이후 포맷·경고·신뢰도를 현재 역할 기준으로 재계산."""
    role_vals = set(mapping.roles.values())
    if {"depth_top", "depth_bottom", "soil_type"} <= role_vals:
        mapping.fmt = "long"
    elif mapping.stratum_cols:
        mapping.fmt = "wide"
    else:
        mapping.fmt = "ambiguous"

    warnings: list[str] = []
    if mapping.fmt == "ambiguous":
        warnings.append("포맷을 단정할 수 없음 — 마법사에서 컬럼 역할을 수동 지정 필요.")
    if "lon" not in role_vals and not ("x" in role_vals and "y" in role_vals):
        warnings.append("좌표 컬럼(경위도 또는 X/Y)을 찾지 못함.")
    if "name" not in role_vals:
        warnings.append("시추공명 컬럼을 찾지 못함 — 행 번호로 대체.")
    if (
        ("x" in role_vals and "y" in role_vals)
        and "lon" not in role_vals
        and "crs" not in role_vals
        and not mapping.source_crs
    ):
        warnings.append("평면좌표(X/Y) 감지 — 좌표계(CRS)를 마법사에서 반드시 확정해야 함.")
    mapping.warnings = warnings
    mapping.confidence = _score(mapping.fmt, role_vals, mapping.stratum_cols, warnings)


def build_boreholes(
    rows: list[list[Any]],
    mapping: ColumnMapping,
    coord_service: CoordinateService | None = None,
    coordinate_anchor: tuple[float, float] | None = None,
) -> tuple[list[dict], list[str]]:
    """확정 mapping → 캐노니컬 시추공 리스트(미리보기·검증용).

    각 시추공: name, longitude, latitude, source_crs, elevation,
               water_level_gl/el(있으면), strata[{상심도,하심도,지층명,_raw}].
    """
    cs = coord_service or CoordinateService()
    data = rows[mapping.header_row + 1:]
    row_crs_values = _row_crs_sequence(data, mapping)
    inv: dict[str, int] = {}
    for idx, role in mapping.roles.items():
        inv.setdefault(role, idx)

    issues: list[str] = []
    if mapping.fmt == "wide":
        out = [
            bh
            for ri, row in enumerate(data)
            if (bh := _wide_row(row, inv, mapping, ri, cs, issues, row_crs_values[ri]))
        ]
    elif mapping.fmt == "long":
        out = _long_rows(data, inv, mapping, cs, issues, row_crs_values)
    else:
        out = []
        issues.append("ambiguous 포맷 — 정규화 생략.")
    _auto_correct_coordinates_to_anchor(out, mapping, cs, issues, coordinate_anchor)
    return out, issues


def _row_crs_sequence(data: list[list[Any]], mapping: ColumnMapping) -> list[str | None]:
    """비고/CRS 표기를 다음 표기가 나올 때까지 행 방향으로 이어 붙인다."""
    if mapping.source_crs_explicit:
        return [mapping.source_crs] * len(data)

    hint_indices = {
        idx
        for idx, header in enumerate(mapping.headers)
        if header and _CRS_HINT_HEADER.search(header)
    }
    hint_indices.update(idx for idx, role in mapping.roles.items() if role == "crs")
    year_index = next(
        (
            idx
            for idx, header in enumerate(mapping.headers)
            if re.search(r"연도|년도|year", header, re.IGNORECASE)
        ),
        None,
    )

    current = mapping.source_crs
    result: list[str | None] = []
    for row in data:
        for idx in sorted(hint_indices):
            detected = _normalize_crs_hint(_cell(row, idx), year=_cell(row, year_index))
            if detected:
                current = detected
                break
        result.append(current)
    return result


def _coords(row, inv, mapping, cs, label, issues, row_crs=None):
    mapped_row_crs = _normalize_crs_hint(_cell(row, inv.get("crs"))) if "crs" in inv else None
    row_crs = mapped_row_crs or row_crs
    if "lon" in inv and "lat" in inv:
        lon, lat = _num(_cell(row, inv["lon"])), _num(_cell(row, inv["lat"]))
        if lon is not None and lat is not None:
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                issues.append(f"{label}: 경위도 범위 오류(lon={lon}, lat={lat})")
                return None
            return lon, lat, row_crs or mapping.source_crs or "EPSG:4326"
    if "x" in inv and "y" in inv:
        x, y = _num(_cell(row, inv["x"])), _num(_cell(row, inv["y"]))
        if x is not None and y is not None:
            original_x, original_y = x, y
            x, x_scaled = _normalize_tm_scale(x)
            y, y_scaled = _normalize_tm_scale(y)
            if x_scaled:
                issues.append(f"{label}: X 좌표 10배 스케일 자동 보정({original_x} → {x})")
            if y_scaled:
                issues.append(f"{label}: Y 좌표 10배 스케일 자동 보정({original_y} → {y})")
            crs = row_crs or mapping.source_crs or cs.detect_crs(x, y)
            if not crs:
                issues.append(f"{label}: 좌표계(CRS) 미확정 — 변환 불가")
                return None
            try:
                # CSV role mapping defines X as easting and Y as northing.
                # Magnitude-based guessing is ambiguous around Busan because
                # both swapped orders can still produce a point in Korea.
                lon, lat = cs.to_wgs84(
                    x,
                    y,
                    crs,
                    coordinate_order="easting_northing",
                )
                return lon, lat, crs
            except Exception as e:  # noqa: BLE001
                issues.append(f"{label}: 좌표 변환 실패({e})")
                return None
    issues.append(f"{label}: 좌표 결측")
    return None


def _water(row, inv) -> dict:
    out: dict = {}
    if "water_gl" in inv:
        out["water_level_gl"] = _num(_cell(row, inv["water_gl"]))
    if "water_el" in inv:
        out["water_level_el"] = _num(_cell(row, inv["water_el"]))
    if "water_level" in inv and "water_gl" not in inv and "water_el" not in inv:
        out["water_level_gl"] = _num(_cell(row, inv["water_level"]))
    return out


def _identity_text(value) -> str:
    return " ".join(str(value or "").strip().split())


def _wide_row(row, inv, mapping, ri, cs, issues, row_crs=None) -> dict | None:
    name = (
        str(_cell(row, inv["name"])).strip()
        if "name" in inv and _cell(row, inv["name"])
        else f"ROW-{ri + 1}"
    )
    co = _coords(row, inv, mapping, cs, name, issues, row_crs)
    if co is None:
        return None
    lon, lat, crs = co
    elevation = _num(_cell(row, inv.get("elevation")))

    strata: list[dict] = []
    depth = 0.0
    for idx, grp in mapping.stratum_cols:  # 파일 컬럼 순서 = 상부→하부
        t = _num(row[idx]) if idx < len(row) else None
        if t is None or t <= 0:
            continue  # 결측/없는 지층 제외 (실측 없는 지층은 적재하지 않음)
        strata.append({
            "상심도": round(depth, 3),
            "하심도": round(depth + t, 3),
            "지층명": _group_kr(mapping.headers[idx]),
            "_raw": mapping.headers[idx],
        })
        depth = round(depth + t, 3)

    strata = _merge_adjacent(strata)
    if not strata:
        issues.append(f"{name}: 유효 지층 0 — 제외")
        return None
    if "total_depth" in inv:
        td = _num(_cell(row, inv["total_depth"]))
        if td and abs(td - depth) > 0.5:
            issues.append(f"{name}: 두께합({depth}) ≠ 시추심도({td}) [Δ{round(td - depth, 2)}]")

    bh = {
        "project_name": str(_cell(row, inv.get("project_name")) or "").strip() or None,
        "name": name,
        "longitude": lon,
        "latitude": lat,
        "source_crs": crs,
        "raw_x": _normalize_tm_scale(_num(_cell(row, inv.get("x"))))[0] if "x" in inv else lon,
        "raw_y": _normalize_tm_scale(_num(_cell(row, inv.get("y"))))[0] if "y" in inv else lat,
        "elevation": elevation,
        "strata": strata,
    }
    bh.update(_water(row, inv))
    return bh


def _long_rows(data, inv, mapping, cs, issues, row_crs_values=None) -> list[dict]:
    groups: dict[tuple[str, str, str, str], dict] = {}
    for ri, row in enumerate(data):
        name = (
            str(_cell(row, inv["name"])).strip()
            if "name" in inv and _cell(row, inv["name"])
            else f"ROW-{ri + 1}"
        )
        project_name = str(_cell(row, inv.get("project_name")) or "").strip() or None
        x_identity = _cell(row, inv.get("x")) if "x" in inv else _cell(row, inv.get("lon"))
        y_identity = _cell(row, inv.get("y")) if "y" in inv else _cell(row, inv.get("lat"))
        group_key = (
            _identity_text(project_name),
            _identity_text(name),
            _identity_text(x_identity),
            _identity_text(y_identity),
        )
        dt = _num(_cell(row, inv.get("depth_top")))
        dbm = _num(_cell(row, inv.get("depth_bottom")))
        soil = str(_cell(row, inv.get("soil_type")) or "").strip()
        if dt is None or dbm is None or dbm <= dt:
            issues.append(f"{name} r{ri + 1}: 심도 이상(top={dt},bot={dbm}) — 행 제외")
            continue
        if group_key not in groups:
            row_crs = row_crs_values[ri] if row_crs_values else None
            co = _coords(row, inv, mapping, cs, name, issues, row_crs)
            g = {
                "project_name": project_name,
                "name": name,
                "longitude": co[0] if co else None,
                "latitude": co[1] if co else None,
                "source_crs": co[2] if co else None,
                "raw_x": (
                    _normalize_tm_scale(_num(_cell(row, inv.get("x"))))[0]
                    if "x" in inv
                    else _num(_cell(row, inv.get("lon")))
                ),
                "raw_y": (
                    _normalize_tm_scale(_num(_cell(row, inv.get("y"))))[0]
                    if "y" in inv
                    else _num(_cell(row, inv.get("lat")))
                ),
                "elevation": _num(_cell(row, inv.get("elevation"))),
                "strata": [],
            }
            g.update(_water(row, inv))
            groups[group_key] = g
        groups[group_key]["strata"].append({
            "상심도": dt, "하심도": dbm, "지층명": _group_kr(soil), "_raw": soil,
        })
    out = []
    for g in groups.values():
        if g["strata"] and g["longitude"] is not None and g["latitude"] is not None:
            g["strata"] = _merge_adjacent(g["strata"])
            out.append(g)
    return out


def to_persist_rows(boreholes: list[dict]) -> list[dict]:
    """캐노니컬 시추공 → PdfService.persist_rows 입력(long-row) 스키마.

    지하수위는 현재 DB 컬럼이 없어 적재 행에는 포함하지 않는다(추후 지하수위
    지층 작업 시 별도 컬럼/테이블 추가 후 연결). 좌표는 이미 WGS84.
    """
    rows: list[dict] = []
    for b in boreholes:
        for s in b["strata"]:
            rows.append({
                "시추공명": b["name"],
                "lon_wgs84": b["longitude"],
                "lat_wgs84": b["latitude"],
                "표고": b.get("elevation"),
                "water_level_gl": b.get("water_level_gl"),
                "water_level_el": b.get("water_level_el"),
                "meta_crs": b.get("source_crs"),
                "survey_name": b.get("project_name"),
                "상심도": s["상심도"],
                "하심도": s["하심도"],
                "지층명": s["지층명"],
            })
    return rows

