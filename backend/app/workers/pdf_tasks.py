"""Celery app and PDF extraction tasks."""

from __future__ import annotations

from celery import Celery
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SyncSessionLocal
from app.models import ExtractionJobStatus, PdfExtractionJob, Project
from app.services.pdf_service import PdfService

celery_app = Celery(
    "geobim",
    broker=settings.redis_url,
    backend=settings.redis_url,
)

celery_app.conf.update(
    task_always_eager=settings.celery_task_always_eager,
    task_track_started=True,
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Seoul",
    enable_utc=True,
)


@celery_app.task(name="pdf.extract_with_template", bind=True, max_retries=2)
def extract_with_template_task(self, job_id: int) -> dict:
    """Template extraction placeholder task.

    Automatic extraction is the first production path. This task keeps the
    planned API surface available and stores raw template text in job.result.
    """
    with SyncSessionLocal() as db:
        job = db.get(PdfExtractionJob, job_id)
        if job is None:
            raise ValueError(f"PdfExtractionJob not found: {job_id}")
        if job.template is None:
            job.status = ExtractionJobStatus.FAILED
            job.error = "템플릿이 지정되지 않았습니다."
            db.commit()
            return {"ok": False, "error": job.error}

        try:
            job.status = ExtractionJobStatus.RUNNING
            db.commit()
            result = PdfService().extract_with_template(job.file_path, job.template.box_definitions)
            job.result = {"fields": result}
            job.status = ExtractionJobStatus.AWAITING_REVIEW
            db.commit()
            return job.result
        except Exception as exc:
            db.rollback()
            job.status = ExtractionJobStatus.FAILED
            job.error = str(exc)
            db.commit()
            raise self.retry(exc=exc, countdown=30)


@celery_app.task(name="pdf.auto_extract", bind=True, max_retries=2)
def auto_extract_task(self, job_id: int) -> dict:
    """Run PDF_Convert automatic extraction and store rows for review."""
    with SyncSessionLocal() as db:
        job = db.get(PdfExtractionJob, job_id)
        if job is None:
            raise ValueError(f"PdfExtractionJob not found: {job_id}")

        try:
            project_name = db.execute(
                select(Project.name).where(Project.id == job.project_id)
            ).scalar_one()
            job.status = ExtractionJobStatus.RUNNING
            job.error = None
            db.commit()

            result = PdfService().preview_extraction(
                db=db,
                pdf_path=job.file_path,
                project_id=job.project_id,
                project_name=project_name,
            )
            job.result = result
            job.status = ExtractionJobStatus.AWAITING_REVIEW
            db.commit()
            return result
        except Exception as exc:
            db.rollback()
            job = db.get(PdfExtractionJob, job_id)
            if job is not None:
                job.error = str(exc)
                job.status = ExtractionJobStatus.FAILED
                db.commit()
            if self.request.retries < self.max_retries:
                raise self.retry(exc=exc, countdown=30)
            return {"ok": False, "error": str(exc)}
