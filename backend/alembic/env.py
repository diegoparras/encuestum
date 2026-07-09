"""Alembic environment. Supports being handed a live (sync) connection via
`config.attributes['connection']` — which is how the app runs migrations at
startup through its async engine — and also a standalone offline/online run."""

from logging.config import fileConfig

from alembic import context
from sqlmodel import SQLModel

import app.models  # noqa: F401 — register all tables on the metadata

config = context.config
if config.config_file_name is not None:
    try:
        fileConfig(config.config_file_name)
    except Exception:
        pass

target_metadata = SQLModel.metadata


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,  # safe ALTERs on SQLite
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection", None)
    if connection is not None:
        _run(connection)
        return

    # Fallback: build our own engine (e.g. `alembic upgrade head` from the CLI).
    from sqlalchemy import engine_from_config, pool

    from app.db import _database_url

    url, _ = _database_url()
    cfg = config.get_section(config.config_ini_section) or {}
    cfg["sqlalchemy.url"] = url
    connectable = engine_from_config(cfg, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as conn:
        _run(conn)


if context.is_offline_mode():
    from app.db import _database_url

    url, _ = _database_url()
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
