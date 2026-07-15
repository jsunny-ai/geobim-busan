"""FastAPI 진입점."""

# Passlib bcrypt 4.x compatibility patch
import bcrypt
if not hasattr(bcrypt, "__about__"):
    class About:
        __version__ = bcrypt.__version__
    bcrypt.__about__ = About()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select

from app.api.v1 import auth, boreholes, coastal_boundaries, coordinates, csv_ingestion, pdf_extraction, projects, templates, tiles, rbf, export, virtual_boreholes, water_surfaces
from app.core.config import settings
from app.core.database import AsyncSessionLocal, engine
from app.models import Borehole, Project


app = FastAPI(
    title="GeoBIM Stratum API",
    description="시추공 데이터 기반 3D 지층 모델링 플랫폼 API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


@app.get("/health/db", tags=["meta"])
async def database_health():
    try:
        async with AsyncSessionLocal() as db:
            project_count = (await db.execute(
                select(func.count(Project.id)).where(Project.deleted_at.is_(None))
            )).scalar_one()
            borehole_count = (await db.execute(
                select(func.count(Borehole.id)).where(Borehole.deleted_at.is_(None))
            )).scalar_one()
            latest_project = (await db.execute(
                select(Project.id, Project.name, Project.created_at)
                .where(Project.deleted_at.is_(None))
                .order_by(Project.created_at.desc())
                .limit(1)
            )).one_or_none()
            sentinel_ids = settings.db_sentinel_project_id_list
            found_ids = set((await db.execute(
                select(Project.id).where(
                    Project.id.in_(sentinel_ids),
                    Project.deleted_at.is_(None),
                )
            )).scalars()) if sentinel_ids else set()
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "database": "unreachable", "detail": str(exc)},
        )

    missing_ids = sorted(set(sentinel_ids) - found_ids)
    payload = {
        "status": "ok" if not missing_ids else "stale",
        "database": "connected",
        "projects": project_count,
        "boreholes": borehole_count,
        "latest_project": (
            {
                "id": latest_project.id,
                "name": latest_project.name,
                "created_at": latest_project.created_at.isoformat(),
            }
            if latest_project else None
        ),
        "missing_sentinel_project_ids": missing_ids,
    }
    return payload if not missing_ids else JSONResponse(status_code=503, content=payload)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request, exc: Exception):
    if settings.environment == "development":
        return JSONResponse(status_code=500, content={"detail": str(exc)})
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


PREFIX = "/api/v1"
app.include_router(auth.router,           prefix=PREFIX + "/auth",           tags=["auth"])
app.include_router(projects.router,       prefix=PREFIX + "/projects",       tags=["projects"])
app.include_router(virtual_boreholes.router, prefix=PREFIX + "/projects", tags=["virtual-boreholes"])
app.include_router(boreholes.router,      prefix=PREFIX + "/boreholes",      tags=["boreholes"])
app.include_router(coordinates.router,    prefix=PREFIX + "/coordinates",    tags=["coordinates"])
app.include_router(pdf_extraction.router, prefix=PREFIX + "/pdf-extraction", tags=["pdf-extraction"])
app.include_router(csv_ingestion.router,  prefix=PREFIX + "/csv-ingestion",   tags=["csv-ingestion"])
app.include_router(templates.router,      prefix=PREFIX + "/templates",      tags=["templates"])
app.include_router(tiles.router,          prefix=PREFIX + "/tiles",          tags=["tiles"])
app.include_router(rbf.router,            prefix=PREFIX + "/rbf",            tags=["rbf"])
app.include_router(export.router,         prefix=PREFIX + "/export",         tags=["export"])
app.include_router(water_surfaces.router, prefix=PREFIX + "/water-surfaces", tags=["water-surfaces"])
app.include_router(coastal_boundaries.router, prefix=PREFIX + "/coastal-boundaries", tags=["coastal-boundaries"])
