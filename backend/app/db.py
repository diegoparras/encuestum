"""Database engine + session. SQLite by default, Postgres via DATABASE_URL."""

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app import models  # noqa: F401 — ensure tables are registered


def _database_url() -> tuple[str, dict]:
    url = os.getenv("DATABASE_URL")
    if not url:
        data_dir = os.getenv("ENCUESTUM_DATA_DIR", "/app_data")
        os.makedirs(data_dir, exist_ok=True)
        url = f"sqlite:///{os.path.join(data_dir, 'encuestum.db')}"

    if url.startswith("sqlite://"):
        url = url.replace("sqlite://", "sqlite+aiosqlite://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

    connect_args = {"check_same_thread": False} if "sqlite" in url else {}
    return url, connect_args


_url, _connect_args = _database_url()
engine: AsyncEngine = create_async_engine(_url, connect_args=_connect_args)
_session_maker = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with _session_maker() as session:
        yield session

