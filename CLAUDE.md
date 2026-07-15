# Claude DB Safety Contract

Read and obey `AGENTS.md` before changing this repository.

For every task involving the database, backend startup, Docker, migrations,
seeds, restore, project lists, or borehole counts:

1. Run `powershell -ExecutionPolicy Bypass -File scripts/db-safety-check.ps1`.
2. The only approved local API is `http://127.0.0.1:9001`. Never substitute
   `localhost:9001`; an IPv6 `::1` listener can resolve to a different backend.
3. The only approved PostgreSQL is the `postgres` service inside the
   `geobim-stratum` Docker Compose project.
4. Never connect this application to host/WSL `localhost:5432`.
5. Never start a host `uvicorn` process as a fallback.
6. Before any migration, seed, restore, bulk update, delete, merge, or schema
   repair, run `scripts/backup-db-safe.ps1 -Reason <short_reason>`.
7. Never run `docker compose down -v`, `docker volume rm`, `dropdb`, truncate
   core tables, recreate the DB, or execute a seed merely because a list is
   empty.
8. An empty UI is not proof of missing data. Check `/health/db`, API filters,
   pagination, authentication, and the direct Docker DB counts first.
9. Never catch an API/DB failure in production UI code and silently return
   mock, fixture, seed, cached example, or hard-coded project/borehole data.
   Show a connection error containing the active API URL instead.
10. Sentinel user workspaces 9707 (test), 9708 (Sinwol underpass), and 9718
   (Busan Station) must have `project_kind=user_workspace`. Public source
   survey names must never appear in the default project list.
   exist. If either is missing, stop and report the DB identity mismatch.
11. Do not weaken or remove the DB sentinel check to make a failing startup
    appear healthy.

Canonical startup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-backend-safe.ps1
```
