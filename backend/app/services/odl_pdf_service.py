"""Optional OpenDataLoader PDF integration.

ODL is treated as a best-effort helper. Failures are reported as metadata and
must not fail the GeoBIM extraction pipeline.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

try:
    import opendataloader_pdf
except Exception:  # pragma: no cover - optional runtime dependency
    opendataloader_pdf = None


class OdlPdfService:
    """Run opendataloader-pdf and cache JSON output per source PDF."""

    def __init__(self, output_dir: str | None = None) -> None:
        backend_dir = Path(__file__).resolve().parents[2]
        configured_dir = Path(output_dir or settings.pdf_odl_output_dir)
        if not configured_dir.is_absolute():
            configured_dir = backend_dir / configured_dir
        self.output_dir = configured_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

        java_bin = str(settings.java_bin_path or "").strip()
        if java_bin and Path(java_bin).exists() and java_bin not in os.environ.get("PATH", ""):
            os.environ["PATH"] = java_bin + os.pathsep + os.environ.get("PATH", "")

    def is_available(self) -> bool:
        if not settings.pdf_odl_enabled:
            return False
        if opendataloader_pdf is None:
            return False
        return shutil.which("java") is not None

    def extract_json(self, pdf_path: str, job_key: str | int | None = None) -> dict[str, Any] | None:
        """Return cached or newly generated ODL JSON."""
        metadata = self.extract_json_with_metadata(pdf_path, job_key=job_key)
        return metadata.get("data") if metadata.get("ok") else None

    def extract_json_with_metadata(
        self,
        pdf_path: str,
        job_key: str | int | None = None,
    ) -> dict[str, Any]:
        if not settings.pdf_odl_enabled:
            return {"ok": False, "error": "ODL disabled", "available": False}
        if opendataloader_pdf is None:
            return {"ok": False, "error": "opendataloader_pdf not installed", "available": False}
        if shutil.which("java") is None:
            return {"ok": False, "error": "Java command not found", "available": False}

        source = Path(pdf_path)
        if not source.exists():
            return {"ok": False, "error": f"PDF not found: {pdf_path}", "available": True}

        target_dir = self.output_dir / str(job_key or source.stem)
        target_dir.mkdir(parents=True, exist_ok=True)
        json_path = target_dir / f"{source.stem}.json"

        try:
            if not json_path.exists():
                self._convert_json(source=source, output_dir=target_dir)

            if not json_path.exists():
                candidates = sorted(target_dir.glob("*.json"))
                if not candidates:
                    return {
                        "ok": False,
                        "error": "ODL JSON output was not created",
                        "available": True,
                    }
                json_path = candidates[0]

            with json_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)

            if _content_element_count(data) == 0 and settings.pdf_odl_hybrid_enabled:
                hybrid_metadata = self._extract_hybrid_json(source, job_key=job_key)
                if hybrid_metadata.get("ok"):
                    return hybrid_metadata
                return {
                    "ok": True,
                    "available": True,
                    "mode": "local",
                    "json_path": str(json_path),
                    "data": data,
                    "warning": "ODL local output had no text elements; hybrid OCR fallback failed",
                    "hybrid_error": hybrid_metadata.get("error"),
                }

            return {
                "ok": True,
                "available": True,
                "mode": "local",
                "json_path": str(json_path),
                "data": data,
            }
        except Exception as exc:  # pragma: no cover - depends on Java/JAR runtime
            logger.warning("OpenDataLoader PDF extraction failed: %s", exc, exc_info=True)
            return {"ok": False, "available": True, "error": str(exc)}

    def _extract_hybrid_json(
        self,
        source: Path,
        *,
        job_key: str | int | None,
    ) -> dict[str, Any]:
        hybrid_dir = self.output_dir / f"{job_key or source.stem}_hybrid"
        hybrid_dir.mkdir(parents=True, exist_ok=True)
        hybrid_json_path = hybrid_dir / f"{source.stem}.json"

        try:
            if not hybrid_json_path.exists():
                self._convert_json(source=source, output_dir=hybrid_dir, hybrid=True)

            if not hybrid_json_path.exists():
                candidates = sorted(hybrid_dir.glob("*.json"))
                if not candidates:
                    return {
                        "ok": False,
                        "available": True,
                        "mode": "hybrid",
                        "error": "ODL hybrid JSON output was not created",
                    }
                hybrid_json_path = candidates[0]

            with hybrid_json_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)

            return {
                "ok": True,
                "available": True,
                "mode": "hybrid",
                "hybrid_url": settings.pdf_odl_hybrid_url,
                "json_path": str(hybrid_json_path),
                "data": data,
            }
        except Exception as exc:  # pragma: no cover - depends on hybrid server runtime
            logger.warning("OpenDataLoader PDF hybrid OCR failed: %s", exc, exc_info=True)
            return {
                "ok": False,
                "available": True,
                "mode": "hybrid",
                "hybrid_url": settings.pdf_odl_hybrid_url,
                "error": str(exc),
            }

    def _convert_json(self, *, source: Path, output_dir: Path, hybrid: bool = False) -> None:
        kwargs: dict[str, Any] = {
            "input_path": [str(source)],
            "output_dir": str(output_dir),
            "format": "json",
            "quiet": True,
        }
        if hybrid:
            kwargs.update(
                {
                    "hybrid": "docling-fast",
                    "hybrid_mode": settings.pdf_odl_hybrid_mode,
                    "hybrid_url": settings.pdf_odl_hybrid_url,
                    "hybrid_timeout": str(max(settings.pdf_odl_timeout_seconds, 1) * 1000),
                    "hybrid_fallback": False,
                }
            )
        opendataloader_pdf.convert(**kwargs)


def _content_element_count(data: Any) -> int:
    if isinstance(data, dict):
        count = 1 if data.get("content") and data.get("bounding box") else 0
        for value in data.values():
            count += _content_element_count(value)
        return count
    if isinstance(data, list):
        return sum(_content_element_count(item) for item in data)
    return 0
