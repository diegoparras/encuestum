"""survey_responses: de qué actividad de `mod_encuestum` vino la respuesta.

Revision ID: 0022_mod_response_origin
Revises: 0021_mod_sites
Create Date: 2026-08-06

Tres columnas y un CHECK. Las columnas son la referencia que faltaba: hasta acá
una respuesta lanzada desde el módulo nativo no guardaba **nada** sobre su
origen (`lti_link_id` queda NULL porque no hay `LtiResourceLink`), así que la
nota no tenía a dónde volver.

El CHECK es el invariante: una respuesta pertenece a un vínculo LTI **o** a un
sitio del módulo, nunca a los dos. Ver `_CK_UN_SOLO_ORIGEN` en `app/models.py`.

Idempotente. Una base nueva arranca por la 0001, que materializa el esquema
entero desde `SQLModel.metadata.create_all` con el modelo de HOY -- así que
todo esto ya existe cuando esta migración corre ahí. El camino que sí se
ejercita es el de una base que venía de la 0021.
"""

import sqlalchemy as sa
from alembic import op

revision = "0022_mod_response_origin"
down_revision = "0021_mod_sites"
branch_labels = None
depends_on = None

_FK_MOD_SITE = "fk_survey_responses_mod_site_id_mod_sites"
_IX_MOD_SITE = "ix_survey_responses_mod_site_id"
_CK_ORIGEN = "ck_survey_responses_un_solo_origen"
_SQL_ORIGEN = "NOT (lti_link_id IS NOT NULL AND mod_site_id IS NOT NULL)"


def _tiene_fk(insp: sa.engine.reflection.Inspector, tabla: str, col: str, ref: str) -> bool:
    """True si ya hay una FK de `tabla.col` a `ref`, sin importar su nombre: la
    que deja `SQLModel.metadata.create_all` (ver la 0001) es la misma pero
    anónima. Mismo helper que la 0019, por el mismo motivo."""
    for fk in insp.get_foreign_keys(tabla):
        if fk.get("referred_table") == ref and col in (fk.get("constrained_columns") or []):
            return True
    return False


def _tiene_check(insp: sa.engine.reflection.Inspector, tabla: str, nombre: str) -> bool:
    try:
        return nombre in {c.get("name") for c in insp.get_check_constraints(tabla)}
    except NotImplementedError:
        # Algún dialecto sin reflexión de CHECKs: se asume que no está y el
        # `create_check_constraint` de abajo fallará ruidosamente si sí estaba,
        # que es mejor que saltearlo en silencio.
        return False


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "mod_site_id" not in cols:
            batch.add_column(sa.Column("mod_site_id", sa.Uuid(), nullable=True))
        if "mod_cmid" not in cols:
            batch.add_column(sa.Column("mod_cmid", sa.Integer(), nullable=True))
        if "mod_grademax" not in cols:
            batch.add_column(sa.Column("mod_grademax", sa.Float(), nullable=True))

    # El índice va aparte del `add_column`: en SQLite agregar una columna es una
    # ALTER TABLE nativa sólo mientras no haya que colgarle una FK, y mezclar
    # las dos cosas en el mismo bloque `batch` fuerza un rebuild innecesario.
    insp = sa.inspect(bind)
    if _IX_MOD_SITE not in {i["name"] for i in insp.get_indexes("survey_responses")}:
        op.create_index(_IX_MOD_SITE, "survey_responses", ["mod_site_id"])

    insp = sa.inspect(bind)
    if not _tiene_fk(insp, "survey_responses", "mod_site_id", "mod_sites"):
        with op.batch_alter_table("survey_responses") as batch:
            batch.create_foreign_key(
                _FK_MOD_SITE, "mod_sites", ["mod_site_id"], ["id"], ondelete="SET NULL"
            )

    insp = sa.inspect(bind)
    if not _tiene_check(insp, "survey_responses", _CK_ORIGEN):
        # `batch_alter_table` y no `op.create_check_constraint` a secas: SQLite
        # no sabe agregar un CHECK con ALTER TABLE, hay que reconstruir la
        # tabla, y eso es exactamente lo que hace el modo batch cuando la
        # operación lo exige. En Postgres emite el ALTER directo.
        with op.batch_alter_table("survey_responses") as batch:
            batch.create_check_constraint(_CK_ORIGEN, _SQL_ORIGEN)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _tiene_check(insp, "survey_responses", _CK_ORIGEN):
        with op.batch_alter_table("survey_responses") as batch:
            batch.drop_constraint(_CK_ORIGEN, type_="check")

    # Sólo se dropea por nombre la FK que ESTA migración pudo haber creado: la
    # anónima que deja `create_all` no se puede apuntar por nombre, y no hace
    # falta -- el `drop_column` de abajo dispara el rebuild que se la lleva.
    insp = sa.inspect(bind)
    if _FK_MOD_SITE in {fk.get("name") for fk in insp.get_foreign_keys("survey_responses")}:
        with op.batch_alter_table("survey_responses") as batch:
            batch.drop_constraint(_FK_MOD_SITE, type_="foreignkey")

    insp = sa.inspect(bind)
    if _IX_MOD_SITE in {i["name"] for i in insp.get_indexes("survey_responses")}:
        op.drop_index(_IX_MOD_SITE, table_name="survey_responses")

    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        for col in ("mod_grademax", "mod_cmid", "mod_site_id"):
            if col in cols:
                batch.drop_column(col)
