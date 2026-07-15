"""OCR provider adapters for page-level word bounding boxes."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any, Protocol

from app.core.config import settings
from app.services.odl_normalizer import PdfElement


@dataclass(frozen=True)
class OcrProviderResult:
    provider: str
    available: bool
    elements: list[PdfElement]
    error: str | None = None


class OcrProvider(Protocol):
    name: str

    def extract_page(
        self,
        *,
        image_bytes: bytes,
        page_number: int,
        page_width: float,
        page_height: float,
        image_width: int,
        image_height: int,
    ) -> OcrProviderResult:
        """Extract OCR words as PDF-space elements."""


def extract_page_ocr(
    *,
    image_bytes: bytes,
    page_number: int,
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> OcrProviderResult:
    provider = _provider()
    return provider.extract_page(
        image_bytes=image_bytes,
        page_number=page_number,
        page_width=page_width,
        page_height=page_height,
        image_width=image_width,
        image_height=image_height,
    )


class PaddleOcrProvider:
    name = "paddle"

    def extract_page(
        self,
        *,
        image_bytes: bytes,
        page_number: int,
        page_width: float,
        page_height: float,
        image_width: int,
        image_height: int,
    ) -> OcrProviderResult:
        try:
            from paddleocr import PaddleOCR  # type: ignore
            from PIL import Image
            import numpy as np
        except Exception:
            return OcrProviderResult(self.name, False, [], "paddleocr is not installed")

        try:
            ocr = _cached_paddle_ocr(PaddleOCR)
            image = Image.open(BytesIO(image_bytes)).convert("RGB")
            raw = ocr.ocr(np.array(image), cls=True)
            elements = _paddle_elements(
                raw=raw,
                page_number=page_number,
                page_width=page_width,
                page_height=page_height,
                image_width=image_width,
                image_height=image_height,
            )
            return OcrProviderResult(self.name, True, elements)
        except Exception as exc:
            return OcrProviderResult(self.name, True, [], str(exc))


class EasyOcrProvider:
    name = "easyocr"

    def extract_page(
        self,
        *,
        image_bytes: bytes,
        page_number: int,
        page_width: float,
        page_height: float,
        image_width: int,
        image_height: int,
    ) -> OcrProviderResult:
        try:
            import easyocr  # type: ignore
            from PIL import Image
            import numpy as np
        except Exception:
            return OcrProviderResult(self.name, False, [], "easyocr is not installed")

        try:
            reader = _cached_easy_ocr(easyocr.Reader)
            image = Image.open(BytesIO(image_bytes)).convert("RGB")
            raw = reader.readtext(np.array(image), paragraph=False)
            elements = _easyocr_elements(
                raw=raw,
                page_number=page_number,
                page_width=page_width,
                page_height=page_height,
                image_width=image_width,
                image_height=image_height,
            )
            return OcrProviderResult(self.name, True, elements)
        except Exception as exc:
            return OcrProviderResult(self.name, True, [], str(exc))


class TesseractOcrProvider:
    name = "tesseract"

    def extract_page(
        self,
        *,
        image_bytes: bytes,
        page_number: int,
        page_width: float,
        page_height: float,
        image_width: int,
        image_height: int,
    ) -> OcrProviderResult:
        try:
            from PIL import Image
            import pytesseract  # type: ignore
        except Exception:
            return OcrProviderResult(self.name, False, [], "pytesseract is not installed")

        try:
            image = Image.open(BytesIO(image_bytes)).convert("RGB")
            raw = pytesseract.image_to_data(
                image,
                lang=settings.pdf_box_ocr_lang,
                config="--psm 6",
                output_type=pytesseract.Output.DICT,
            )
            elements = _tesseract_elements(
                raw=raw,
                page_number=page_number,
                page_width=page_width,
                page_height=page_height,
                image_width=image_width,
                image_height=image_height,
            )
            return OcrProviderResult(self.name, True, elements)
        except Exception as exc:
            return OcrProviderResult(self.name, True, [], str(exc))


class DisabledOcrProvider:
    name = "disabled"

    def extract_page(self, **_: Any) -> OcrProviderResult:
        return OcrProviderResult(self.name, False, [], "OCR provider disabled")


_PADDLE_OCR: Any = None
_EASY_OCR: Any = None


def _cached_paddle_ocr(paddle_ocr_cls: Any) -> Any:
    global _PADDLE_OCR
    if _PADDLE_OCR is None:
        try:
            _PADDLE_OCR = paddle_ocr_cls(
                lang=settings.pdf_paddle_ocr_lang,
                use_angle_cls=True,
                show_log=False,
            )
        except TypeError:
            _PADDLE_OCR = paddle_ocr_cls(lang=settings.pdf_paddle_ocr_lang)
    return _PADDLE_OCR


def _cached_easy_ocr(easy_ocr_reader_cls: Any) -> Any:
    global _EASY_OCR
    if _EASY_OCR is None:
        langs = [lang.strip() for lang in str(settings.pdf_easyocr_langs or "ko,en").split(",") if lang.strip()]
        _EASY_OCR = easy_ocr_reader_cls(langs, gpu=bool(settings.pdf_easyocr_gpu))
    return _EASY_OCR


def _provider() -> OcrProvider:
    provider = str(settings.pdf_ocr_provider or "easyocr").strip().lower()
    if provider == "paddle":
        return PaddleOcrProvider()
    if provider == "easyocr":
        return EasyOcrProvider()
    if provider == "tesseract":
        return TesseractOcrProvider()
    return DisabledOcrProvider()


def _paddle_elements(
    *,
    raw: Any,
    page_number: int,
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> list[PdfElement]:
    elements: list[PdfElement] = []
    for box, text, score in _iter_paddle_items(raw):
        if not text or score < float(settings.pdf_ocr_min_confidence or 0.25):
            continue
        vertices = [{"x": float(point[0]), "y": float(point[1])} for point in box]
        bbox = _vertices_to_pdf_bbox(
            vertices=vertices,
            page_width=page_width,
            page_height=page_height,
            image_width=image_width,
            image_height=image_height,
        )
        if bbox is None:
            continue
        elements.append(PdfElement(page_number=page_number, type="ocr_word", text=text, bbox=bbox))
    return elements


def _easyocr_elements(
    *,
    raw: Any,
    page_number: int,
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> list[PdfElement]:
    elements: list[PdfElement] = []
    for item in raw or []:
        if not isinstance(item, list | tuple) or len(item) < 3:
            continue
        box, text, score = item[0], str(item[1] or "").strip(), float(item[2] or 0)
        if not text or score < float(settings.pdf_ocr_min_confidence or 0.25):
            continue
        if not _looks_like_polygon(box):
            continue
        vertices = [{"x": float(point[0]), "y": float(point[1])} for point in box]
        bbox = _vertices_to_pdf_bbox(
            vertices=vertices,
            page_width=page_width,
            page_height=page_height,
            image_width=image_width,
            image_height=image_height,
        )
        if bbox is None:
            continue
        elements.append(PdfElement(page_number=page_number, type="ocr_word", text=text, bbox=bbox))
    return elements


def _tesseract_elements(
    *,
    raw: dict[str, Any],
    page_number: int,
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> list[PdfElement]:
    elements: list[PdfElement] = []
    texts = raw.get("text") or []
    confidences = raw.get("conf") or []
    lefts = raw.get("left") or []
    tops = raw.get("top") or []
    widths = raw.get("width") or []
    heights = raw.get("height") or []
    count = len(texts)
    for index in range(count):
        text = str(texts[index] or "").strip()
        if not text:
            continue
        try:
            score = float(confidences[index])
        except (IndexError, TypeError, ValueError):
            score = 100.0
        if score < 0:
            continue
        if score / 100.0 < float(settings.pdf_ocr_min_confidence or 0.25):
            continue
        try:
            left = float(lefts[index])
            top = float(tops[index])
            width = float(widths[index])
            height = float(heights[index])
        except (IndexError, TypeError, ValueError):
            continue
        if width <= 0 or height <= 0:
            continue
        bbox = _image_rect_to_pdf_bbox(
            left=left,
            top=top,
            right=left + width,
            bottom=top + height,
            page_width=page_width,
            page_height=page_height,
            image_width=image_width,
            image_height=image_height,
        )
        if bbox is None:
            continue
        elements.append(PdfElement(page_number=page_number, type="ocr_word", text=text, bbox=bbox))
    return elements


def _iter_paddle_items(raw: Any) -> list[tuple[list[list[float]], str, float]]:
    items: list[tuple[list[list[float]], str, float]] = []
    if isinstance(raw, dict):
        texts = raw.get("rec_texts") or []
        scores = raw.get("rec_scores") or []
        boxes = raw.get("rec_polys") or raw.get("rec_boxes") or []
        for index, text in enumerate(texts):
            box = boxes[index] if index < len(boxes) else None
            if box is None:
                continue
            score = float(scores[index]) if index < len(scores) else 1.0
            items.append((box, str(text).strip(), score))
    elif isinstance(raw, list | tuple):
        _collect_paddle_items(raw, items)
    return items


def _collect_paddle_items(raw: Any, items: list[tuple[list[list[float]], str, float]]) -> None:
    if not isinstance(raw, list | tuple):
        return
    if len(raw) >= 2 and _looks_like_polygon(raw[0]) and isinstance(raw[1], list | tuple):
        text_score = raw[1]
        if len(text_score) >= 2:
            items.append((raw[0], str(text_score[0]).strip(), float(text_score[1] or 0)))
        return
    for item in raw:
        _collect_paddle_items(item, items)


def _looks_like_polygon(value: Any) -> bool:
    return (
        isinstance(value, list | tuple)
        and len(value) >= 4
        and all(isinstance(point, list | tuple) and len(point) >= 2 for point in value[:4])
    )


def _vertices_to_pdf_bbox(
    *,
    vertices: list[dict[str, Any]],
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float] | None:
    try:
        xs = [float(vertex.get("x", 0)) for vertex in vertices]
        ys = [float(vertex.get("y", 0)) for vertex in vertices]
    except (TypeError, ValueError):
        return None
    if not xs or not ys or image_width <= 0 or image_height <= 0:
        return None
    left = min(xs) / image_width * page_width
    right = max(xs) / image_width * page_width
    top = min(ys) / image_height * page_height
    bottom = max(ys) / image_height * page_height
    if right <= left or bottom <= top:
        return None
    return (left, page_height - bottom, right, page_height - top)


def _image_rect_to_pdf_bbox(
    *,
    left: float,
    top: float,
    right: float,
    bottom: float,
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float] | None:
    if image_width <= 0 or image_height <= 0 or right <= left or bottom <= top:
        return None
    pdf_left = left / image_width * page_width
    pdf_right = right / image_width * page_width
    pdf_top = top / image_height * page_height
    pdf_bottom = bottom / image_height * page_height
    return (pdf_left, page_height - pdf_bottom, pdf_right, page_height - pdf_top)
