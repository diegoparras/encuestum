"""Migración 0019: FK e índices de `survey_responses.lti_link_id`/`lti_sub`
sobre una base que ya venía de antes de esta rama.

El resto de la suite arranca siempre desde una base vacía (`conftest.py`), y
en este repo la 0001 materializa el esquema entero desde
`SQLModel.metadata.create_all` con el modelo de HOY -- así que una base nueva
YA trae la FK y los índices de `survey_responses.lti_link_id`/`lti_sub` antes
de que la 0019 corra un solo `ALTER TABLE`, y el resto de la suite nunca
ejercita el camino real de este fix.

Este archivo simula lo único que sí lo ejercita: una base que ya corrió hasta
la 0018 -- es decir, antes de que esta rama (y sus tablas LTI) existieran --
armada a mano con SQL crudo, para no depender de que `SQLModel.metadata`
todavía represente ese estado viejo. Contra esa base, la 0019 vieja (ver el
finding "Important 5" del review) dejaba las columnas sin FK ni índices; esta
prueba corre la 0019 actual y confirma que los agrega."""

import os
import tempfile

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Exactamente lo que la 0019 VIEJA dejaba sobre una base que venía de la 0018:
# las cuatro tablas LTI completas (esa parte nunca estuvo rota) y
# `survey_responses` con las dos columnas puestas por un `add_column` pelón
# -- sin la FK ni los índices que el modelo declara.
_DDL_BASE_VIEJA = """
CREATE TABLE alembic_version (
    version_num VARCHAR(32) NOT NULL,
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
INSERT INTO alembic_version (version_num) VALUES ('0018_survey_report');

CREATE TABLE lti_platforms (
    id TEXT PRIMARY KEY, issuer TEXT NOT NULL, client_id TEXT NOT NULL,
    deployment_ids TEXT NOT NULL, auth_login_url TEXT NOT NULL, auth_token_url TEXT NOT NULL,
    jwks_url TEXT NOT NULL, org_id TEXT, name TEXT, created_at TEXT NOT NULL,
    CONSTRAINT uq_lti_platform_issuer_client UNIQUE (issuer, client_id)
);
CREATE TABLE lti_resource_links (
    id TEXT PRIMARY KEY, platform_id TEXT NOT NULL, resource_link_id TEXT NOT NULL,
    context_id TEXT, survey_id TEXT NOT NULL, lineitem_url TEXT, lineitems_url TEXT,
    max_score REAL, created_at TEXT NOT NULL,
    CONSTRAINT uq_lti_link UNIQUE (platform_id, resource_link_id)
);
CREATE TABLE lti_users (
    id TEXT PRIMARY KEY, platform_id TEXT NOT NULL, sub TEXT NOT NULL,
    email TEXT, name TEXT, roles TEXT NOT NULL, created_at TEXT NOT NULL,
    CONSTRAINT uq_lti_user UNIQUE (platform_id, sub)
);
CREATE TABLE lti_keys (
    id TEXT PRIMARY KEY, kid TEXT NOT NULL UNIQUE, private_pem TEXT NOT NULL,
    public_pem TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE survey_responses (
    id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, lti_link_id TEXT, lti_sub TEXT
);
"""


def _cfg() -> Config:
    cfg = Config(os.path.join(_BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(_BACKEND_DIR, "alembic"))
    return cfg


def _fk_lti_link(insp: sa.engine.reflection.Inspector) -> dict | None:
    for fk in insp.get_foreign_keys("survey_responses"):
        if fk.get("referred_table") == "lti_resource_links" and "lti_link_id" in (
            fk.get("constrained_columns") or []
        ):
            return fk
    return None


def test_migracion_0019_agrega_fk_e_indices_sobre_una_base_que_ya_tenia_las_columnas():
    """El escenario real del finding: `alembic upgrade head` sobre una base de
    producción que ya corrió hasta la 0018 -- sin pasar por el
    `metadata.create_all` de la 0001, que en este repo enmascara el bug en
    cualquier base nueva."""
    tmp = tempfile.mkdtemp()
    url = f"sqlite:///{os.path.join(tmp, 'old_prod.db')}"
    engine = sa.create_engine(url)
    with engine.begin() as conn:
        for stmt in _DDL_BASE_VIEJA.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                conn.exec_driver_sql(stmt)

    cfg = _cfg()
    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, "0019_lti")

    insp = sa.inspect(engine)
    idx = {i["name"] for i in insp.get_indexes("survey_responses")}
    assert "ix_survey_responses_lti_link_id" in idx
    assert "ix_survey_responses_lti_sub" in idx

    fk = _fk_lti_link(insp)
    assert fk is not None, "falta la FK survey_responses.lti_link_id -> lti_resource_links.id"
    assert fk["options"].get("ondelete") == "SET NULL"

    # Sigue siendo idempotente: correrla nominalmente "de nuevo" (mismo
    # `head`, no hace nada porque alembic ya la marcó aplicada) no debe
    # romper. La garantía real de idempotencia -- que las mismas condiciones
    # (`_has_fk`, nombres de índice) se puedan re-evaluar sin duplicar nada --
    # la cubre el ciclo upgrade/downgrade/upgrade de más abajo.
    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, "0019_lti")  # no-op: ya está en head


def test_migracion_0019_upgrade_downgrade_upgrade_no_rompe():
    """Ciclo completo (upgrade -> downgrade -> upgrade) sobre la misma base
    que ya venía con las columnas puestas: cubre tanto el `downgrade()`
    reescrito (dropea FK e índices antes de las columnas) como que un segundo
    `upgrade()` sobre una base que pasó por ahí vuelva a dejar todo en su
    lugar, sin chocar contra nada que haya quedado de la vuelta anterior."""
    tmp = tempfile.mkdtemp()
    url = f"sqlite:///{os.path.join(tmp, 'ciclo.db')}"
    engine = sa.create_engine(url)
    with engine.begin() as conn:
        for stmt in _DDL_BASE_VIEJA.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                conn.exec_driver_sql(stmt)

    cfg = _cfg()
    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, "0019_lti")

    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        command.downgrade(cfg, "0018_survey_report")

    insp = sa.inspect(engine)
    # El downgrade se llevó puesta la FK, los índices, las columnas y las
    # cuatro tablas LTI -- no debería quedar nada.
    assert "lti_platforms" not in set(insp.get_table_names())
    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    assert "lti_link_id" not in cols
    assert "lti_sub" not in cols

    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, "0019_lti")

    insp = sa.inspect(engine)
    idx = {i["name"] for i in insp.get_indexes("survey_responses")}
    assert "ix_survey_responses_lti_link_id" in idx
    assert "ix_survey_responses_lti_sub" in idx
    assert _fk_lti_link(insp) is not None
