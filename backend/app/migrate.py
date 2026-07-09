"""Run Alembic migrations programmatically against the app's async engine.

Reuses the same async driver (aiosqlite / asyncpg) via `run_sync`, so no extra
synchronous DB driver is needed for either SQLite or Postgres.
"""

import os

from alembic import command
from alembic.config import Config

from app.db import engine

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _alembic_config(connection) -> Config:
    cfg = Config(os.path.join(_BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(_BACKEND_DIR, "alembic"))
    cfg.attributes["connection"] = connection
    return cfg


def _upgrade(connection) -> None:
    command.upgrade(_alembic_config(connection), "head")


async def run_migrations() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(_upgrade)
