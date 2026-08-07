"""Higiene de resultados: excluir/marcar respuestas y registro de borrados.

Revision ID: 0023_response_hygiene
Revises: 0022_mod_response_origin
Create Date: 2026-08-07

Dos columnas en `survey_responses` para sacar una respuesta de los resultados
sin destruirla (`excluded` a mano, `is_test` cuando la envió el propio equipo
probando), y la tabla `response_deletions` con el rastro de los borrados, que
sí son irreversibles.

`response_deletions.response_id` NO lleva clave foránea a propósito: la fila
existe justamente porque esa respuesta ya no está.

Idempotente. Una base nueva arranca por la 0001, que materializa el esquema
entero desde `SQLModel.metadata.create_all` con el modelo de HOY -- así que todo
esto ya existe cuando esta migración corre ahí. El camino que sí se ejercita es
el de una base que venía de la 0022.
"""

import sqlalchemy as sa
from alembic import op

revision = "0023_response_hygiene"
down_revision = "0022_mod_response_origin"
branch_labels = None
depends_on = None

_IX_EXCLUDED = "ix_survey_responses_excluded"
_IX_IS_TEST = "ix_survey_responses_is_test"


def _indices(insp: sa.engine.reflection.Inspector, tabla: str) -> set:
    return {i["name"] for i in insp.get_indexes(tabla)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "excluded" not in cols:
            batch.add_column(
                sa.Column("excluded", sa.Boolean(), nullable=False, server_default="0")
            )
        if "is_test" not in cols:
            batch.add_column(
                sa.Column("is_test", sa.Boolean(), nullable=False, server_default="0")
            )

    # Los índices van aparte del add_column (mismo motivo que en la 0022): se
    # filtra por estas dos columnas en cada agregación de resultados.
    ix = _indices(insp, "survey_responses")
    if _IX_EXCLUDED not in ix:
        op.create_index(_IX_EXCLUDED, "survey_responses", ["excluded"])
    if _IX_IS_TEST not in ix:
        op.create_index(_IX_IS_TEST, "survey_responses", ["is_test"])

    if "response_deletions" not in insp.get_table_names():
        op.create_table(
            "response_deletions",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("survey_id", sa.Uuid(), nullable=False),
            sa.Column("response_id", sa.Uuid(), nullable=False),
            sa.Column("deleted_by", sa.Uuid(), nullable=True),
            sa.Column("deleted_by_email", sa.String(), nullable=True),
            sa.Column("respondent", sa.String(), nullable=True),
            sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["deleted_by"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index(
            "ix_response_deletions_survey_id", "response_deletions", ["survey_id"]
        )
        op.create_index(
            "ix_response_deletions_response_id", "response_deletions", ["response_id"]
        )
        op.create_index(
            "ix_response_deletions_deleted_by", "response_deletions", ["deleted_by"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if "response_deletions" in insp.get_table_names():
        op.drop_table("response_deletions")

    ix = _indices(insp, "survey_responses")
    if _IX_EXCLUDED in ix:
        op.drop_index(_IX_EXCLUDED, table_name="survey_responses")
    if _IX_IS_TEST in ix:
        op.drop_index(_IX_IS_TEST, table_name="survey_responses")

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "excluded" in cols:
            batch.drop_column("excluded")
        if "is_test" in cols:
            batch.drop_column("is_test")
