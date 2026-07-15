"""PDF extraction service backed by the ported PDF_Convert engine."""

from __future__ import annotations

import os
import re
import logging
import hashlib
from collections import defaultdict
from pathlib import Path
from typing import Any

import fitz
from geoalchemy2.elements import WKTElement
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.models import Borehole, GroundwaterObservation, ProjectBoreholeLink, Stratum
from app.services.odl_normalizer import (
    PdfElement,
    TextLine,
    find_elements_in_box,
    flatten_odl_json,
    group_elements_into_lines,
    text_from_elements,
)
from app.services.groundwater import normalize_groundwater_values
from app.services.odl_pdf_service import OdlPdfService
from app.services.ocr_provider_service import extract_page_ocr
from pdf_convert.core.coordinate_transformer import normalize_coordinates
from pdf_convert.core.table_merger import STRATA_GROUP_MAP
from pdf_convert.core.master_hybrid_extractor import MasterHybridExtractor
from pdf_convert.parsers.hwp_indexed_extractor import clean_float, normalize_bh_id, normalize_strata, parse_coordinates


_OCR_BOX_MIN_OVERLAP = 0.05
logger = logging.getLogger(__name__)
_TERMINATION_DEPTH_RE = re.compile(
    r"(?:심도|depth)\s*[:：]?\s*([-+]?(?:\d+(?:[,.]\d+)?|[,.]\s*\d+))\s*(?:m|M|ｍ)?\s*(?:에서)?\s*(?:시추\s*종료|종료)"
)


class PdfService:
    """Run PDF_Convert and persist normalized borehole/stratum records."""

    def __init__(self, *, output_dir: str | None = None, java_bin: str | None = None) -> None:
        backend_dir = Path(__file__).resolve().parents[2]
        configured_dir = Path(output_dir or settings.pdf_convert_data_dir)
        if not configured_dir.is_absolute():
            configured_dir = backend_dir / configured_dir

        self.output_dir = str(configured_dir)
        self.java_bin = java_bin or settings.java_bin_path or None
        os.environ.setdefault("PDF_CONVERT_DATA_DIR", os.path.join(self.output_dir, "data"))
        self.last_odl_metadata: dict[str, Any] | None = None
        self.last_manual_ocr_metadata: dict[str, Any] | None = None

    def auto_extract(self, pdf_path: str, project_name: str) -> list[dict[str, Any]]:
        """Run the automatic hybrid extraction pipeline."""
        extractor = MasterHybridExtractor(output_dir=self.output_dir, java_bin=self.java_bin)
        rows = extractor.process_file(pdf_path, project_name)
        if not rows:
            raise ValueError("PDF에서 유효한 시추공/지층 데이터를 추출하지 못했습니다.")
        return rows

    def run_extraction(
        self,
        *,
        db: Session,
        pdf_path: str,
        project_id: int,
        project_name: str,
    ) -> dict[str, Any]:
        """Extract rows and persist them to Borehole/Stratum tables."""
        rows = self.auto_extract(pdf_path, project_name)
        created = self.persist_rows(db=db, rows=rows, project_id=project_id, source_file=pdf_path)
        return {
            "project_id": project_id,
            "project_name": project_name,
            "borehole_count": created["borehole_count"],
            "stratum_count": created["stratum_count"],
            "replaced_borehole_count": created.get("replaced_borehole_count", 0),
            "quality": assess_extraction_quality(rows),  # [이상 PDF 자동분류]
            "source_file": pdf_path,
        }

    def preview_extraction(
        self,
        *,
        db: Session,
        pdf_path: str,
        project_id: int,
        project_name: str,
    ) -> dict[str, Any]:
        """Extract rows and return a review payload without saving boreholes."""
        rows = self.auto_extract(pdf_path, project_name)
        summary = _summarize_rows(rows)
        return {
            "project_id": project_id,
            "project_name": project_name,
            "source_file": pdf_path,
            "borehole_count": summary["borehole_count"],
            "stratum_count": summary["stratum_count"],
            "quality": assess_extraction_quality(rows),  # [이상 PDF 자동분류]
            "rows": rows,
        }

    def persist_rows(
        self,
        *,
        db: Session,
        rows: list[dict[str, Any]],
        project_id: int,
        source_file: str,
        is_supplementary: bool = False,
        job_id: int | None = None,
    ) -> dict[str, int]:
        grouped: dict[tuple[str | None, str, float | None, float | None], list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            name = str(row.get("시추공명") or "UNKNOWN").strip() or "UNKNOWN"
            lon = _to_float(row.get("lon_wgs84"))
            lat = _to_float(row.get("lat_wgs84"))
            survey_name = _row_survey_name(row)
            # Borehole names are not globally unique. Design-company files
            # commonly reuse BH-1, BH-2, ... across different survey groups.
            # Keep same-name boreholes separate by their physical position.
            group_key = (
                _survey_key(survey_name),
                name,
                round(lon, 7) if lon is not None else None,
                round(lat, 7) if lat is not None else None,
            )
            grouped[group_key].append(row)

        borehole_count = 0
        created_borehole_count = 0
        linked_borehole_count = 0
        replaced_borehole_count = 0
        duplicate_count = 0
        stratum_count = 0
        groundwater_observation_count = 0
        for (_group_survey_key, name, _group_lon, _group_lat), borehole_rows in grouped.items():
            first = borehole_rows[0]
            lon = _to_float(first.get("lon_wgs84"))
            lat = _to_float(first.get("lat_wgs84"))
            if lon is None or lat is None:
                raise ValueError(f"{name} 좌표가 없어 DB에 저장할 수 없습니다.")

            _validate_wgs84_coordinates(name, lon, lat)
            survey_name = _row_survey_name(first)

            elevation = _to_float(first.get("표고"))
            # [재추출 덮어쓰기/upsert] 같은 source_file + 공명 + 좌표(2m) = 같은 PDF의
            #   동일 시추공 재추출. 기존 strata를 삭제하고 새 값으로 교체한다.
            #   이 경로가 없으면, 값이 바뀐(예: 하심도 2540→40) 재추출은 지층
            #   시그니처가 달라 중복으로 안 잡혀 '오염 공 + 정상 공'이 중복 생성되고
            #   오염 레코드가 남는다. (source_file 기준이므로 타 보고서의 동일 공
            #   중복 링크 로직과는 분리된다.)
            same_src = _find_same_source_borehole(
                db,
                source_file=source_file,
                name=name,
                lon=lon,
                lat=lat,
                survey_name=survey_name,
            )
            if same_src is not None:
                for stale in list(same_src.strata):
                    db.delete(stale)
                same_src.elevation = elevation
                same_src.source_crs = _to_text(first.get("meta_crs"))
                same_src.survey_name = survey_name
                borehole = same_src
                db.flush()
                borehole_count += 1
                replaced_borehole_count += 1
                _ensure_project_link(
                    db,
                    project_id=project_id,
                    borehole_id=borehole.id,
                    project_role="new" if is_supplementary else "existing",
                    linked_reason="reextracted",
                    job_id=job_id,
                )
            else:
                duplicate = _find_duplicate_borehole(
                    db,
                    project_id=project_id,
                    name=name,
                    lon=lon,
                    lat=lat,
                    elevation=elevation,
                    rows=borehole_rows,
                    survey_name=survey_name,
                )
                if duplicate is not None:
                    borehole = duplicate
                    duplicate_count += 1
                    _ensure_project_link(
                        db,
                        project_id=project_id,
                        borehole_id=borehole.id,
                        project_role="duplicate_linked",
                        linked_reason="duplicate_detected",
                        job_id=job_id,
                    )
                    linked_borehole_count += 1
                    borehole_count += 1
                    stratum_count += len([row for row in borehole_rows if _valid_stratum_row(row)])
                    groundwater_observation_count += int(
                        _persist_groundwater_observation(
                            db,
                            borehole=borehole,
                            row=first,
                            source_file=source_file,
                            job_id=job_id,
                        )
                    )
                    continue

                borehole = Borehole(
                    project_id=project_id,
                    name=name,
                    location=WKTElement(f"POINT({lon} {lat})", srid=4326),
                    elevation=elevation,
                    source_crs=_to_text(first.get("meta_crs")),
                    source_file=source_file,
                    survey_name=survey_name,
                    is_supplementary=is_supplementary,
                    data_origin=(
                        "user_upload"
                        if any(part in str(source_file) for part in ("temp_uploads", "csv_uploads"))
                        else "public"
                    ),
                )
                db.add(borehole)
                db.flush()
                borehole_count += 1
                created_borehole_count += 1

                _ensure_project_link(
                    db,
                    project_id=project_id,
                    borehole_id=borehole.id,
                    project_role="new" if is_supplementary else "existing",
                    linked_reason="pdf_uploaded" if is_supplementary else "migrated",
                    job_id=job_id,
                )

            groundwater_observation_count += int(
                _persist_groundwater_observation(
                    db,
                    borehole=borehole,
                    row=first,
                    source_file=source_file,
                    job_id=job_id,
                )
            )

            # 공통 strata 삽입 (신규 생성 · 재추출 덮어쓰기 공용)
            seen_strata: set[tuple[float, float, str]] = set()
            for row in sorted(borehole_rows, key=lambda r: _to_float(r.get("상심도")) or 0.0):
                depth_top = _to_float(row.get("상심도"))
                depth_bottom = _to_float(row.get("하심도"))
                soil_type = _to_text(row.get("지층명")) or "미분류"
                if depth_top is None or depth_bottom is None or depth_bottom <= depth_top:
                    continue
                stratum_key = (round(depth_top, 6), round(depth_bottom, 6), soil_type)
                if stratum_key in seen_strata:
                    continue
                seen_strata.add(stratum_key)

                db.add(
                    Stratum(
                        borehole_id=borehole.id,
                        depth_top=depth_top,
                        depth_bottom=depth_bottom,
                        soil_type=soil_type,
                        raw_text=str(row),
                        source_file=source_file,
                    )
                )
                stratum_count += 1

        if borehole_count == 0 or stratum_count == 0:
            raise ValueError("저장 가능한 시추공 또는 지층 데이터가 없습니다.")

        return {
            "borehole_count": borehole_count,
            "created_borehole_count": created_borehole_count,
            "linked_borehole_count": linked_borehole_count,
            "replaced_borehole_count": replaced_borehole_count,
            "duplicate_count": duplicate_count,
            "stratum_count": stratum_count,
            "groundwater_observation_count": groundwater_observation_count,
        }

    def extract_with_template(
        self,
        pdf_path: str,
        box_definitions: dict[str, Any],
        *,
        odl_elements: list[PdfElement] | None = None,
        ocr_cache: dict[int, list[PdfElement]] | None = None,
    ) -> dict[str, str]:
        """Extract text using normalized page boxes."""
        ocr_cache = ocr_cache if ocr_cache is not None else {}
        doc = fitz.open(pdf_path)
        try:
            result: dict[str, str] = {}
            for box in box_definitions.get("boxes", []):
                label = box["label"]
                page_index = int(box["page"]) - 1
                rect = box["rect"]
                page = doc[page_index]
                width, height = page.rect.width, page.rect.height
                clip = fitz.Rect(
                    rect[0] * width,
                    rect[1] * height,
                    rect[2] * width,
                    rect[3] * height,
                )
                text = page.get_text("text", clip=clip).strip()
                odl_text = _extract_odl_text_for_box(odl_elements, page, box)
                ocr_text = _extract_ocr_text_for_box(ocr_cache, page, box)
                text = _choose_best_box_text(
                    pymupdf_text=text,
                    odl_text=odl_text,
                    ocr_text=ocr_text,
                    field=str(label),
                )
                result[label] = text
            return result
        finally:
            doc.close()

    def extract_rows_with_template(
        self,
        pdf_path: str,
        box_definitions: dict[str, Any],
        project_name: str,
    ) -> list[dict[str, Any]]:
        """Extract normalized rows from user-drawn field/column boxes."""
        odl_elements = self._load_odl_elements(pdf_path) if settings.pdf_manual_odl_enabled else None
        if not settings.pdf_manual_odl_enabled:
            self.last_odl_metadata = {"ok": False, "available": False, "skipped": "manual_odl_disabled"}
        ocr_cache: dict[int, list[PdfElement]] = {}
        if _uses_auto_page_classification(box_definitions):
            rows = self.extract_rows_with_page_templates(
                pdf_path,
                box_definitions,
                project_name,
                odl_elements=odl_elements,
                ocr_cache=ocr_cache,
            )
            self.last_manual_ocr_metadata = _ocr_cache_metadata(ocr_cache)
            return rows

        fields = self.extract_with_template(
            pdf_path,
            box_definitions,
            odl_elements=odl_elements,
            ocr_cache=ocr_cache,
        )
        meta = _metadata_from_fields(fields, project_name)

        doc = fitz.open(pdf_path)
        try:
            lines = _extract_lines_for_boxes(
                doc,
                box_definitions.get("boxes", []),
                odl_elements=odl_elements,
                ocr_cache=ocr_cache,
            )
            fields["final_depth"] = _termination_depth_for_page(doc[0], ocr_cache) or ""
        finally:
            doc.close()

        rows, _ = _rows_from_manual_fields(fields=fields, meta=meta, previous_bottom=0.0, lines=lines)
        rows = _merge_adjacent_strata_rows(rows)

        if not rows:
            raise ValueError("저장 가능한 지층 행을 만들지 못했습니다.")
        self.last_manual_ocr_metadata = _ocr_cache_metadata(ocr_cache)
        return rows

    def extract_rows_with_page_templates(
        self,
        pdf_path: str,
        box_definitions: dict[str, Any],
        project_name: str,
        *,
        odl_elements: list[PdfElement] | None = None,
        ocr_cache: dict[int, list[PdfElement]] | None = None,
    ) -> list[dict[str, Any]]:
        """Apply first/continuation page templates across all PDF pages."""
        ocr_cache = ocr_cache if ocr_cache is not None else {}
        boxes = box_definitions.get("boxes", [])
        page_mode = box_definitions.get("page_mode") or "split"
        first_boxes = [box for box in boxes if box.get("template") == "first"]
        continuation_boxes = [] if page_mode == "same" else [
            box for box in boxes if box.get("template") == "continuation"
        ]
        if not first_boxes:
            raise ValueError("첫 페이지 형식 박스가 필요합니다.")

        borehole_boxes = [box for box in first_boxes if box.get("label") == "borehole_name"]
        if not borehole_boxes:
            raise ValueError("첫 페이지 형식에는 시추공명 박스가 필요합니다.")

        doc = fitz.open(pdf_path)
        try:
            rows: list[dict[str, Any]] = []
            current_meta: dict[str, Any] | None = None
            previous_bottom = 0.0
            inferred_borehole_index = 0

            for page_number in range(1, len(doc) + 1):
                first_fields = _extract_fields_on_page(
                    doc,
                    page_number,
                    first_boxes,
                    odl_elements=odl_elements,
                    ocr_cache=ocr_cache,
                )
                detected_borehole = _normalize_borehole_name(first_fields.get("borehole_name"))
                first_lines = _extract_lines_on_page(
                    doc,
                    page_number,
                    first_boxes,
                    odl_elements=odl_elements,
                    ocr_cache=ocr_cache,
                )
                reset_start = (
                    detected_borehole is None
                    and current_meta is not None
                    and _looks_like_new_borehole_by_depth_reset(
                        fields=first_fields,
                        lines=first_lines,
                        meta=current_meta,
                        previous_bottom=previous_bottom,
                    )
                )
                repeated_current_borehole = (
                    detected_borehole is not None
                    and current_meta is not None
                    and detected_borehole == current_meta.get("borehole_name")
                )
                is_start_page = (detected_borehole is not None and not repeated_current_borehole) or reset_start

                if is_start_page or current_meta is None:
                    current_meta = _metadata_from_fields(first_fields, project_name)
                    if detected_borehole:
                        detected_index = _borehole_index_from_name(detected_borehole)
                        expected_index = inferred_borehole_index + 1
                        if detected_index is not None and detected_index > expected_index:
                            current_meta["borehole_name"] = f"BH-{expected_index}"
                            inferred_borehole_index = expected_index
                        else:
                            current_meta["borehole_name"] = detected_borehole
                            inferred_borehole_index = max(
                                inferred_borehole_index,
                                detected_index or inferred_borehole_index,
                            )
                    elif reset_start or current_meta["borehole_name"] == "BH-1":
                        inferred_borehole_index += 1
                        current_meta["borehole_name"] = f"BH-{inferred_borehole_index}"
                    previous_bottom = 0.0
                    page_fields = dict(first_fields)
                    page_lines = first_lines

                    if not _has_table_fields(page_fields) and continuation_boxes:
                        page_fields.update(
                            _extract_fields_on_page(
                                doc,
                                page_number,
                                continuation_boxes,
                                odl_elements=odl_elements,
                                ocr_cache=ocr_cache,
                            )
                        )
                        page_lines.update(
                            _extract_lines_on_page(
                                doc,
                                page_number,
                                continuation_boxes,
                                odl_elements=odl_elements,
                                ocr_cache=ocr_cache,
                            )
                        )
                else:
                    table_boxes = continuation_boxes or _table_boxes(first_boxes)
                    page_fields = _extract_fields_on_page(
                        doc,
                        page_number,
                        table_boxes,
                        odl_elements=odl_elements,
                        ocr_cache=ocr_cache,
                    )
                    page_lines = _extract_lines_on_page(
                        doc,
                        page_number,
                        table_boxes,
                        odl_elements=odl_elements,
                        ocr_cache=ocr_cache,
                    )

                if current_meta is None:
                    continue

                page_fields["final_depth"] = _termination_depth_for_page(doc[page_number - 1], ocr_cache) or ""
                page_rows, previous_bottom = _rows_from_manual_fields(
                    fields=page_fields,
                    meta=current_meta,
                    previous_bottom=previous_bottom,
                    lines=page_lines,
                )
                rows.extend(page_rows)
        finally:
            doc.close()

        rows = _merge_adjacent_strata_rows(rows)
        if not rows:
            raise ValueError("저장 가능한 지층 행을 만들지 못했습니다.")
        return rows

    def _load_odl_elements(self, pdf_path: str) -> list[PdfElement] | None:
        """Load optional ODL JSON elements for manual box text correction."""
        metadata = OdlPdfService().extract_json_with_metadata(
            pdf_path,
            job_key=Path(pdf_path).parent.name,
        )
        self.last_odl_metadata = {key: value for key, value in metadata.items() if key != "data"}
        if not metadata.get("ok"):
            return None
        return flatten_odl_json(metadata.get("data"))


def _persist_groundwater_observation(
    db: Session,
    *,
    borehole: Borehole,
    row: dict[str, Any],
    source_file: str,
    job_id: int | None,
) -> bool:
    """Normalize and upsert one committed groundwater observation."""

    depth = _to_float(row.get("water_level_gl"))
    if depth is None:
        depth = _to_float(row.get("지하수위"))
    head = _to_float(row.get("water_level_el"))
    if depth is None and head is None:
        return False

    elevation = _to_float(row.get("표고"))
    if elevation is None:
        elevation = _to_float(borehole.elevation)
    depth, head, inconsistent = normalize_groundwater_values(
        elevation_m=elevation,
        depth_bgl_m=depth,
        head_elevation_m=head,
    )
    if depth is None and head is None:
        return False

    reference_datum = "GL+EL" if row.get("water_level_gl") not in (None, "") and row.get("water_level_el") not in (None, "") else (
        "EL" if row.get("water_level_el") not in (None, "") else "GL"
    )
    source_kind = "csv" if "csv_uploads" in str(source_file) else "pdf"
    if job_id is not None:
        observation_key = f"job:{job_id}:borehole:{borehole.id}"
    else:
        identity = f"{source_file}|{borehole.id}|{depth}|{head}"
        observation_key = f"source:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"

    observation = db.execute(
        select(GroundwaterObservation).where(
            GroundwaterObservation.observation_key == observation_key
        )
    ).scalar_one_or_none()
    if observation is None:
        observation = GroundwaterObservation(
            borehole_id=borehole.id,
            extraction_job_id=job_id,
            observation_key=observation_key,
            reference_datum=reference_datum,
            source_kind=source_kind,
        )
        db.add(observation)

    observation.depth_bgl_m = depth
    observation.head_elevation_m = head
    observation.raw_value = depth if reference_datum != "EL" else head
    observation.raw_text = str(
        {
            "water_level_gl": row.get("water_level_gl", row.get("지하수위")),
            "water_level_el": row.get("water_level_el"),
        }
    )
    source_page = _to_float(row.get("groundwater_source_page"))
    observation.source_page = int(source_page) if source_page is not None else None
    observation.source_bbox = (
        row.get("groundwater_source_bbox")
        if isinstance(row.get("groundwater_source_bbox"), (dict, list))
        else None
    )
    observation.confidence = _to_float(row.get("groundwater_confidence"))
    observation.review_status = "needs_review" if inconsistent else "confirmed"
    observation.deleted_at = None
    return True


def _ensure_project_link(
    db: Session,
    *,
    project_id: int,
    borehole_id: int,
    project_role: str,
    linked_reason: str,
    job_id: int | None,
) -> ProjectBoreholeLink:
    link = db.execute(
        select(ProjectBoreholeLink).where(
            ProjectBoreholeLink.project_id == project_id,
            ProjectBoreholeLink.borehole_id == borehole_id,
            ProjectBoreholeLink.deleted_at.is_(None),
        )
    ).scalar_one_or_none()
    if link is None:
        link = ProjectBoreholeLink(
            project_id=project_id,
            borehole_id=borehole_id,
            project_role=project_role,
            linked_reason=linked_reason,
            registered_from_job_id=job_id,
        )
        db.add(link)
        return link

    if link.project_role == "excluded":
        return link
    # Preserve an explicit new registration over a later duplicate detection.
    if link.project_role != "new":
        link.project_role = project_role
        link.linked_reason = linked_reason
    if link.registered_from_job_id is None:
        link.registered_from_job_id = job_id
    return link


# 자동 생성/미인식 시추공명 패턴 (예: pdf_parser_odl 폴백 "시추-3", 빈값, UNKNOWN)
_AUTO_NAME_RE = re.compile(r"^\s*시추-\d+\s*$")


def assess_extraction_quality(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """추출 결과의 신뢰도를 자동 판정해 '전면실패/이상 PDF'를 분류한다.

    page116류(표 인식 실패) 사례의 특징:
      · 시추공명이 전부 "시추-N"(자동생성) 또는 빈값/UNKNOWN → ID 추출 실패
      · 모든 공이 동일한 큰 심도값(예 500m) → 표 구조 오인식
      · 이상심도(하심도>100m 또는 단일층 두께>50m) 비율이 높음
    하나라도 임계 초과 시 is_anomalous=True 로 표시하고 사유를 남긴다.
    (스키마 변경 없이 job.result 안에 실려 검토 UI에서 경고로 노출 가능)
    """
    from collections import defaultdict, Counter

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        name = str(r.get("시추공명") or "").strip()
        grouped[name].append(r)

    n_bh = len(grouped)
    if n_bh == 0:
        return {"is_anomalous": True, "reasons": ["추출된 시추공이 없음"], "stats": {}}

    auto_named = sum(
        1 for name in grouped
        if (not name) or _AUTO_NAME_RE.match(name) or name.upper() in ("UNKNOWN", "N/A")
    )
    auto_ratio = auto_named / n_bh

    n_str = n_anom = 0
    max_depths: list[float] = []
    for rs in grouped.values():
        bottoms = [b for b in (_to_float(r.get("하심도")) for r in rs) if b is not None]
        if bottoms:
            max_depths.append(max(bottoms))
        for r in rs:
            t, b = _to_float(r.get("상심도")), _to_float(r.get("하심도"))
            if t is None or b is None:
                continue
            n_str += 1
            if b > 100 or (b - t) > 50:
                n_anom += 1
    anom_ratio = (n_anom / n_str) if n_str else 1.0

    uniform_val = None
    if len(max_depths) >= 3:
        val, cnt = Counter(round(d, 1) for d in max_depths).most_common(1)[0]
        if val > 100 and cnt / len(max_depths) >= 0.6:
            uniform_val = val

    reasons: list[str] = []
    if auto_ratio >= 0.5:
        reasons.append(f"시추공명 미인식 {auto_named}/{n_bh} ({auto_ratio:.0%})")
    if anom_ratio >= 0.3:
        reasons.append(f"이상심도 비율 {n_anom}/{n_str} ({anom_ratio:.0%})")
    if uniform_val is not None:
        reasons.append(f"동일 심도값({uniform_val}m)이 과반 — 표 인식 실패 의심")

    return {
        "is_anomalous": bool(reasons),
        "reasons": reasons,
        "stats": {
            "boreholes": n_bh,
            "auto_named": auto_named,
            "strata": n_str,
            "depth_anomalies": n_anom,
        },
    }


def _find_same_source_borehole(
    db: Session,
    *,
    source_file: str,
    name: str,
    lon: float,
    lat: float,
    survey_name: str | None = None,
) -> Borehole | None:
    """같은 source_file + 같은 공명 + 좌표 근접(2m) = 같은 PDF의 동일 시추공.

    재추출 시 기존 strata를 교체(덮어쓰기)하기 위한 매칭이다. _find_duplicate_borehole
    과 달리 '지층 시그니처'를 보지 않으므로, 값이 바뀐 재추출(예: 하심도 2540→40)도
    동일 공으로 인식되어 오염값이 정정값으로 안전하게 교체된다.
    """
    point = func.ST_GeogFromText(f"SRID=4326;POINT({lon} {lat})")
    candidates = db.execute(
        select(Borehole)
        .options(selectinload(Borehole.strata))
        .where(
            Borehole.deleted_at.is_(None),
            Borehole.source_file == source_file,
            func.ST_DWithin(Borehole.location, point, 2.0),
        )
        .limit(50)
    ).scalars().all()

    target_name = _dedupe_name(name)
    for candidate in candidates:
        if not _same_survey(candidate.survey_name, survey_name, allow_missing=True):
            continue
        if _dedupe_name(candidate.name) == target_name:
            return candidate
    return None


def _find_duplicate_borehole(
    db: Session,
    *,
    project_id: int,
    name: str,
    lon: float,
    lat: float,
    elevation: float | None,
    rows: list[dict[str, Any]],
    survey_name: str | None = None,
) -> Borehole | None:
    project_link_exists = (
        select(ProjectBoreholeLink.id)
        .where(
            ProjectBoreholeLink.project_id == project_id,
            ProjectBoreholeLink.borehole_id == Borehole.id,
            ProjectBoreholeLink.deleted_at.is_(None),
            ProjectBoreholeLink.project_role != "excluded",
        )
        .exists()
    )
    point = func.ST_GeogFromText(f"SRID=4326;POINT({lon} {lat})")
    candidates = db.execute(
        select(Borehole)
        .options(selectinload(Borehole.strata))
        .where(
            Borehole.deleted_at.is_(None),
            or_(Borehole.project_id == project_id, project_link_exists),
            func.ST_DWithin(Borehole.location, point, 2.0),
        )
        .limit(50)
    ).scalars().all()

    target_name = _dedupe_name(name)
    target_signature = _rows_signature(rows)
    for candidate in candidates:
        if not _same_survey(candidate.survey_name, survey_name):
            continue
        if _dedupe_name(candidate.name) != target_name:
            continue
        if not _close_float(candidate.elevation, elevation, tolerance=0.05):
            continue
        if _strata_signature(candidate.strata) == target_signature:
            return candidate
    return None


def _valid_stratum_row(row: dict[str, Any]) -> bool:
    depth_top = _to_float(row.get("상심도"))
    depth_bottom = _to_float(row.get("하심도"))
    return depth_top is not None and depth_bottom is not None and depth_bottom > depth_top


def _merge_adjacent_strata_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for row in rows:
        if not _valid_stratum_row(row):
            continue
        current = dict(row)
        if not merged:
            merged.append(current)
            continue

        previous = merged[-1]
        previous_bottom = _to_float(previous.get("하심도"))
        current_top = _to_float(current.get("상심도"))
        if (
            previous.get("시추공명") == current.get("시추공명")
            and previous.get("지층명") == current.get("지층명")
            and _close_float(previous_bottom, current_top, tolerance=0.05)
            and _same_coordinate_context(previous, current)
        ):
            previous["하심도"] = current["하심도"]
            continue
        merged.append(current)
    return merged


def _same_coordinate_context(left: dict[str, Any], right: dict[str, Any]) -> bool:
    for key in ("lon_wgs84", "lat_wgs84", "tm_x", "tm_y"):
        left_value = _to_float(left.get(key))
        right_value = _to_float(right.get(key))
        if left_value is None and right_value is None:
            continue
        if not _close_float(left_value, right_value, tolerance=0.01):
            return False
    return True


def _rows_signature(rows: list[dict[str, Any]]) -> tuple[tuple[float, float, str], ...]:
    signature: list[tuple[float, float, str]] = []
    for row in sorted(rows, key=lambda r: _to_float(r.get("상심도")) or 0.0):
        depth_top = _to_float(row.get("상심도"))
        depth_bottom = _to_float(row.get("하심도"))
        if depth_top is None or depth_bottom is None or depth_bottom <= depth_top:
            continue
        signature.append((
            round(depth_top, 2),
            round(depth_bottom, 2),
            normalize_strata(_to_text(row.get("지층명")) or "미분류"),
        ))
    return tuple(signature)


def _strata_signature(strata: list[Stratum]) -> tuple[tuple[float, float, str], ...]:
    return tuple(
        (
            round(s.depth_top, 2),
            round(s.depth_bottom, 2),
            normalize_strata(s.soil_type),
        )
        for s in sorted(strata, key=lambda item: item.depth_top)
    )


def _row_survey_name(row: dict[str, Any]) -> str | None:
    return _to_text(row.get("survey_name") or row.get("project_name"))


def _survey_key(value: Any) -> str | None:
    text = _to_text(value)
    if not text:
        return None
    return re.sub(r"\s+", " ", text).strip().casefold()


def _same_survey(left: Any, right: Any, *, allow_missing: bool = False) -> bool:
    left_key = _survey_key(left)
    right_key = _survey_key(right)
    if allow_missing and (left_key is None or right_key is None):
        return True
    return left_key == right_key


def _dedupe_name(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def _close_float(left: float | None, right: float | None, *, tolerance: float) -> bool:
    if left is None and right is None:
        return True
    if left is None or right is None:
        return False
    return abs(left - right) <= tolerance


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.upper() == "N/A":
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return None


def _validate_wgs84_coordinates(name: str, lon: float | None, lat: float | None) -> None:
    if lon is None or lat is None:
        raise ValueError(f"{name} 좌표 변환 결과가 없어 DB에 저장할 수 없습니다.")
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise ValueError(f"{name} 좌표 범위가 올바르지 않습니다. lon={lon}, lat={lat}")
    if not (124.0 <= lon <= 132.0 and 33.0 <= lat <= 39.0):
        raise ValueError(f"{name} 좌표가 한국 영역 범위를 벗어났습니다. lon={lon}, lat={lat}")


def _to_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.upper() == "N/A":
        return None
    return text


def _summarize_rows(rows: list[dict[str, Any]]) -> dict[str, int]:
    boreholes = {
        str(row.get("시추공명") or "UNKNOWN").strip() or "UNKNOWN"
        for row in rows
    }
    valid_strata = 0
    for row in rows:
        depth_top = _to_float(row.get("상심도"))
        depth_bottom = _to_float(row.get("하심도"))
        if depth_top is not None and depth_bottom is not None and depth_bottom > depth_top:
            valid_strata += 1
    return {"borehole_count": len(boreholes), "stratum_count": valid_strata}


def _split_lines(value: Any) -> list[str]:
    text = _to_text(value)
    if not text:
        return []
    return [line.strip() for line in text.replace("\r", "\n").split("\n") if line.strip()]


_DEPTH_NUMBER_RE = re.compile(r"[-+]?(?:\d+(?:[,.]\d+)?|[,.]\s*\d+)")

_STRATA_TOKEN_RE = re.compile(
    r"(유기질토|점토질모래|사질점토|매립층|매립토|퇴적층|퇴적토|충적층|충적토|풍화토|잔류토|점성토|점토|실트|사질토|모래|역질토|자갈|풍화암|보통암|리핑암|발파암|화강암|연암|경암|토사)"
)

_STRATA_ALIASES = {
    "매립층": "매립토",
    "퇴적층": "퇴적토",
    "충적층": "충적토",
    "잔류토": "풍화토",
    "점성토": "점토",
    "사질토": "모래",
    "역질토": "자갈",
    "이탄": "유기질토",
    "부식토": "유기질토",
    "리핑암": "연암",
    "발파암": "경암",
    "화강암": "경암",
    "풍화앙": "풍화암",
    "연앙": "연암",
    "연임": "연암",
}

_STRATA_TITLE_TOKEN_RE = re.compile(
    r"(유기질토|점토질모래|사질점토|매립층|매립토|퇴적층|퇴적토|충적층|충적토|풍화토|잔류토|점성토|점토|실트|사질토|모래|역질토|자갈|풍화암|풍화앙|보통암|리핑암|발파암|화강암|연암|연앙|연임|경암|토사)"
)


def _split_depth_values(value: Any) -> list[str]:
    text = _to_text(value)
    if not text:
        return []

    values: list[str] = []
    for line in _split_lines(text):
        normalized = (
            line.replace("O", "0")
            .replace("o", "0")
            .replace("|", " ")
            .replace("_", " ")
        )
        matches = _DEPTH_NUMBER_RE.findall(normalized)
        for match in matches:
            cleaned = re.sub(r"\s+", "", match).replace(",", ".")
            if cleaned.startswith("."):
                cleaned = cleaned[1:]
            if cleaned.endswith("."):
                cleaned = cleaned[:-1]
            if clean_float(cleaned) is not None:
                values.append(cleaned)
    return values


def _split_strata_lines(value: Any) -> list[str]:
    lines = _split_lines(value)
    if not lines:
        return []

    compact = re.sub(r"[^가-힣]", "", "".join(lines))
    tokens = _STRATA_TOKEN_RE.findall(compact)
    if tokens:
        return [_normalize_stratum_name(token) for token in tokens]

    normalized_lines = [_normalize_stratum_name(line) for line in lines]
    return normalized_lines


def _coordinates_from_fields(fields: dict[str, str]) -> tuple[Any, Any]:
    lon = _to_text(fields.get("x_coord")) or _to_text(fields.get("tm_x"))
    lat = _to_text(fields.get("y_coord")) or _to_text(fields.get("tm_y"))
    if lon and lat:
        return clean_float(lon) or lon, clean_float(lat) or lat

    combined = _to_text(fields.get("coordinates"))
    if combined:
        parsed_lon, parsed_lat = parse_coordinates(combined)
        if parsed_lon is not None and parsed_lat is not None:
            return parsed_lon, parsed_lat

    return lon, lat


def _normalize_stratum_name(value: Any) -> str:
    text = _to_text(value) or ""
    compact = re.sub(r"\s+", "", text)
    for alias, group in _STRATA_ALIASES.items():
        if alias in compact:
            return group
    normalized = normalize_strata(text)
    return STRATA_GROUP_MAP.get(normalized, normalized)


def _stratum_title_name(value: Any) -> str | None:
    compact = re.sub(r"[^가-힣]", "", _to_text(value) or "")
    if not compact:
        return None
    match = _STRATA_TITLE_TOKEN_RE.search(compact)
    if not match:
        return None
    return _normalize_stratum_name(match.group(1))


def _depth_range_from_text(value: Any) -> tuple[float, float] | None:
    text = (_to_text(value) or "").replace(",", ".")
    matches = re.findall(
        r"(\d+(?:\.\d+)?)\s*(?:~|-|–|—)\s*(\d+(?:\.\d+)?)",
        text,
    )
    for raw_top, raw_bottom in matches:
        top = clean_float(_clean_range_depth_text(raw_top))
        bottom = clean_float(_clean_range_depth_text(raw_bottom))
        if top is None or bottom is None:
            continue
        bottom = _repair_missing_decimal_depth(
            bottom,
            current_bottom=top,
            next_raw_bottom=None,
            candidates={top, bottom},
        )
        if bottom > top:
            return top, bottom
    return None


def _clean_range_depth_text(value: str) -> str:
    cleaned = re.sub(r"\s+", "", value).replace(",", ".")
    if "." not in cleaned:
        return cleaned
    integer, fraction = cleaned.split(".", 1)
    if len(fraction) > 1 and fraction.endswith(("07", "01")):
        fraction = fraction[:-1]
    return f"{integer}.{fraction.rstrip('0') or '0'}"


def _uses_auto_page_classification(box_definitions: dict[str, Any]) -> bool:
    boxes = box_definitions.get("boxes", [])
    return (
        box_definitions.get("mode") == "auto_borehole_pages"
        or any(box.get("template") in {"first", "continuation"} for box in boxes)
    )


def _extract_fields_on_page(
    doc: fitz.Document,
    page_number: int,
    boxes: list[dict[str, Any]],
    *,
    odl_elements: list[PdfElement] | None = None,
    ocr_cache: dict[int, list[PdfElement]] | None = None,
) -> dict[str, str]:
    if page_number < 1 or page_number > len(doc):
        return {}
    page = doc[page_number - 1]
    result: dict[str, str] = {}
    for box in boxes:
        label = box.get("label")
        rect = box.get("rect")
        if not label or not rect or len(rect) != 4:
            continue
        width, height = page.rect.width, page.rect.height
        clip = fitz.Rect(
            float(rect[0]) * width,
            float(rect[1]) * height,
            float(rect[2]) * width,
            float(rect[3]) * height,
        )
        text = page.get_text("text", clip=clip).strip()
        odl_text = _extract_odl_text_for_box(odl_elements, page, box)
        ocr_text = _extract_ocr_text_for_box(ocr_cache, page, box)
        if not ocr_text and _uses_cropped_ocr_fallback(str(label)):
            ocr_text = _extract_cropped_ocr_text_for_box(page, box)
        text = _choose_best_box_text(
            pymupdf_text=text,
            odl_text=odl_text,
            ocr_text=ocr_text,
            field=str(label),
        )
        if text:
            result[label] = text
    return result


_TABLE_COLUMN_LABELS = {"depth", "bottom_depth", "top_depth", "stratum_name"}
_CROPPED_OCR_FALLBACK_LABELS = {
    "borehole_name",
    "coordinates",
    "x_coord",
    "y_coord",
    "elevation",
    "water_level_gl",
    "water_level_el",
    "crs",
}


def _uses_cropped_ocr_fallback(label: str) -> bool:
    return label in _CROPPED_OCR_FALLBACK_LABELS


def _extract_lines_on_page(
    doc: fitz.Document,
    page_number: int,
    boxes: list[dict[str, Any]],
    *,
    odl_elements: list[PdfElement] | None = None,
    ocr_cache: dict[int, list[PdfElement]] | None = None,
) -> dict[str, list[TextLine]]:
    """Return bbox-aware text lines per multi-row column box (심도/지층명 등).

    Single-value labels (e.g. borehole_name, elevation) don't need this — the
    plain joined text from `_extract_fields_on_page` is enough. Multi-row
    table columns need per-line bboxes so rows can be matched spatially
    (`_rows_from_spatial_lines`) instead of by fragile list-index pairing.
    """
    if page_number < 1 or page_number > len(doc):
        return {}
    page = doc[page_number - 1]
    result: dict[str, list[TextLine]] = {}
    for box in boxes:
        label = box.get("label")
        if label not in _TABLE_COLUMN_LABELS:
            continue
        rect = box.get("rect")
        if not rect or len(rect) != 4:
            continue
        lines = _lines_for_box(odl_elements=odl_elements, ocr_cache=ocr_cache, page=page, box=box)
        if lines:
            result[label] = lines
    return result


def _extract_lines_for_boxes(
    doc: fitz.Document,
    boxes: list[dict[str, Any]],
    *,
    odl_elements: list[PdfElement] | None = None,
    ocr_cache: dict[int, list[PdfElement]] | None = None,
) -> dict[str, list[TextLine]]:
    """Like `_extract_lines_on_page`, but boxes may reference different pages.

    Used by the single box-set extraction path (`extract_rows_with_template`),
    where each box carries its own `page` index rather than all boxes sharing
    one page (as in the first/continuation page-template flow).
    """
    by_page: dict[int, list[dict[str, Any]]] = {}
    for box in boxes:
        if box.get("label") not in _TABLE_COLUMN_LABELS:
            continue
        try:
            page_number = int(box["page"])
        except (KeyError, TypeError, ValueError):
            continue
        by_page.setdefault(page_number, []).append(box)

    result: dict[str, list[TextLine]] = {}
    for page_number, page_boxes in by_page.items():
        page_lines = _extract_lines_on_page(
            doc, page_number, page_boxes, odl_elements=odl_elements, ocr_cache=ocr_cache
        )
        for label, lines in page_lines.items():
            result.setdefault(label, lines)
    return result


def _extract_odl_text_for_box(
    odl_elements: list[PdfElement] | None,
    page: fitz.Page,
    box: dict[str, Any],
) -> str:
    if not odl_elements:
        return ""
    rect = box.get("rect")
    if not rect or len(rect) != 4:
        return ""
    width, height = page.rect.width, page.rect.height
    pdf_space_box = (
        float(rect[0]) * width,
        height - (float(rect[3]) * height),
        float(rect[2]) * width,
        height - (float(rect[1]) * height),
    )
    elements = find_elements_in_box(
        odl_elements,
        page_number=page.number + 1,
        box=pdf_space_box,
    )
    return text_from_elements(elements)


def _extract_ocr_text_for_box(
    ocr_cache: dict[int, list[PdfElement]] | None,
    page: fitz.Page,
    box: dict[str, Any],
) -> str:
    if ocr_cache is None:
        return ""
    rect = box.get("rect")
    if not rect or len(rect) != 4:
        return ""
    width, height = page.rect.width, page.rect.height
    pdf_space_box = (
        float(rect[0]) * width,
        height - (float(rect[3]) * height),
        float(rect[2]) * width,
        height - (float(rect[1]) * height),
    )
    page_number = page.number + 1
    if page_number not in ocr_cache:
        ocr_cache[page_number] = _ocr_elements_for_page(page)
    elements = find_elements_in_box(
        ocr_cache[page_number],
        page_number=page_number,
        box=pdf_space_box,
        min_overlap=_OCR_BOX_MIN_OVERLAP,
    )
    return text_from_elements(elements)


def _box_to_pdf_space(page: fitz.Page, box: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """Convert a normalized (0-1, top-left origin) box rect to PDF-space bbox (bottom-left origin)."""
    rect = box.get("rect")
    if not rect or len(rect) != 4:
        return None
    width, height = page.rect.width, page.rect.height
    return (
        float(rect[0]) * width,
        height - (float(rect[3]) * height),
        float(rect[2]) * width,
        height - (float(rect[1]) * height),
    )


def _odl_lines_for_box(
    odl_elements: list[PdfElement] | None,
    page: fitz.Page,
    box: dict[str, Any],
) -> list[TextLine]:
    """Return ODL-derived text lines (with bbox) overlapping the box, in visual order."""
    if not odl_elements:
        return []
    pdf_space_box = _box_to_pdf_space(page, box)
    if pdf_space_box is None:
        return []
    elements = find_elements_in_box(odl_elements, page_number=page.number + 1, box=pdf_space_box)
    return group_elements_into_lines(elements)


def _ocr_lines_for_box(
    ocr_cache: dict[int, list[PdfElement]] | None,
    page: fitz.Page,
    box: dict[str, Any],
) -> list[TextLine]:
    """Return OCR-derived text lines (with bbox) overlapping the box, in visual order."""
    if ocr_cache is None:
        return []
    pdf_space_box = _box_to_pdf_space(page, box)
    if pdf_space_box is None:
        return []
    page_number = page.number + 1
    if page_number not in ocr_cache:
        ocr_cache[page_number] = _ocr_elements_for_page(page)
    elements = find_elements_in_box(
        ocr_cache[page_number],
        page_number=page_number,
        box=pdf_space_box,
        min_overlap=_OCR_BOX_MIN_OVERLAP,
    )
    return group_elements_into_lines(elements)


def _lines_for_box(
    *,
    odl_elements: list[PdfElement] | None,
    ocr_cache: dict[int, list[PdfElement]] | None,
    page: fitz.Page,
    box: dict[str, Any],
) -> list[TextLine]:
    """Return the best available bbox-aware text lines for a box.

    Prefers whichever element-backed source (ODL text layer or OCR) detected
    more lines, since a richer line set is less likely to have merged rows
    together. Falls back to the other source when one is empty. Plain
    PyMuPDF text has no per-line bbox info and is intentionally not handled
    here — callers fall back to index-based pairing when this returns [].
    """
    odl_lines = _odl_lines_for_box(odl_elements, page, box)
    ocr_lines = _ocr_lines_for_box(ocr_cache, page, box)
    if odl_lines and ocr_lines:
        return odl_lines if len(odl_lines) >= len(ocr_lines) else ocr_lines
    return odl_lines or ocr_lines


def _ocr_elements_for_page(page: fitz.Page) -> list[PdfElement]:
    if not settings.pdf_box_ocr_enabled:
        return []
    return _provider_ocr_elements_for_page(page)


def _extract_cropped_ocr_text_for_box(page: fitz.Page, box: dict[str, Any]) -> str:
    if not settings.pdf_box_ocr_enabled:
        return ""
    clip = _expanded_clip_rect(page, box, padding_x=0.012, padding_y=0.008)
    if clip is None or clip.is_empty:
        return ""
    try:
        scale = max(float(settings.pdf_box_ocr_scale or 2.0), 4.0)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
        result = extract_page_ocr(
            image_bytes=pixmap.tobytes("png"),
            page_number=page.number + 1,
            page_width=clip.width,
            page_height=clip.height,
            image_width=pixmap.width,
            image_height=pixmap.height,
        )
        if result.error:
            logger.warning(
                "PDF cropped OCR warning: provider=%s available=%s error=%s",
                result.provider,
                result.available,
                result.error,
            )
        return text_from_elements(result.elements)
    except Exception as exc:
        logger.warning("PDF cropped OCR failed: %s", exc)
        return ""


def _expanded_clip_rect(
    page: fitz.Page,
    box: dict[str, Any],
    *,
    padding_x: float,
    padding_y: float,
) -> fitz.Rect | None:
    rect = box.get("rect")
    if not rect or len(rect) != 4:
        return None
    width, height = page.rect.width, page.rect.height
    left = max(0.0, (float(rect[0]) - padding_x) * width)
    top = max(0.0, (float(rect[1]) - padding_y) * height)
    right = min(width, (float(rect[2]) + padding_x) * width)
    bottom = min(height, (float(rect[3]) + padding_y) * height)
    if right <= left or bottom <= top:
        return None
    return fitz.Rect(left, top, right, bottom)


def _termination_depth_for_page(page: fitz.Page, ocr_cache: dict[int, list[PdfElement]] | None) -> str:
    """Read the drill-termination depth from page-level OCR, e.g. '심도 10.00 M 에서 시추종료'."""
    if ocr_cache is None:
        return ""
    page_number = page.number + 1
    if page_number not in ocr_cache:
        ocr_cache[page_number] = _ocr_elements_for_page(page)
    text = text_from_elements(ocr_cache[page_number])
    if not text:
        return ""
    compact = re.sub(r"\s+", " ", text)
    match = _TERMINATION_DEPTH_RE.search(compact)
    if not match:
        return ""
    cleaned = match.group(1).replace(",", ".")
    parsed = clean_float(cleaned)
    return f"{parsed:g}" if parsed is not None else ""


def _provider_ocr_elements_for_page(page: fitz.Page) -> list[PdfElement]:
    try:
        scale = max(float(settings.pdf_box_ocr_scale or 3.0), 1.0)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        image_bytes = pixmap.tobytes("png")
        result = extract_page_ocr(
            image_bytes=image_bytes,
            page_number=page.number + 1,
            page_width=page.rect.width,
            page_height=page.rect.height,
            image_width=pixmap.width,
            image_height=pixmap.height,
        )
        if result.error:
            logger.warning(
                "PDF box OCR warning: provider=%s available=%s error=%s",
                result.provider,
                result.available,
                result.error,
            )
        return result.elements
    except Exception:
        return []


def _ocr_cache_metadata(ocr_cache: dict[int, list[PdfElement]]) -> dict[str, Any]:
    return {
        "enabled": bool(settings.pdf_box_ocr_enabled),
        "provider": settings.pdf_ocr_provider,
        "tesseract_lang": settings.pdf_box_ocr_lang,
        "scale": settings.pdf_box_ocr_scale,
        "easyocr_langs": settings.pdf_easyocr_langs,
        "paddle_lang": settings.pdf_paddle_ocr_lang,
        "pages": sorted(ocr_cache.keys()),
        "word_count": sum(len(elements) for elements in ocr_cache.values()),
    }


def _choose_best_box_text(*, pymupdf_text: str, odl_text: str, ocr_text: str = "", field: str) -> str:
    pymupdf_text = (pymupdf_text or "").strip()
    odl_text = (odl_text or "").strip()
    ocr_text = (ocr_text or "").strip()
    candidates = [text for text in [pymupdf_text, odl_text, ocr_text] if text]
    if not candidates:
        return ""
    if len(candidates) == 1:
        return candidates[0]

    field = field.lower()
    if field in {
        "depth",
        "bottom_depth",
        "top_depth",
        "x_coord",
        "y_coord",
        "tm_x",
        "tm_y",
        "elevation",
        "water_level_gl",
        "water_level_el",
    }:
        return max(candidates, key=_numeric_text_score)
    if field in {"stratum_name", "soil_type"}:
        return max(candidates, key=_strata_text_score)
    if field in {"project_name", "borehole_name", "crs", "coordinates"}:
        return max(candidates, key=_general_text_score)
    return pymupdf_text


def _numeric_text_score(value: str) -> int:
    numbers = re.findall(r"[-+]?\d+(?:[,.]\d+)?", value)
    score = len(numbers) * 10
    score += min(len(value.strip()), 20)
    if re.search(r"\d\s*\n\s*\d", value):
        score -= 5
    return score


def _strata_text_score(value: str) -> int:
    compact = re.sub(r"\s+", "", value)
    tokens = _STRATA_TOKEN_RE.findall(compact)
    score = len(tokens) * 20
    lines = _split_lines(value)
    score += sum(10 for line in lines if _STRATA_TOKEN_RE.fullmatch(re.sub(r"\s+", "", line)))
    score += sum(1 for line in lines if _normalize_stratum_name(line) != "토사")
    score -= sum(3 for line in lines if len(re.sub(r"\s+", "", line)) == 1)
    score += min(len(compact), 30)
    return score


def _general_text_score(value: str) -> int:
    compact = re.sub(r"\s+", "", value)
    score = len(compact)
    if "�" in value:
        score -= 20
    if re.search(r"[가-힣A-Za-z0-9]", value):
        score += 10
    return score


def _normalize_borehole_name(value: Any) -> str | None:
    text = _to_text(value)
    if not text:
        return None
    for line in _split_lines(text):
        embedded = _extract_embedded_borehole_id(line)
        if embedded:
            return embedded
        if _looks_like_elevation_text(line):
            continue
        normalized = normalize_bh_id(line)
        if _looks_like_borehole_id(normalized):
            return normalized
    embedded = _extract_embedded_borehole_id(text)
    if embedded:
        return embedded
    if _looks_like_elevation_text(text):
        return None
    normalized = normalize_bh_id(text)
    if _looks_like_borehole_id(normalized):
        return normalized
    return None


def _extract_embedded_borehole_id(value: Any) -> str | None:
    text = str(value or "").upper()
    for match in re.finditer(r"\b(B\s*H|CH|NH|H|B)\s*-?\s*(\d+[A-Z0-9-]*)\b", text):
        prefix = re.sub(r"\s+", "", match.group(1))
        candidate = f"{prefix}-{match.group(2)}"
        normalized = normalize_bh_id(candidate)
        if _looks_like_borehole_id(normalized):
            return normalized
    compact = re.sub(r"\s+", "", str(value or ""))
    for match in re.finditer(r"[바배버비]\s*-?\s*(\d+[A-Za-z0-9-]*)", compact):
        normalized = normalize_bh_id(f"BH-{match.group(1)}")
        if _looks_like_borehole_id(normalized):
            return normalized
    return None


def _looks_like_elevation_text(value: Any) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    if re.search(r"(표고|지반고|EL\.?|ELEV|ELEVATION|GROUND\s*LEVEL)", text, re.IGNORECASE):
        return True
    return bool(re.fullmatch(r"[-+]?\d+(?:[.,]\d+)?\s*(?:m|M)?", text))


def _looks_like_borehole_id(value: Any) -> bool:
    text = str(value or "").strip().upper()
    if not text:
        return False
    if not any(ch.isdigit() for ch in text):
        return False
    if not re.search(r"[A-Z]", text):
        return False
    if re.fullmatch(r"EL\d+|ELEV\d+|GL\d+", text):
        return False
    match = re.fullmatch(r"([A-Z]{1,4})-?\d+[A-Z0-9-]*", text)
    if not match:
        return False
    return match.group(1) in {"BH", "SBH", "NH", "CH", "H"}


def _metadata_from_fields(fields: dict[str, str], fallback_project_name: str) -> dict[str, Any]:
    borehole_name = _normalize_borehole_name(fields.get("borehole_name")) or "BH-1"
    source_crs = _to_text(fields.get("crs"))
    raw_x, raw_y = _coordinates_from_fields(fields)
    lon, lat, tmx, tmy, final_epsg = normalize_coordinates(
        raw_x,
        raw_y,
        borehole_id=borehole_name,
        source_crs=source_crs,
    )
    return {
        "project_name": _to_text(fields.get("project_name")) or fallback_project_name,
        "borehole_name": borehole_name,
        "raw_x": raw_x,
        "raw_y": raw_y,
        "elevation": clean_float(fields.get("elevation")),
        "water_level_gl": clean_float(fields.get("water_level_gl")),
        "water_level_el": clean_float(fields.get("water_level_el")),
        "lon_wgs84": lon,
        "lat_wgs84": lat,
        "tm_x": tmx,
        "tm_y": tmy,
        "meta_crs": final_epsg,
    }


def _has_table_fields(fields: dict[str, str]) -> bool:
    return bool(_split_lines(fields.get("depth")) or _split_lines(fields.get("bottom_depth"))) and bool(
        _split_lines(fields.get("stratum_name"))
    )


def _looks_like_new_borehole_by_depth_reset(
    *,
    fields: dict[str, str],
    lines: dict[str, list[TextLine]],
    meta: dict[str, Any],
    previous_bottom: float,
) -> bool:
    if previous_bottom < 4.0:
        return False
    if previous_bottom >= 10.0 and _has_zero_based_depth_range(fields=fields, lines=lines):
        return True

    candidate_rows, _ = _rows_from_manual_fields(
        fields=fields,
        meta=meta,
        previous_bottom=0.0,
        lines=lines,
    )
    if not candidate_rows:
        return False

    first = candidate_rows[0]
    top = _to_float(first.get("상심도"))
    bottom = _to_float(first.get("하심도"))
    if bottom is None:
        return False
    if top is not None and top > 1.0:
        return False

    reset_margin = max(1.0, previous_bottom * 0.10)
    return bottom <= previous_bottom - reset_margin


def _has_zero_based_depth_range(*, fields: dict[str, str], lines: dict[str, list[TextLine]]) -> bool:
    texts = [str(value or "") for value in fields.values()]
    texts.extend(line.text for group in lines.values() for line in group)
    compact = re.sub(r"\s+", "", "\n".join(texts))
    return bool(re.search(r"(?<![\d,.])0(?:[,.]0+)?[~\\-](?:\d|[,.])+", compact))


def _borehole_index_from_name(value: Any) -> int | None:
    text = str(value or "").upper()
    match = re.search(r"(\d+)", text)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _table_boxes(boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [box for box in boxes if box.get("label") in {"depth", "bottom_depth", "top_depth", "stratum_name"}]


def _depth_value_from_line(text: str) -> float | None:
    """Parse the first plausible depth number out of a single text line."""
    for value in _depth_values_from_line(text):
        parsed = clean_float(value)
        if parsed is not None:
            return parsed
    return None


def _depth_values_from_line(text: str) -> list[str]:
    return _split_depth_values(text)


def _decimal_depth_candidates_from_text(value: Any) -> set[float]:
    text = _to_text(value)
    if not text:
        return set()

    candidates: set[float] = set()
    for match in re.findall(r"[-+]?\d+[,.]\d+", text):
        normalized = match.replace(",", ".")
        parsed = clean_float(normalized)
        if parsed is None or parsed <= 0:
            continue
        candidates.add(round(parsed, 2))
        candidates.add(round(parsed, 1))
        if "." in normalized:
            whole, fraction = normalized.split(".", 1)
            if fraction.endswith(("7", "1")) and len(fraction) > 1:
                artifact = clean_float(f"{whole}.{fraction[:-1]}")
                if artifact is not None and artifact > 0:
                    candidates.add(round(artifact, 2))
                    candidates.add(round(artifact, 1))
    return candidates


def _decimal_depth_candidates_from_lines(lines: list[TextLine], final_depth: float | None = None) -> set[float]:
    candidates: set[float] = set()
    for line in lines:
        candidates.update(_decimal_depth_candidates_from_text(line.text))
    if final_depth is not None and final_depth > 0:
        candidates.add(round(final_depth, 2))
        candidates.add(round(final_depth, 1))
    return candidates


def _close_depth(left: float, right: float, *, tolerance: float = 0.06) -> bool:
    return abs(left - right) <= tolerance


def _matches_depth_candidate(value: float, candidates: set[float]) -> bool:
    return any(_close_depth(value, candidate) for candidate in candidates)


def _missing_decimal_variants(value: float) -> list[float]:
    if value < 10 or abs(value - round(value)) > 0.001:
        return []

    integer_text = str(int(round(value)))
    variants: list[float] = []
    if value >= 10:
        variants.append(value / 10.0)
    if value >= 100:
        variants.append(value / 100.0)
    if len(integer_text) == 3 and integer_text.startswith("1"):
        variants.append(int(integer_text[1:]) / 10.0)

    unique: list[float] = []
    for variant in variants:
        rounded = round(variant, 2)
        if rounded > 0 and all(not _close_depth(rounded, existing) for existing in unique):
            unique.append(rounded)
    return unique


def _repair_missing_decimal_depth(
    value: float,
    *,
    current_bottom: float,
    next_raw_bottom: float | None,
    candidates: set[float],
) -> float:
    variants = [
        variant
        for variant in _missing_decimal_variants(value)
        if variant > current_bottom + 0.001
    ]
    if not variants:
        return value

    sequence_break = next_raw_bottom is not None and next_raw_bottom > current_bottom and next_raw_bottom < value
    if _matches_depth_candidate(value, candidates) and (not sequence_break or current_bottom > 0):
        return value

    matched = [variant for variant in variants if _matches_depth_candidate(variant, candidates)]
    if matched:
        if next_raw_bottom is not None:
            before_next = [variant for variant in matched if variant < next_raw_bottom]
            if before_next:
                return max(before_next)
        return min(matched, key=lambda variant: abs(variant - value / 10.0))

    if sequence_break:
        before_next = [variant for variant in variants if variant < next_raw_bottom]
        if before_next:
            return max(before_next)

    return value


def _y_overlap_ratio(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    """Vertical overlap between two bboxes, relative to the shorter one's height."""
    bottom = max(a[1], b[1])
    top = min(a[3], b[3])
    if top <= bottom:
        return 0.0
    shortest = min(a[3] - a[1], b[3] - b[1])
    if shortest <= 0:
        return 0.0
    return (top - bottom) / shortest


def _match_line_by_position(anchor: TextLine, candidates: list[TextLine]) -> TextLine | None:
    """Pick the candidate line whose vertical position best matches the anchor.

    Prefers the candidate with the largest vertical overlap; if none overlap,
    falls back to the candidate whose vertical center is closest. This lets a
    stratum-name cell that visually spans several depth rows (a merged cell)
    correctly match each of those rows, instead of drifting out of alignment
    the way plain index-based pairing does once one column has a different
    number of detected lines than another.
    """
    if not candidates:
        return None
    best = max(candidates, key=lambda cand: _y_overlap_ratio(anchor.bbox, cand.bbox))
    if _y_overlap_ratio(anchor.bbox, best.bbox) > 0:
        return best
    return min(candidates, key=lambda cand: abs(cand.y_center - anchor.y_center))


def _next_stratum_line_after_anchor(strata_lines: list[TextLine], anchor: TextLine | None) -> TextLine | None:
    """Find the layer name visually below the last depth anchor for final-depth repair."""
    if not strata_lines:
        return None
    if anchor is None:
        return strata_lines[-1]
    below = [line for line in strata_lines if line.y_center < anchor.y_center]
    if below:
        return max(below, key=lambda line: line.y_center)
    return strata_lines[-1]


def _stratum_segments_from_lines(strata_lines: list[TextLine]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for line in strata_lines:
        name = _stratum_title_name(line.text)
        if not name:
            continue
        depth_range = _depth_range_from_text(line.text)
        segments.append(
            {
                "name": name,
                "y": line.y_center,
                "top": depth_range[0] if depth_range else None,
                "bottom": depth_range[1] if depth_range else None,
            }
        )
    return sorted(segments, key=lambda segment: -float(segment["y"]))


def _stratum_name_for_anchor(
    *,
    anchor: TextLine,
    top: float,
    bottom: float,
    strata_lines: list[TextLine],
    segments: list[dict[str, Any]],
) -> str:
    for segment in segments:
        segment_top = segment.get("top")
        segment_bottom = segment.get("bottom")
        if segment_top is None or segment_bottom is None:
            continue
        if top >= float(segment_top) - 0.05 and bottom <= float(segment_bottom) + 0.08:
            return str(segment["name"])

    above = [segment for segment in segments if float(segment["y"]) >= anchor.y_center - 2.0]
    if above:
        return str(min(above, key=lambda segment: float(segment["y"]) - anchor.y_center)["name"])

    strata_match = _match_line_by_position(anchor, strata_lines)
    title_name = _stratum_title_name(strata_match.text if strata_match else None)
    if title_name:
        return title_name
    return _normalize_stratum_name(strata_match.text if strata_match else None)


def _refine_rows_with_stratum_ranges(
    *,
    rows: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    meta: dict[str, Any],
    start_depth: float,
    end_depth: float,
) -> list[dict[str, Any]]:
    ranged_segments = [
        segment
        for segment in segments
        if segment.get("top") is not None
        and segment.get("bottom") is not None
        and float(segment["bottom"]) > start_depth
        and float(segment["top"]) < end_depth
    ]
    if not rows or not ranged_segments:
        return rows

    breakpoints = {round(start_depth, 3), round(end_depth, 3)}
    for row in rows:
        top = _to_float(row.get("상심도"))
        bottom = _to_float(row.get("하심도"))
        if top is not None and start_depth <= top <= end_depth:
            breakpoints.add(round(top, 3))
        if bottom is not None and start_depth <= bottom <= end_depth:
            breakpoints.add(round(bottom, 3))
    for segment in ranged_segments:
        top = float(segment["top"])
        bottom = float(segment["bottom"])
        if start_depth <= top <= end_depth:
            breakpoints.add(round(top, 3))
        if start_depth <= bottom <= end_depth:
            breakpoints.add(round(bottom, 3))

    ordered = sorted(breakpoints)
    refined: list[dict[str, Any]] = []
    for top, bottom in zip(ordered, ordered[1:]):
        if bottom <= top:
            continue
        stratum_name = _stratum_for_interval(
            top=top,
            bottom=bottom,
            rows=rows,
            segments=ranged_segments,
        )
        if not stratum_name:
            continue
        refined.append(_build_stratum_row(meta=meta, top=top, bottom=bottom, stratum_name=stratum_name))
    return refined or rows


def _stratum_for_interval(
    *,
    top: float,
    bottom: float,
    rows: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> str | None:
    for segment in segments:
        segment_top = float(segment["top"])
        segment_bottom = float(segment["bottom"])
        if top >= segment_top - 0.05 and bottom <= segment_bottom + 0.08:
            return str(segment["name"])

    for row in rows:
        row_top = _to_float(row.get("상심도"))
        row_bottom = _to_float(row.get("하심도"))
        if row_top is None or row_bottom is None:
            continue
        if top >= row_top - 0.05 and bottom <= row_bottom + 0.05:
            return _to_text(row.get("지층명"))
    return None


def _build_stratum_row(*, meta: dict[str, Any], top: float, bottom: float, stratum_name: str) -> dict[str, Any]:
    return {
        "프로젝트명": meta["project_name"],
        "시추공명": meta["borehole_name"],
        "경도": meta["raw_x"],
        "위도": meta["raw_y"],
        "표고": meta["elevation"],
        "water_level_gl": meta.get("water_level_gl"),
        "water_level_el": meta.get("water_level_el"),
        "상심도": top,
        "하심도": bottom,
        "지층명": stratum_name,
        "lon_wgs84": meta["lon_wgs84"],
        "lat_wgs84": meta["lat_wgs84"],
        "tm_x": meta["tm_x"],
        "tm_y": meta["tm_y"],
        "meta_crs": meta["meta_crs"],
    }


def _rows_from_spatial_lines(
    *,
    bottom_lines: list[TextLine],
    top_lines: list[TextLine],
    strata_lines: list[TextLine],
    meta: dict[str, Any],
    previous_bottom: float,
    final_depth: float | None = None,
) -> tuple[list[dict[str, Any]], float]:
    """Match depth/stratum columns by vertical position instead of list index.

    Each detected bottom-depth line acts as a row anchor — depth numbers are
    the most structurally reliable column (monotonically increasing, rarely
    merged across rows). For every anchor we look up whichever top-depth and
    stratum-name lines occupy the same vertical band on the page. This stays
    correct even when OCR detects a different number of lines per column
    (e.g. a stratum-name cell visually merged across two depth rows correctly
    matches both rows), where index-based pairing would silently drift out of
    alignment for every row that follows.
    """
    anchors = sorted(
        (
            (value, line)
            for line in bottom_lines
            for value in [clean_float(item) for item in _depth_values_from_line(line.text)]
            if value is not None
        ),
        key=lambda item: -item[1].bbox[3],  # PDF space (bottom-left origin): higher top = earlier on page
    )

    rows: list[dict[str, Any]] = []
    start_depth = previous_bottom
    current_bottom = previous_bottom
    last_anchor: TextLine | None = None
    depth_candidates = _decimal_depth_candidates_from_lines(
        [*bottom_lines, *top_lines, *strata_lines],
        final_depth=final_depth,
    )
    stratum_segments = _stratum_segments_from_lines(strata_lines)
    for index, (raw_bottom, line) in enumerate(anchors):
        next_raw_bottom = anchors[index + 1][0] if index + 1 < len(anchors) else None
        bottom = _repair_missing_decimal_depth(
            raw_bottom,
            current_bottom=current_bottom,
            next_raw_bottom=next_raw_bottom,
            candidates=depth_candidates,
        )
        if bottom <= current_bottom:
            continue

        top_match = _match_line_by_position(line, top_lines)
        top = _depth_value_from_line(top_match.text) if top_match else None
        if top is None:
            top = current_bottom

        stratum_name = _stratum_name_for_anchor(
            anchor=line,
            top=top,
            bottom=bottom,
            strata_lines=strata_lines,
            segments=stratum_segments,
        )

        rows.append(_build_stratum_row(meta=meta, top=top, bottom=bottom, stratum_name=stratum_name))
        current_bottom = bottom
        last_anchor = line

    if final_depth is not None and final_depth > current_bottom:
        if last_anchor is not None:
            stratum_name = _stratum_name_for_anchor(
                anchor=last_anchor,
                top=current_bottom,
                bottom=final_depth,
                strata_lines=strata_lines,
                segments=stratum_segments,
            )
        else:
            fallback_line = _next_stratum_line_after_anchor(strata_lines, last_anchor)
            stratum_name = _normalize_stratum_name(fallback_line.text if fallback_line else None)
        rows.append(_build_stratum_row(meta=meta, top=current_bottom, bottom=final_depth, stratum_name=stratum_name))
        current_bottom = final_depth

    rows = _refine_rows_with_stratum_ranges(
        rows=rows,
        segments=stratum_segments,
        meta=meta,
        start_depth=start_depth,
        end_depth=current_bottom,
    )
    return rows, current_bottom


def _rows_from_indexed_values(
    *,
    top_depths: list[str],
    bottom_depths: list[str],
    strata_names: list[str],
    meta: dict[str, Any],
    previous_bottom: float,
) -> tuple[list[dict[str, Any]], float]:
    """Pair depth/stratum values by list index (legacy fallback).

    Only safe when every column yields the same number of entries in the same
    order — true for clean digital text layers, but fragile for OCR'd scans
    where merged cells or misreads shift one column out of sync with the
    others. Used only when no bbox-aware line data is available (e.g. plain
    PyMuPDF text with ODL/OCR unavailable).
    """
    row_count = max(len(bottom_depths), len(strata_names))

    rows: list[dict[str, Any]] = []
    current_bottom = previous_bottom
    depth_candidates: set[float] = set()
    for value in [*top_depths, *bottom_depths]:
        depth_candidates.update(_decimal_depth_candidates_from_text(value))
    for index in range(row_count):
        raw_bottom = clean_float(bottom_depths[index]) if index < len(bottom_depths) else None
        next_raw_bottom = clean_float(bottom_depths[index + 1]) if index + 1 < len(bottom_depths) else None
        bottom = (
            _repair_missing_decimal_depth(
                raw_bottom,
                current_bottom=current_bottom,
                next_raw_bottom=next_raw_bottom,
                candidates=depth_candidates,
            )
            if raw_bottom is not None
            else None
        )
        if bottom is None or bottom <= current_bottom:
            continue

        top = clean_float(top_depths[index]) if index < len(top_depths) else current_bottom
        if top is None:
            top = current_bottom

        stratum_name = _normalize_stratum_name(strata_names[index] if index < len(strata_names) else None)
        rows.append(_build_stratum_row(meta=meta, top=top, bottom=bottom, stratum_name=stratum_name))
        current_bottom = bottom

    return rows, current_bottom


def _rows_from_manual_fields(
    *,
    fields: dict[str, str],
    meta: dict[str, Any],
    previous_bottom: float,
    lines: dict[str, list[TextLine]] | None = None,
) -> tuple[list[dict[str, Any]], float]:
    """Build stratum rows for a page, preferring spatial (bbox) matching.

    `lines` carries bbox-aware text lines per box label when ODL/OCR element
    data was available for this page. When both the depth and stratum-name
    columns produced bbox-aware lines, rows are matched by vertical position
    (`_rows_from_spatial_lines`) — robust against OCR detecting a different
    number of entries per column. Otherwise we fall back to the legacy
    index-based pairing over the plain extracted text.
    """
    lines = lines or {}
    bottom_lines = lines.get("depth") or lines.get("bottom_depth") or []
    top_lines = lines.get("top_depth") or []
    strata_lines = lines.get("stratum_name") or []
    final_depth = clean_float(fields.get("final_depth"))

    if bottom_lines and strata_lines:
        return _rows_from_spatial_lines(
            bottom_lines=bottom_lines,
            top_lines=top_lines,
            strata_lines=strata_lines,
            meta=meta,
            previous_bottom=previous_bottom,
            final_depth=final_depth,
        )

    top_depths = _split_depth_values(fields.get("top_depth"))
    bottom_depths = _split_depth_values(fields.get("depth")) or _split_depth_values(fields.get("bottom_depth"))
    strata_names = _split_strata_lines(fields.get("stratum_name"))
    rows, current_bottom = _rows_from_indexed_values(
        top_depths=top_depths,
        bottom_depths=bottom_depths,
        strata_names=strata_names,
        meta=meta,
        previous_bottom=previous_bottom,
    )
    if final_depth is not None and final_depth > current_bottom:
        stratum_name = _normalize_stratum_name(strata_names[-1] if strata_names else None)
        rows.append(_build_stratum_row(meta=meta, top=current_bottom, bottom=final_depth, stratum_name=stratum_name))
        current_bottom = final_depth
    return rows, current_bottom
