"""Celery 비동기 워커."""

from app.workers.pdf_tasks import celery_app

__all__ = ["celery_app"]
