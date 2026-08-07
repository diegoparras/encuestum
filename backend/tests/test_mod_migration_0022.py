"""Migración 0022: el origen del módulo en `survey_responses`, desde la 0021.

El resto de la suite nunca ejercita esta migración: `conftest.py` arranca desde
una base vacía y la 0001 materializa el esquema entero con
`SQLModel.metadata.create_all` sobre el modelo de HOY -- así que las tres
columnas y el CHECK ya existen antes de que la 0022 corra un solo ALTER, y los
`if` de `upgrade()` se van todos por el camino corto.

Lo único que ejercita el camino real es una base de producción que ya corrió
hasta la 0021, que es lo que arma este archivo a mano con SQL crudo (mismo
patrón, y por el mismo motivo, que `test_lti_migration_0019.py` y
`test_mod_migration_0021.py`: no depender de que `SQLModel.metadata` todavía
represente ese estado viejo).
"""

import os
import tempfile

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# El mínimo que la 0022 necesita encontrar: la tabla que modifica (con la
# columna LTI que entra en el CHECK), la tabla a la que apunta su FK nueva, y el
# sello de alembic en la revisión anterior.
_DDL_BASE_0021 = """
CREATE TABLE alembic_version (
    version_num VARCHAR(32) NOT NULL,
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
INSERT INTO alembic_version (version_num) VALUES ('0021_mod_sites');

CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    subdomain TEXT, logo TEXT, created_at TEXT NOT NULL
);

CREATE TABLE surveys (id TEXT PRIMARY KEY, org_id TEXT NOT NULL);

CREATE TABLE mod_sites (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, wwwroot TEXT NOT NULL,
    name TEXT, public_key TEXT NOT NULL, ws_token TEXT, created_at TEXT NOT NULL,
    CONSTRAINT uq_mod_site UNIQUE (wwwroot)
);

CREATE TABLE survey_responses (
    id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    answers TEXT NOT NULL,
    meta TEXT,
    respondent_email TEXT,
    respondent_code TEXT,
    completed BOOLEAN NOT NULL DEFAULT 1,
    submitted_at TEXT NOT NULL,
    lti_link_id TEXT,
    lti_sub TEXT,
    score REAL,
    max_score REAL,
    needs_review BOOLEAN NOT NULL DEFAULT 0,
    grade TEXT,
    graded_at TEXT
);
"""


def _base_en_0021() -> sa.Engine:
    tmp = tempfile.mkdtemp()
    engine = sa.create_engine(f"sqlite:///{os.path.join(tmp, 'desde_0021.db')}")
    with engine.begin() as conn:
        for stmt in _DDL_BASE_0021.strip().split(";"):
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


def test_la_0022_agrega_el_origen_del_modulo_a_survey_responses():
    engine = _base_en_0021()
    _correr(engine, _cfg(), "0022_mod_response_origin")

    insp = sa.inspect(engine)
    cols = {c["name"]: c for c in insp.get_columns("survey_responses")}
    for nueva in ("mod_site_id", "mod_cmid", "mod_grademax"):
        assert nueva in cols, f"falta la columna {nueva}"
        assert cols[nueva]["nullable"] is True

    # Las columnas viejas siguen ahí: el modo batch de alembic reconstruye la
    # tabla para poder colgar la FK y el CHECK, y una reconstrucción mal hecha
    # se lleva puestas columnas o datos sin decir nada.
    for vieja in ("lti_link_id", "lti_sub", "score", "max_score", "needs_review"):
        assert vieja in cols

    assert "ix_survey_responses_mod_site_id" in {
        i["name"] for i in insp.get_indexes("survey_responses")
    }

    # `SET NULL` y no `CASCADE`: desconectar un Moodle no puede borrar las
    # respuestas de los alumnos de un curso entero.
    assert any(
        fk.get("referred_table") == "mod_sites"
        and "mod_site_id" in (fk.get("constrained_columns") or [])
        and (fk.get("options") or {}).get("ondelete") == "SET NULL"
        for fk in insp.get_foreign_keys("survey_responses")
    ), "falta la FK survey_responses.mod_site_id -> mod_sites.id con ON DELETE SET NULL"

    assert "ck_survey_responses_un_solo_origen" in {
        c["name"] for c in insp.get_check_constraints("survey_responses")
    }


def test_el_check_de_un_solo_origen_lo_aplica_el_motor():
    """El invariante no vive en el código: una fila con los dos orígenes la
    rechaza la base. Se prueba acá y no sólo en Postgres porque lo que se
    comprueba es que la migración lo dejó *aplicable*, no sólo declarado.

    Roto a propósito: sacando el `create_check_constraint` de la 0022, los dos
    INSERT pasan y el test falla en el segundo."""
    engine = _base_en_0021()
    _correr(engine, _cfg(), "0022_mod_response_origin")

    def _insertar(lti_link_id, mod_site_id):
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO survey_responses "
                "(id, survey_id, answers, completed, submitted_at, needs_review, "
                " lti_link_id, mod_site_id) "
                f"VALUES (hex(randomblob(16)), 's', '{{}}', 1, 'ahora', 0, "
                f"{lti_link_id}, {mod_site_id})"
            )

    _insertar("'link-1'", "NULL")  # sólo LTI
    _insertar("NULL", "NULL")  # sin origen (una respuesta pública)
    with pytest.raises(sa.exc.IntegrityError):
        _insertar("'link-1'", "'sitio-1'")  # los dos: imposible


def test_la_0022_upgrade_downgrade_upgrade_no_rompe():
    engine = _base_en_0021()
    cfg = _cfg()
    _correr(engine, cfg, "0022_mod_response_origin")
    _correr(engine, cfg, "0021_mod_sites", atras=True)

    cols = {c["name"] for c in sa.inspect(engine).get_columns("survey_responses")}
    assert not (cols & {"mod_site_id", "mod_cmid", "mod_grademax"})
    assert "lti_link_id" in cols

    _correr(engine, cfg, "0022_mod_response_origin")
    insp = sa.inspect(engine)
    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    assert {"mod_site_id", "mod_cmid", "mod_grademax"} <= cols
    assert "ix_survey_responses_mod_site_id" in {
        i["name"] for i in insp.get_indexes("survey_responses")
    }


def test_la_0022_es_idempotente_sobre_una_base_que_ya_lo_tenia():
    """El caso de una base nueva: la 0001 ya creó todo desde el modelo, así que
    la 0022 tiene que ser un no-op en vez de chocar contra columnas, índice, FK
    y CHECK que ya están."""
    engine = _base_en_0021()
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE survey_responses")
        conn.exec_driver_sql(
            "CREATE TABLE survey_responses ("
            " id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, answers TEXT NOT NULL,"
            " meta TEXT, respondent_email TEXT, respondent_code TEXT,"
            " completed BOOLEAN NOT NULL DEFAULT 1, submitted_at TEXT NOT NULL,"
            " lti_link_id TEXT, lti_sub TEXT, score REAL, max_score REAL,"
            " needs_review BOOLEAN NOT NULL DEFAULT 0, grade TEXT, graded_at TEXT,"
            " mod_site_id TEXT REFERENCES mod_sites(id) ON DELETE SET NULL,"
            " mod_cmid INTEGER, mod_grademax REAL,"
            " CONSTRAINT ck_survey_responses_un_solo_origen CHECK"
            " (NOT (lti_link_id IS NOT NULL AND mod_site_id IS NOT NULL)))"
        )
        conn.exec_driver_sql(
            "CREATE INDEX ix_survey_responses_mod_site_id ON survey_responses (mod_site_id)"
        )

    _correr(engine, _cfg(), "0022_mod_response_origin")

    insp = sa.inspect(engine)
    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    assert {"mod_site_id", "mod_cmid", "mod_grademax"} <= cols
    checks = {c["name"] for c in insp.get_check_constraints("survey_responses")}
    assert checks == {"ck_survey_responses_un_solo_origen"}, (
        "la migración duplicó el CHECK sobre una base que ya lo tenía"
    )
