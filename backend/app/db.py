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


def _engine_kwargs() -> dict:
    """`ENCUESTUM_DB_NULLPOOL` desactiva el pool de conexiones.

    Lo usa la suite de tests y no debería usarlo nada más. Ahí conviven dos
    event loops —el del `TestClient`, que corre la app en su propio hilo, y el
    de `pytest-asyncio`, donde los tests hablan con la base directamente— y
    asyncpg ata cada conexión al loop que la creó. Con pool, una conexión
    devuelta desde un loop y reutilizada desde el otro falla con
    `got Future ... attached to a different loop`. Sin pool, cada uso abre y
    cierra la suya."""
    if os.getenv("ENCUESTUM_DB_NULLPOOL"):
        from sqlalchemy.pool import NullPool

        return {"poolclass": NullPool}
    return {}


_url, _connect_args = _database_url()
engine: AsyncEngine = create_async_engine(_url, connect_args=_connect_args, **_engine_kwargs())
_session_maker = async_sessionmaker(engine, expire_on_commit=False)


if "sqlite" in _url:
    # SQLite ignora TODA cláusula `ON DELETE` salvo que se emita este PRAGMA en
    # cada conexión, y viene apagado por defecto. `models.py` declara 25
    # `ondelete=` (CASCADE y SET NULL) que, sin esto, en una instalación con
    # SQLite no hacían nada: borrar una organización dejaba encuestas
    # huérfanas apuntando a una fila inexistente, en vez de arrastrarlas.
    # Postgres sí las aplica, así que esto empareja los dos motores.
    from sqlalchemy import event

    @event.listens_for(engine.sync_engine, "connect")
    def _activar_claves_foraneas(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with _session_maker() as session:
        yield session

