# GeoBIM Database Safety Runbook

## Canonical local stack

- Frontend API URL: `http://127.0.0.1:8002` (`localhost` 금지: IPv6 shadow 방지)
- Backend: `geobim-stratum-backend-1`
- PostgreSQL: `geobim-stratum-postgres-1`
- Internal backend DB host: `postgres:5432`
- Required sentinel projects: `9708`, `9718`

Do not use host or WSL `localhost:5432` for the application.

## Before work

```powershell
powershell -ExecutionPolicy Bypass -File scripts/db-safety-check.ps1
```

The check must report status `OK`, at least 4,525 active projects, both
sentinel projects, and `/health/db` status `ok`.

## Before a DB mutation

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup-db-safe.ps1 -Reason migration
```

This is mandatory before migrations, restores, seeds, bulk edits, duplicate
merges, schema repair, or destructive maintenance.

## Forbidden recovery shortcuts

- Do not seed because a frontend list is empty.
- Do not restore over the current DB before comparing both DB fingerprints.
- Do not delete or recreate a Docker volume.
- Do not use `docker compose down -v`.
- Do not bypass `/health/db`.
- Do not start host uvicorn on port 8000.

## Empty-screen diagnosis order

1. Check `http://127.0.0.1:8002/health/db`.
2. Run `scripts/db-safety-check.ps1`.
3. Inspect browser API URL and response status.
4. Check API filters such as `has_bbox`.
5. Check pagination and client timeouts.
6. Compare Docker DB counts.
7. Only then investigate backup/restore.

## Verified baseline (2026-07-06)

- Active projects: 4,525 (2026-07-06 user deletion of projects 9713 and 9721)
- Active boreholes: 24,926
- Latest project ID: 9,721
- Sinwol underpass: project 9,708
- Busan Station: project 9,718
