"""Normalize OpenDataLoader PDF JSON into searchable page elements."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PdfElement:
    page_number: int
    type: str
    text: str
    bbox: tuple[float, float, float, float]
    row: int | None = None
    col: int | None = None


@dataclass(frozen=True)
class TextLine:
    """A visual line of text with its union bounding box (PDF space)."""

    text: str
    bbox: tuple[float, float, float, float]

    @property
    def y_center(self) -> float:
        return (self.bbox[1] + self.bbox[3]) / 2


def flatten_odl_json(data: dict[str, Any] | None) -> list[PdfElement]:
    """Flatten ODL's nested JSON into text-bearing elements."""
    if not data:
        return []

    elements: list[PdfElement] = []
    for child in data.get("kids") or []:
        _visit_node(child, elements)
    return elements


def find_elements_in_box(
    elements: list[PdfElement],
    *,
    page_number: int,
    box: tuple[float, float, float, float],
    min_overlap: float = 0.05,
) -> list[PdfElement]:
    """Return ODL elements whose bbox intersects the requested PDF-space box."""
    matches = [
        element
        for element in elements
        if element.page_number == page_number and _overlap_ratio(element.bbox, box) >= min_overlap
    ]
    return sorted(matches, key=_visual_sort_key)


def group_elements_into_lines(elements: list[PdfElement]) -> list[TextLine]:
    """Group elements into visual lines, keeping each line's union bbox.

    This preserves the vertical position (bbox) of every line so that callers
    can match lines across different boxes/columns by spatial position instead
    of relying on list-index alignment (which breaks when OCR detects a
    different number of lines per column, e.g. merged stratum-name cells).
    """
    if not elements:
        return []

    ordered = sorted(elements, key=_visual_sort_key)
    line_tolerance = _line_tolerance(ordered)
    groups: list[list[PdfElement]] = []
    current_line: list[PdfElement] = []
    current_y: float | None = None

    for element in ordered:
        text = " ".join(str(element.text).split())
        if not text:
            continue

        y_center = (element.bbox[1] + element.bbox[3]) / 2
        if current_y is None or abs(y_center - current_y) <= line_tolerance:
            current_line.append(element)
            current_y = y_center if current_y is None else (current_y + y_center) / 2
            continue

        groups.append(current_line)
        current_line = [element]
        current_y = y_center

    if current_line:
        groups.append(current_line)

    lines: list[TextLine] = []
    for group in groups:
        text = _join_line(group)
        if not text:
            continue
        lefts = [element.bbox[0] for element in group]
        bottoms = [element.bbox[1] for element in group]
        rights = [element.bbox[2] for element in group]
        tops = [element.bbox[3] for element in group]
        bbox = (min(lefts), min(bottoms), max(rights), max(tops))
        lines.append(TextLine(text=text, bbox=bbox))
    return lines


def text_from_elements(elements: list[PdfElement]) -> str:
    """Join element text in visual order while preserving row-like breaks."""
    return "\n".join(line.text for line in group_elements_into_lines(elements))


def _visual_sort_key(element: PdfElement) -> tuple[float, float]:
    # PDF-space bboxes use bottom-left origin. Higher top values appear first on page.
    return (-element.bbox[3], element.bbox[0])


def _line_tolerance(elements: list[PdfElement]) -> float:
    heights = [max(element.bbox[3] - element.bbox[1], 0.0) for element in elements]
    heights = [height for height in heights if height > 0]
    if not heights:
        return 2.5
    heights.sort()
    median = heights[len(heights) // 2]
    return max(median * 0.55, 2.5)


def _join_line(elements: list[PdfElement]) -> str:
    words = [
        " ".join(str(element.text).split())
        for element in sorted(elements, key=lambda item: item.bbox[0])
    ]
    return " ".join(word for word in words if word)


def _visit_node(
    node: dict[str, Any],
    elements: list[PdfElement],
    *,
    inherited_page: int | None = None,
    row: int | None = None,
    col: int | None = None,
) -> None:
    page_number = _to_int(node.get("page number")) or inherited_page
    node_type = str(node.get("type") or "")
    bbox = _bbox(node.get("bounding box"))
    text = _node_text(node)

    if page_number is not None and bbox is not None and text:
        elements.append(
            PdfElement(
                page_number=page_number,
                type=node_type,
                text=text,
                bbox=bbox,
                row=row or _to_int(node.get("row number")),
                col=col or _to_int(node.get("column number")),
            )
        )

    if node_type == "table":
        for table_row in node.get("rows") or []:
            row_number = _to_int(table_row.get("row number"))
            for cell in table_row.get("cells") or []:
                _visit_node(
                    cell,
                    elements,
                    inherited_page=page_number,
                    row=row_number,
                    col=_to_int(cell.get("column number")),
                )
        return

    for key in ("kids", "children", "content", "contents"):
        children = node.get(key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    _visit_node(
                        child,
                        elements,
                        inherited_page=page_number,
                        row=row or _to_int(node.get("row number")),
                        col=col or _to_int(node.get("column number")),
                    )


def _node_text(node: dict[str, Any]) -> str:
    direct = node.get("content") or node.get("text")
    if isinstance(direct, str):
        return direct.strip()

    texts: list[str] = []
    for child in node.get("kids") or []:
        if isinstance(child, dict):
            child_text = _node_text(child)
            if child_text:
                texts.append(child_text)
    return "\n".join(texts)


def _bbox(value: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(value, list | tuple) or len(value) != 4:
        return None
    try:
        left, bottom, right, top = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    return (min(left, right), min(bottom, top), max(left, right), max(bottom, top))


def _overlap_ratio(
    candidate: tuple[float, float, float, float],
    target: tuple[float, float, float, float],
) -> float:
    left = max(candidate[0], target[0])
    bottom = max(candidate[1], target[1])
    right = min(candidate[2], target[2])
    top = min(candidate[3], target[3])
    if right <= left or top <= bottom:
        return 0.0

    intersection = (right - left) * (top - bottom)
    candidate_area = max((candidate[2] - candidate[0]) * (candidate[3] - candidate[1]), 0.0)
    target_area = max((target[2] - target[0]) * (target[3] - target[1]), 0.0)
    denominator = min(candidate_area, target_area)
    if denominator <= 0:
        return 0.0
    return intersection / denominator


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
