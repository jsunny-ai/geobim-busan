"""Preservation-first PDF layout extraction for borehole logs.

The intermediate representation keeps source words and table cells with stable
page-local IDs. Field extractors consume that representation instead of reading
the PDF again, so new observations can be added later without another layout
extraction pass.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import fitz

LAYOUT_SCHEMA_VERSION = "borehole-source-layout-v1"
EXTRACTOR_VERSION = "pymupdf-layout-v1"
GROUNDWATER_RULE_VERSION = "groundwater-depth-spatial-v1"

_NUMBER_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$")
_GROUNDWATER_LABELS = ("지하수위", "공내수위", "groundwater", "gwl")


def extract_pdf_layout(
    pdf_path: str | Path,
    *,
    pages: list[int] | None = None,
    include_tables: bool = True,
) -> dict[str, Any]:
    """Return a JSON-serializable, bbox-aware intermediate representation.

    ``pages`` is one-based. When omitted, every page is extracted.
    """

    path = Path(pdf_path).resolve()
    selected = set(pages or [])
    source_hash = _sha256(path)
    page_records: list[dict[str, Any]] = []

    with fitz.open(path) as document:
        for page_index, page in enumerate(document):
            page_number = page_index + 1
            if selected and page_number not in selected:
                continue

            words = _word_elements(page, page_number)
            page_record: dict[str, Any] = {
                "page_number": page_number,
                "width": round(float(page.rect.width), 4),
                "height": round(float(page.rect.height), 4),
                "rotation": int(page.rotation),
                "text": page.get_text("text", sort=True),
                "elements": words,
            }
            if include_tables:
                page_record["tables"] = _table_records(page, page_number)
            page_records.append(page_record)

        return {
            "schema_version": LAYOUT_SCHEMA_VERSION,
            "extractor": {
                "name": "PyMuPDF",
                "version": fitz.VersionBind,
                "rule_version": EXTRACTOR_VERSION,
            },
            "extracted_at": datetime.now(UTC).isoformat(),
            "source_document": {
                "path": str(path),
                "file_name": path.name,
                "sha256": source_hash,
                "size_bytes": path.stat().st_size,
                "page_count": len(document),
            },
            "pages": page_records,
        }


def extract_groundwater_observations(layout: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract groundwater depth observations from an existing layout JSON."""

    source = layout["source_document"]
    observations: list[dict[str, Any]] = []

    for page in layout.get("pages", []):
        elements = page.get("elements", [])
        for label in elements:
            label_text = str(label.get("text", "")).strip().lower()
            if not any(alias in label_text for alias in _GROUNDWATER_LABELS):
                continue

            value_element = _nearest_same_row_number(label, elements)
            if value_element is None:
                continue

            unit_elements = _nearby_unit_elements(label, value_element, elements)
            unit_text = " ".join(str(element["text"]) for element in unit_elements)
            reference_datum = _reference_datum(unit_text)
            raw_value = str(value_element["text"]).strip().replace(",", "")
            parsed_value = float(raw_value)
            value = abs(parsed_value) if reference_datum == "GL" else parsed_value
            source_ids = [label["element_id"], value_element["element_id"]]
            source_ids.extend(element["element_id"] for element in unit_elements)

            observations.append(
                {
                    "observation_id": (
                        f"gw-{source['sha256'][:12]}-p{page['page_number']:04d}-"
                        f"{value_element['element_id'].split('-')[-1]}"
                    ),
                    "observation_type": "groundwater_depth",
                    "value_numeric": value,
                    "unit": "m",
                    "reference_datum": reference_datum,
                    "page_number": page["page_number"],
                    "source_document_sha256": source["sha256"],
                    "source_element_ids": source_ids,
                    "source_text": {
                        "label": label["text"],
                        "value": value_element["text"],
                        "unit": unit_text or None,
                    },
                    "source_bbox": value_element["bbox"],
                    "rule_version": GROUNDWATER_RULE_VERSION,
                    "confidence": _confidence(label, value_element, unit_elements),
                    "review_status": "auto",
                }
            )

    return observations


def build_preservation_poc(
    pdf_path: str | Path,
    *,
    pages: list[int] | None = None,
) -> dict[str, Any]:
    layout = extract_pdf_layout(pdf_path, pages=pages)
    return {
        "layout": layout,
        "observations": {
            "groundwater_depth": extract_groundwater_observations(layout),
        },
    }


def _word_elements(page: fitz.Page, page_number: int) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    words = page.get_text("words", sort=True)
    for sequence, word in enumerate(words):
        x0, y0, x1, y1, text, block, line, word_index = word[:8]
        elements.append(
            {
                "element_id": (
                    f"p{page_number:04d}-b{int(block):04d}-l{int(line):04d}-"
                    f"w{int(word_index):04d}-{sequence:05d}"
                ),
                "type": "text_word",
                "text": text,
                "bbox": _bbox(x0, y0, x1, y1),
                "block_index": int(block),
                "line_index": int(line),
                "word_index": int(word_index),
                "extraction_method": "embedded_text",
                "confidence": 1.0,
            }
        )
    return elements


def _table_records(page: fitz.Page, page_number: int) -> list[dict[str, Any]]:
    try:
        found = page.find_tables()
    except Exception:
        return []

    records: list[dict[str, Any]] = []
    for table_index, table in enumerate(found.tables):
        rows = table.extract()
        cells: list[dict[str, Any]] = []
        column_count = max((len(row) for row in rows), default=0)
        for row_index, row in enumerate(rows):
            for column_index, value in enumerate(row):
                if value is None:
                    continue
                cell_bbox = None
                try:
                    raw_bbox = table.rows[row_index].cells[column_index]
                    if raw_bbox is not None:
                        cell_bbox = _bbox(*raw_bbox)
                except (AttributeError, IndexError, TypeError):
                    pass
                cells.append(
                    {
                        "element_id": (
                            f"p{page_number:04d}-t{table_index:03d}-"
                            f"r{row_index:04d}-c{column_index:04d}"
                        ),
                        "type": "table_cell",
                        "row": row_index,
                        "column": column_index,
                        "text": value,
                        "bbox": cell_bbox,
                    }
                )
        records.append(
            {
                "table_id": f"p{page_number:04d}-t{table_index:03d}",
                "bbox": _bbox(*table.bbox),
                "row_count": len(rows),
                "column_count": column_count,
                "cells": cells,
            }
        )
    return records


def _nearest_same_row_number(
    label: dict[str, Any], elements: list[dict[str, Any]]
) -> dict[str, Any] | None:
    lx0, ly0, lx1, ly1 = label["bbox"]
    label_center_y = (ly0 + ly1) / 2
    label_height = max(ly1 - ly0, 1.0)
    candidates: list[tuple[float, dict[str, Any]]] = []

    for element in elements:
        raw = str(element.get("text", "")).strip().replace(",", "")
        if not _NUMBER_RE.fullmatch(raw):
            continue
        x0, y0, x1, y1 = element["bbox"]
        if x0 <= lx1 or x0 - lx1 > 180:
            continue
        center_y = (y0 + y1) / 2
        y_distance = abs(center_y - label_center_y)
        if y_distance > max(12.0, label_height * 1.5):
            continue
        score = (x0 - lx1) + y_distance * 8
        candidates.append((score, element))

    return min(candidates, key=lambda item: item[0])[1] if candidates else None


def _nearby_unit_elements(
    label: dict[str, Any],
    value: dict[str, Any],
    elements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    lx0, ly0, lx1, ly1 = label["bbox"]
    vx0, vy0, vx1, vy1 = value["bbox"]
    nearby: list[dict[str, Any]] = []
    for element in elements:
        text = str(element.get("text", ""))
        lowered = text.lower().replace(" ", "")
        if not any(token in lowered for token in ("gl", "el", "-m", "(m)", "bgl")):
            continue
        x0, y0, x1, y1 = element["bbox"]
        horizontal = x1 >= min(lx0, vx0) - 20 and x0 <= max(lx1, vx1) + 40
        vertical = y0 >= min(ly0, vy0) - 20 and y1 <= max(ly1, vy1) + 30
        if horizontal and vertical:
            nearby.append(element)
    return nearby


def _reference_datum(unit_text: str) -> str:
    normalized = unit_text.upper().replace(" ", "")
    if "EL" in normalized:
        return "EL"
    if "GL" in normalized or "BGL" in normalized or "-M" in normalized:
        return "GL"
    return "unknown"


def _confidence(
    label: dict[str, Any],
    value: dict[str, Any],
    units: list[dict[str, Any]],
) -> float:
    lx0, ly0, lx1, ly1 = label["bbox"]
    vx0, vy0, vx1, vy1 = value["bbox"]
    row_delta = abs(((ly0 + ly1) / 2) - ((vy0 + vy1) / 2))
    score = 0.75
    if row_delta <= 3:
        score += 0.15
    if units:
        score += 0.08
    if value.get("extraction_method") == "embedded_text":
        score += 0.02
    return round(min(score, 1.0), 2)


def _bbox(x0: float, y0: float, x1: float, y1: float) -> list[float]:
    return [round(float(value), 4) for value in (x0, y0, x1, y1)]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
