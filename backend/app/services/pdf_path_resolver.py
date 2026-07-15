"""Resolve stored PDF paths across host and Docker runtimes."""

from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath


DEFAULT_WINDOWS_ROOT = r"C:\antigravity\#1_1_PDF_Download\PDF_Storage"
DEFAULT_CONTAINER_ROOT = "/pdf_storage"


def resolve_pdf_path(stored_path: str | None) -> Path | None:
    """Return a readable local path for a PDF path stored in the database.

    Batch rebuilds store the original Windows path so the DB remains portable
    back to the host. The Docker backend sees the same files through a mounted
    directory, so translate that root when needed.
    """
    if not stored_path:
        return None

    original = Path(stored_path)
    if original.exists():
        return original

    windows_root = os.getenv("PDF_SOURCE_WINDOWS_ROOT", DEFAULT_WINDOWS_ROOT)
    container_root = os.getenv("PDF_SOURCE_MOUNT_DIR", DEFAULT_CONTAINER_ROOT)
    translated = _translate_windows_root(stored_path, windows_root, container_root)
    if translated.exists():
        return translated

    fallback = _translate_after_pdf_storage(stored_path, container_root)
    if fallback.exists():
        return fallback

    return translated


def pdf_display_name(stored_path: str | None) -> str:
    if not stored_path:
        return ""
    return PureWindowsPath(stored_path).name or Path(stored_path).name


def _translate_windows_root(stored_path: str, windows_root: str, container_root: str) -> Path:
    stored_norm = stored_path.replace("/", "\\")
    root_norm = windows_root.replace("/", "\\").rstrip("\\")
    if stored_norm.lower().startswith(root_norm.lower() + "\\"):
        rel = stored_norm[len(root_norm) + 1 :]
        return Path(container_root).joinpath(*PureWindowsPath(rel).parts)
    return Path(stored_path)


def _translate_after_pdf_storage(stored_path: str, container_root: str) -> Path:
    marker = "PDF_Storage"
    stored_norm = stored_path.replace("/", "\\")
    lower = stored_norm.lower()
    idx = lower.find(marker.lower())
    if idx < 0:
        return Path(stored_path)
    rel = stored_norm[idx + len(marker) :].lstrip("\\")
    return Path(container_root).joinpath(*PureWindowsPath(rel).parts)
