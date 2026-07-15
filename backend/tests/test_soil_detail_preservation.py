from app.services.pdf_service import _normalize_stratum_name, _split_strata_lines
from app.services.normalization import normalize_soil_detail, normalize_strata_group
from pdf_convert.core.table_merger import merge_multi_page_tables
from pdf_convert.parsers.pdf_parser_odl import normalize_strata_name


def test_normalization_maps_soil_details_to_soil_group_without_losing_detail():
    assert normalize_soil_detail("매립층") == "매립토"
    assert normalize_soil_detail("붕적층") == "붕적토"
    assert normalize_soil_detail("퇴적점토") == "퇴적점토"
    assert normalize_soil_detail("퇴적모래") == "퇴적모래"
    assert normalize_soil_detail("퇴적자갈") == "퇴적자갈"
    assert normalize_soil_detail("풍화토") == "풍화토"

    for name in ["매립토", "붕적토", "퇴적토", "퇴적점토", "퇴적모래", "퇴적자갈", "풍화토"]:
        assert normalize_strata_group(name) == "soil"


def test_pdf_parser_preserves_soil_details():
    assert normalize_strata_name("매립층") == "매립층"
    assert normalize_strata_name("퇴적토") == "퇴적토"
    assert normalize_strata_name("충적층") == "충적층"
    assert normalize_strata_name("풍화토") == "풍화토"
    assert normalize_strata_name("사질토") == "사질토"
    assert normalize_strata_name("CL") == "점토"
    assert normalize_strata_name("SW") == "모래"


def test_manual_pdf_normalizer_preserves_soil_details():
    assert _normalize_stratum_name("매립층") == "매립토"
    assert _normalize_stratum_name("퇴적층") == "퇴적토"
    assert _normalize_stratum_name("충적층") == "충적토"
    assert _normalize_stratum_name("잔류토") == "풍화토"
    assert _normalize_stratum_name("점성토") == "점토"
    assert _split_strata_lines("매립층\n퇴적층\n풍화암") == ["매립토", "퇴적토", "풍화암"]


def test_table_merger_does_not_collapse_soil_details_to_soil():
    rows = [{
        "page": 1,
        "data": [
            {"프로젝트명": "P", "시추공명": "BH-1", "상심도": 0.0, "하심도": 1.0, "지층명": "매립토"},
            {"프로젝트명": "P", "시추공명": "BH-1", "상심도": 1.0, "하심도": 2.0, "지층명": "퇴적토"},
            {"프로젝트명": "P", "시추공명": "BH-1", "상심도": 2.0, "하심도": 3.0, "지층명": "풍화토"},
        ],
    }]

    merged = merge_multi_page_tables(rows)

    assert [row["지층명"] for row in merged] == ["매립토", "퇴적토", "풍화토"]
