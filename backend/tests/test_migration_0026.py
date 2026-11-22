"""Migración 0026 (trazabilidad): el camino real, no el atajo de la 0001.

Una base nueva nunca ejercita la 0026: la 0001 materializa el esquema con el
modelo de HOY y la 0026 encuentra todo hecho. Para recorrer el camino de una
base de producción se sube hasta la cabeza, se baja a la 0025 (lo que deja la
base como estaba antes de esta fase, y de paso prueba el `downgrade`) y se
vuelve a subir. Sobre SQLite, que es el motor por defecto sin `DATABASE_URL` y
donde el modo batch reconstruye las tablas para colgar las FKs.
"""

import os
import tempfile

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _cfg() -> Config:
    cfg = Config(os.path.join(_BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(_BACKEND_DIR, "alembic"))
    return cfg


def _correr(engine, revision, *, atras=False):
    cfg = _cfg()
    with engine.connect() as connection:
        cfg.attributes["connection"] = connection
        (command.downgrade if atras else command.upgrade)(cfg, revision)
        connection.commit()


def test_la_0026_baja_y_sube_sin_perder_columnas():
    engine = sa.create_engine(f"sqlite:///{os.path.join(tempfile.mkdtemp(), 'm.db')}")
    _correr(engine, "head")
    _correr(engine, "0025_survey_folders", atras=True)

    insp = sa.inspect(engine)
    assert "audit_events" not in insp.get_table_names()
    assert "survey_version_id" not in {c["name"] for c in insp.get_columns("survey_responses")}

    _correr(engine, "0026_trazabilidad")
    insp = sa.inspect(engine)
    tablas = set(insp.get_table_names())
    assert {"audit_events", "grade_revisions", "survey_versions"} <= tablas

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    assert {"survey_version_id", "integrity_hash"} <= cols
    # El batch reconstruyó la tabla: las columnas anteriores siguen ahí.
    assert {"excluded", "is_test", "mod_site_id", "grade", "answers"} <= cols
    assert "response_id" in {c["name"] for c in insp.get_columns("ai_usage")}

    # El registro de auditoría NO tiene FK a la encuesta ni a la respuesta:
    # tiene que sobrevivir a su borrado definitivo.
    referidas = {fk["referred_table"] for fk in insp.get_foreign_keys("audit_events")}
    assert "surveys" not in referidas and "survey_responses" not in referidas
