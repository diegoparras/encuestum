"""Migración 0021: `mod_sites` sobre una base que ya venía de la 0020.

El resto de la suite nunca ejercita esta migración: `conftest.py` arranca
siempre desde una base vacía y en este repo la 0001 materializa el esquema
entero con `SQLModel.metadata.create_all` sobre el modelo de HOY -- así que
`mod_sites` ya existe antes de que la 0021 corra un solo `CREATE TABLE`, y el
`return` temprano de `upgrade()` se lleva puesto todo lo demás.

Lo único que ejercita el camino real es una base de producción que ya corrió
hasta la 0020, que es lo que arma este archivo a mano con SQL crudo (mismo
patrón que `test_lti_migration_0019.py`, y por el mismo motivo: no depender de
que `SQLModel.metadata` todavía represente ese estado viejo).
"""

import os
import tempfile

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# El mínimo que la 0021 necesita encontrar: la tabla a la que apunta su FK y el
# sello de alembic en la revisión anterior.
_DDL_BASE_0020 = """
CREATE TABLE alembic_version (
    version_num VARCHAR(32) NOT NULL,
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
INSERT INTO alembic_version (version_num) VALUES ('0020_lti_panel');

CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    subdomain TEXT, logo TEXT, created_at TEXT NOT NULL
);
"""


def _base_en_0020() -> sa.Engine:
    tmp = tempfile.mkdtemp()
    engine = sa.create_engine(f"sqlite:///{os.path.join(tmp, 'desde_0020.db')}")
    with engine.begin() as conn:
        for stmt in _DDL_BASE_0020.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                conn.exec_driver_sql(stmt)
    return engine


def _cfg() -> Config:
    cfg = Config(os.path.join(_BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(_BACKEND_DIR, "alembic"))
    return cfg


def _correr(engine: sa.Engine, cfg: Config, revision: str, *, atras: bool = False) -> None:
    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        (command.downgrade if atras else command.upgrade)(cfg, revision)


def test_migracion_0021_encadena_desde_la_0020_y_crea_mod_sites():
    engine = _base_en_0020()
    cfg = _cfg()
    _correr(engine, cfg, "0021_mod_sites")

    insp = sa.inspect(engine)
    assert "mod_sites" in set(insp.get_table_names())

    cols = {c["name"]: c for c in insp.get_columns("mod_sites")}
    assert set(cols) == {
        "id", "org_id", "wwwroot", "name", "secret_hash", "ws_token", "created_at",
    }
    assert cols["org_id"]["nullable"] is False
    assert cols["secret_hash"]["nullable"] is False
    assert cols["ws_token"]["nullable"] is True

    # La unicidad es por `wwwroot` SOLO: si fuera `(org_id, wwwroot)` -- lo que
    # decía el plan -- dos organizaciones podrían tener su propia fila para el
    # mismo Moodle y el chequeo de dueño del registro quedaría siendo puramente
    # de aplicación, con una ventana de carrera entre el SELECT y el INSERT.
    uniques = {u["name"]: list(u["column_names"]) for u in insp.get_unique_constraints("mod_sites")}
    assert uniques.get("uq_mod_site") == ["wwwroot"]

    assert "ix_mod_sites_org_id" in {i["name"] for i in insp.get_indexes("mod_sites")}

    fks = insp.get_foreign_keys("mod_sites")
    assert any(
        fk.get("referred_table") == "organizations"
        and fk.get("options", {}).get("ondelete") == "CASCADE"
        for fk in fks
    ), "falta la FK mod_sites.org_id -> organizations.id con ON DELETE CASCADE"


def test_migracion_0021_upgrade_downgrade_upgrade_no_rompe():
    engine = _base_en_0020()
    cfg = _cfg()
    _correr(engine, cfg, "0021_mod_sites")
    _correr(engine, cfg, "0020_lti_panel", atras=True)

    assert "mod_sites" not in set(sa.inspect(engine).get_table_names())

    _correr(engine, cfg, "0021_mod_sites")
    insp = sa.inspect(engine)
    assert "mod_sites" in set(insp.get_table_names())
    assert "ix_mod_sites_org_id" in {i["name"] for i in insp.get_indexes("mod_sites")}


def test_migracion_0021_es_idempotente_sobre_una_tabla_que_ya_estaba():
    """El caso de una base nueva: la 0001 ya creó `mod_sites` desde el modelo,
    así que la 0021 tiene que ser un no-op en vez de chocar contra la tabla."""
    engine = _base_en_0020()
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE mod_sites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, "
            "wwwroot TEXT NOT NULL, name TEXT, secret_hash TEXT NOT NULL, "
            "ws_token TEXT, created_at TEXT NOT NULL, "
            "CONSTRAINT uq_mod_site UNIQUE (wwwroot))"
        )
    _correr(engine, _cfg(), "0021_mod_sites")
    assert "mod_sites" in set(sa.inspect(engine).get_table_names())
