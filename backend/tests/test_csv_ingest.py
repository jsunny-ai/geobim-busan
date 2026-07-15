"""csv_ingest 파서 단위 테스트 (DB 불필요).

wide/long 포맷, 토사 병합, 좌표계 확정 경고, 인코딩, 결측 처리, persist_rows
스키마를 검증한다.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import openpyxl
import pytest

from app.services import csv_ingest as ci
from app.services import pdf_service


def _write(content: bytes, suffix: str) -> str:
    f = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    f.write(content)
    f.close()
    return f.name


def _wide_csv() -> str:
    text = (
        "공번,X,Y,표고(m),수위(GL.-m),수위(EL.m),매립층,퇴적층,풍화토,풍화암,연암,경암,시추심도\n"
        "BH-1,203057.478,280763.68,122.4,7.2,115.2,0.6,-,21.4,5.2,13.1,-,40.3\n"
        "BH-2,203097.523,280824.797,105.18,2.4,102.78,0.8,3.1,2.1,0.5,17,-,23.5\n"
    )
    return _write(("﻿" + text).encode("utf-8"), ".csv")


def _long_cp949() -> str:
    text = (
        "시추공명,경도,위도,표고,상심도,하심도,지층명\n"
        "DH-1,127.1,37.5,50,0,2.5,매립토\n"
        "DH-1,127.1,37.5,50,2.5,8.0,퇴적층\n"
        "DH-1,127.1,37.5,50,8.0,15.0,풍화암\n"
    )
    return _write(text.encode("cp949"), ".csv")


# --- wide 포맷 ----------------------------------------------------------------
def test_wide_format_detected_and_converted():
    rows = ci.read_table(_wide_csv())
    m = ci.infer_mapping(rows)
    assert m.fmt == "wide"
    bhs, issues = ci.build_boreholes(rows, m)
    assert len(bhs) == 2
    bh1 = next(b for b in bhs if b["name"] == "BH-1")
    # 토사 세분류 보존: 매립층과 풍화토를 토사로 합치지 않는다.
    assert bh1["strata"][0]["지층명"] == "매립토"
    assert bh1["strata"][0]["상심도"] == 0.0
    assert bh1["strata"][0]["하심도"] == 0.6
    # 두께합 = 시추심도(40.3) → 교차검증 경고 없음
    assert not any("시추심도" in i for i in issues)


def test_wide_missing_layer_excluded():
    rows = ci.read_table(_wide_csv())
    m = ci.infer_mapping(rows)
    bhs, _ = ci.build_boreholes(rows, m)
    bh1 = next(b for b in bhs if b["name"] == "BH-1")
    # 결측 지층은 제외하고, 토사 세분류는 서로 병합하지 않는다.
    assert [s["지층명"] for s in bh1["strata"]] == ["매립토", "풍화토", "풍화암", "연암"]


def test_water_levels_preserved():
    rows = ci.read_table(_wide_csv())
    m = ci.infer_mapping(rows)
    bhs, _ = ci.build_boreholes(rows, m)
    bh1 = next(b for b in bhs if b["name"] == "BH-1")
    assert bh1["water_level_gl"] == 7.2
    assert bh1["water_level_el"] == 115.2


def test_xy_requires_crs_confirmation_warning():
    rows = ci.read_table(_wide_csv())
    m = ci.infer_mapping(rows)  # source_crs 미지정
    assert any("좌표계" in w for w in m.warnings)


def test_crs_is_detected_from_korean_remark_and_converted_to_busan():
    path = _write(
        (
            "공번,X,Y,매립층,풍화암,비고\n"
            'BH-1,203057.478,280763.68,1.0,2.0,"동부(60만,20만)"\n'
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.infer_mapping(rows)
    assert mapping.source_crs == "EPSG:5187"
    assert not any("반드시 확정" in warning for warning in mapping.warnings)

    boreholes, issues = ci.build_boreholes(rows, mapping)
    assert not issues
    assert abs(boreholes[0]["longitude"] - 129.033543) < 0.00001
    assert abs(boreholes[0]["latitude"] - 35.1232024) < 0.00001


def test_explicit_crs_overrides_remark_detection():
    path = _write(
        (
            "공번,X,Y,매립층,풍화암,비고\n"
            'BH-1,203057.478,280763.68,1.0,2.0,"동부(60만,20만)"\n'
        ).encode("utf-8"),
        ".csv",
    )
    mapping = ci.infer_mapping(ci.read_table(path), source_crs="EPSG:5186")
    assert mapping.source_crs == "EPSG:5186"


def test_project_name_and_per_row_crs_columns_are_supported():
    path = _write(
        (
            "조사명,공번,X,Y,좌표계,매립층,풍화암\n"
            '부산조사,BH-1,203057.478,280763.68,"동부(60만,20만)",1,2\n'
            '서울조사,BH-2,203057.478,280763.68,EPSG:5186,1,2\n'
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.infer_mapping(rows)
    assert "project_name" in mapping.roles.values()
    assert "crs" in mapping.roles.values()
    assert not any("반드시 확정" in warning for warning in mapping.warnings)

    boreholes, issues = ci.build_boreholes(rows, mapping)
    assert not issues
    assert boreholes[0]["project_name"] == "부산조사"
    assert boreholes[0]["source_crs"] == "EPSG:5187"
    assert boreholes[1]["project_name"] == "서울조사"
    assert boreholes[1]["source_crs"] == "EPSG:5186"
    assert abs(boreholes[0]["longitude"] - boreholes[1]["longitude"] - 2.0) < 0.001


def test_crs_remark_is_forward_filled_until_next_investigation():
    path = _write(
        (
            "공번,X,Y,매립층,풍화암,비고\n"
            'A-1,203057.478,280763.68,1,2,"동부(60만,20만)"\n'
            "A-2,203097.523,280824.797,1,2,\n"
            'B-1,203057.478,280763.68,1,2,"중부(60만,20만)"\n'
            "B-2,203097.523,280824.797,1,2,\n"
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.infer_mapping(rows)
    boreholes, issues = ci.build_boreholes(rows, mapping)

    assert not issues
    assert [borehole["source_crs"] for borehole in boreholes] == [
        "EPSG:5187",
        "EPSG:5187",
        "EPSG:5186",
        "EPSG:5186",
    ]
    assert boreholes[0]["longitude"] > 129
    assert boreholes[1]["longitude"] > 129
    assert boreholes[2]["longitude"] < 128
    assert boreholes[3]["longitude"] < 128


def test_50man_crs_uses_row_year_to_choose_grs80_or_bessel():
    path = _write(
        (
            "연도,공번,X,Y,매립층,풍화암,비고\n"
            '2015,NEW-1,202694.38,180282.03,1,2,"동부(50만,20만)"\n'
            '1992,OLD-1,202694.38,180282.03,1,2,"동부(50만,20만)"\n'
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    boreholes, issues = ci.build_boreholes(rows, ci.infer_mapping(rows))
    assert not issues
    assert boreholes[0]["source_crs"] == "EPSG:5183"
    assert boreholes[1]["source_crs"] == "EPSG:5176"


def test_50man_crs_without_year_defaults_to_grs80():
    path = _write(
        (
            "공번,X,Y,매립층,풍화암,비고\n"
            'BH-1,202694.38,180282.03,1,2,"동부(50만,20만)"\n'
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    boreholes, issues = ci.build_boreholes(rows, ci.infer_mapping(rows))
    assert not issues
    assert boreholes[0]["source_crs"] == "EPSG:5183"


def test_50man_csv_x_easting_y_northing_matches_busanjin_location():
    path = _write(
        (
            "공번,X,Y,매립층,풍화암,비고\n"
            'NH-1,204075.3,179625.3,1,2,"동부(50만,20만)"\n'
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    boreholes, issues = ci.build_boreholes(rows, ci.infer_mapping(rows))

    assert not issues
    assert boreholes[0]["source_crs"] == "EPSG:5183"
    assert boreholes[0]["longitude"] == pytest.approx(129.04470366, abs=1e-6)
    assert boreholes[0]["latitude"] == pytest.approx(35.11293782, abs=1e-6)


def test_isolated_ten_times_tm_coordinate_is_corrected():
    path = _write(
        (
            "공번,X,Y,매립층,풍화암,비고\n"
            'BH-22,2040401.48,181071.1,4,2,"동부(50만,20만)"\n'
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    boreholes, issues = ci.build_boreholes(rows, ci.infer_mapping(rows))

    assert len(boreholes) == 1
    assert boreholes[0]["raw_x"] == pytest.approx(204040.148)
    assert 124 <= boreholes[0]["longitude"] <= 132
    assert 33 <= boreholes[0]["latitude"] <= 39
    assert any("10배 스케일 자동 보정" in issue for issue in issues)


# --- long 포맷 + 인코딩 -------------------------------------------------------
def test_long_format_cp949_and_merge():
    rows = ci.read_table(_long_cp949())
    m = ci.infer_mapping(rows)
    assert m.fmt == "long"
    bhs, _ = ci.build_boreholes(rows, m)
    assert len(bhs) == 1
    dh1 = bhs[0]
    # 매립토+퇴적층은 서로 다른 토사 세분류이므로 병합하지 않는다.
    assert [s["지층명"] for s in dh1["strata"]] == ["매립토", "퇴적토", "풍화암"]
    assert dh1["strata"][0]["하심도"] == 2.5
    assert dh1["source_crs"] == "EPSG:4326"


def test_long_format_keeps_same_name_coordinate_when_survey_differs():
    path = _write(
        (
            "survey name,hole,longitude,latitude,top,bottom,soil\n"
            "Survey A,BH-1,127.1,37.5,0,2,sand\n"
            "Survey B,BH-1,127.1,37.5,0,2,clay\n"
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.infer_mapping(rows)
    boreholes, issues = ci.build_boreholes(rows, mapping)

    assert not issues
    assert len(boreholes) == 2
    assert {b["project_name"] for b in boreholes} == {"Survey A", "Survey B"}


# --- persist_rows 스키마 ------------------------------------------------------
def test_to_persist_rows_schema():
    rows = ci.read_table(_long_cp949())
    m = ci.infer_mapping(rows)
    bhs, _ = ci.build_boreholes(rows, m)
    bhs[0]["project_name"] = "Survey A"
    pr = ci.to_persist_rows(bhs)
    assert pr, "행이 비어 있으면 안 됨"
    keys = set(pr[0])
    assert "survey_name" in keys
    assert pr[0]["survey_name"] == "Survey A"
    assert {"시추공명", "lon_wgs84", "lat_wgs84", "표고", "meta_crs", "상심도", "하심도", "지층명"} <= keys


# --- 역할 오버라이드 ----------------------------------------------------------
def test_role_override_ignore_column():
    rows = ci.read_table(_wide_csv())
    m = ci.infer_mapping(rows)
    m = ci.apply_overrides(m, {"표고(m)": "ignore"})
    bhs, _ = ci.build_boreholes(rows, m)
    assert bhs[0]["elevation"] is None


def test_manual_override_recovers_ambiguous_long_format():
    path = _write(
        (
            "hole_id,lng,latitude_value,start,end,material\n"
            "BH-X,127.1,37.5,0,3,fill\n"
        ).encode(),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.infer_mapping(rows)
    assert mapping.fmt == "ambiguous"

    mapping = ci.apply_overrides(
        mapping,
        {
            "hole_id": "name",
            "lng": "lon",
            "latitude_value": "lat",
            "start": "depth_top",
            "end": "depth_bottom",
            "material": "soil_type",
        },
    )
    assert mapping.fmt == "long"
    assert mapping.confidence > 0
    boreholes, issues = ci.build_boreholes(rows, mapping)
    assert not issues
    assert boreholes[0]["name"] == "BH-X"


def test_manual_arbitrary_stratum_header_is_supported():
    path = _write(
        "공번,경도,위도,Layer A\nBH-X,127.1,37.5,2.5\n".encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.apply_overrides(ci.infer_mapping(rows), {"Layer A": "stratum"})
    assert mapping.fmt == "wide"
    boreholes, _ = ci.build_boreholes(rows, mapping)
    assert boreholes[0]["strata"][0]["지층명"] == "Layer A"


def test_wide_soil_detail_columns_are_preserved_for_busan_csv():
    path = _write(
        (
            "공번,X,Y,표고(m),매립층,붕적층,퇴적층,퇴적점토,퇴적모래,퇴적자갈,풍화토,풍화암,연암,시추심도\n"
            "BH-1,203057.48,280763.68,122.4,0.6,1.2,2.0,0.8,0.9,1.1,3.0,4.0,5.0,18.6\n"
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    mapping = ci.infer_mapping(rows, source_crs="EPSG:5187")
    boreholes, issues = ci.build_boreholes(rows, mapping)

    assert not issues
    assert [s["지층명"] for s in boreholes[0]["strata"]] == [
        "매립토",
        "붕적토",
        "퇴적토",
        "퇴적점토",
        "퇴적모래",
        "퇴적자갈",
        "풍화토",
        "풍화암",
        "연암",
    ]


def test_ragged_row_and_invalid_coordinate_are_reported_not_crashed():
    path = _write(
        (
            "시추공명,경도,위도,상심도,하심도,지층명\n"
            "SHORT,127.1\n"
            "BAD,999,37.5,0,2,토사\n"
        ).encode("utf-8"),
        ".csv",
    )
    rows = ci.read_table(path)
    boreholes, issues = ci.build_boreholes(rows, ci.infer_mapping(rows))
    assert boreholes == []
    assert any("좌표" in issue for issue in issues)
    assert any("경위도 범위 오류" in issue for issue in issues)


def test_xlsx_first_sheet_is_read(tmp_path: Path):
    path = tmp_path / "sample.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["시추공명", "경도", "위도", "상심도", "하심도", "지층명"])
    sheet.append(["XLSX-1", 127.1, 37.5, 0, 2, "토사"])
    workbook.save(path)
    workbook.close()

    rows = ci.read_table(str(path))
    mapping = ci.infer_mapping(rows)
    boreholes, issues = ci.build_boreholes(rows, mapping)
    assert not issues
    assert boreholes[0]["name"] == "XLSX-1"


def test_preview_borehole_preserves_raw_coordinates():
    rows = ci.read_table(_wide_csv())
    mapping = ci.infer_mapping(rows, source_crs="EPSG:5186")
    boreholes, _ = ci.build_boreholes(rows, mapping)
    assert boreholes[0]["raw_x"] == 203057.478
    assert boreholes[0]["raw_y"] == 280763.68


def test_survey_key_policy_distinguishes_same_name_same_coordinate_surveys():
    assert pdf_service._same_survey("Survey A", " Survey   A ")
    assert not pdf_service._same_survey("Survey A", "Survey B")
    assert pdf_service._same_survey(None, "Survey A", allow_missing=True)
    assert not pdf_service._same_survey(None, "Survey A")


def test_project_anchor_corrects_unhinted_busan_east_belt_coordinates():
    rows = [
        ["hole", "X", "Y", "fill"],
        ["B-233", "204053.922", "280068.112", "1.0"],
    ]
    mapping = ci.ColumnMapping(
        fmt="wide",
        roles={0: "name", 1: "x", 2: "y"},
        stratum_cols=[(3, "soil")],
        header_row=0,
        headers=["hole", "X", "Y", "fill"],
    )

    boreholes, issues = ci.build_boreholes(
        rows,
        mapping,
        coordinate_anchor=(129.043, 35.115),
    )

    assert boreholes[0]["source_crs"] == "EPSG:5187"
    assert boreholes[0]["longitude"] == pytest.approx(129.0444713, abs=1e-6)
    assert boreholes[0]["latitude"] == pytest.approx(35.1169293, abs=1e-6)
    assert any("coordinate auto-corrected" in issue for issue in issues)


def test_project_anchor_corrects_swapped_busan_tm_coordinates():
    rows = [
        ["hole", "X", "Y", "fill"],
        ["KGBH-1", "180376.91", "204281.62", "1.0"],
    ]
    mapping = ci.ColumnMapping(
        fmt="wide",
        roles={0: "name", 1: "x", 2: "y"},
        stratum_cols=[(3, "soil")],
        header_row=0,
        headers=["hole", "X", "Y", "fill"],
    )

    boreholes, issues = ci.build_boreholes(
        rows,
        mapping,
        coordinate_anchor=(129.043, 35.115),
    )

    assert boreholes[0]["source_crs"] == "EPSG:5183"
    assert boreholes[0]["longitude"] == pytest.approx(129.0469708, abs=1e-6)
    assert boreholes[0]["latitude"] == pytest.approx(35.1197117, abs=1e-6)
    assert any("order=yx" in issue for issue in issues)
