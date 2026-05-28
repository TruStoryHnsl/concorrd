# Database migrations

The Concord backend uses Alembic for schema migrations. The lifespan
hook in `main.py` calls `migrations.apply_migrations()` on every
startup so deploys converge on `head` without manual intervention.

## Adding a schema change

```bash
cd server
source .venv/bin/activate
# 1. Edit models.py to describe the new shape.
# 2. Autogenerate a migration from the diff:
alembic revision --autogenerate -m "describe-change"
# 3. Open the generated file under alembic/versions/ and SANITY CHECK
#    the upgrade/downgrade body. Autogenerate misses subtle things
#    (renames, server_default changes, partial indexes); a wrong
#    migration committed to main is hard to back out of.
# 4. Commit the migration + the models change together.
```

The next deploy applies the migration. To test locally before
shipping:

```bash
# Fresh DB:
CONCORD_ALEMBIC_DB_URL="sqlite:///$(mktemp -d)/concord.db" alembic upgrade head
# Live DB (read CONCORD_DATA_DIR from your shell):
alembic upgrade head
```

## Legacy lifespan migrations (frozen)

`main.py` still contains an inline `_migrate()` block that runs after
`apply_migrations()`. **Do not add new entries to it.** It exists only
as a safety net for existing prod DBs that were assembled before
Alembic was introduced — `apply_migrations()` stamps them at head
without re-running anything, but the inline block stays as a belt
under the suspenders until enough deploys have rolled through to
prove the stamp-head path is reliable.

When confidence is established (a few release cycles), delete the
inline `_migrate()` block in `main.py` and revisit
`database._lightweight_migrations()` too.

## Why batch mode

`env.py` enables `render_as_batch=True` because SQLite does not
support most `ALTER TABLE` operations natively — Alembic emulates them
by creating a new table, copying rows, and renaming. On Postgres
batch mode is a no-op, so the same migrations work on either backend
without conditionals.

## Why we strip `+aiosqlite`

The application runs on async SQLAlchemy (`sqlite+aiosqlite://...`)
but Alembic's command-line entry points are sync. `env.py` rewrites
the URL to plain `sqlite://...` so both can point at the same file.
