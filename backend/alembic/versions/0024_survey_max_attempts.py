"""surveys.max_attempts: cuántas veces puede responder una misma persona.

Revision ID: 0024_survey_max_attempts
Revises: 0023_response_hygiene
Create Date: 2026-08-11

Distinto de `max_responses` (el cupo total de la encuesta): esto es por persona.
Hasta acá el builder escribía el valor dentro de `evaluation.integrity.maxAttempts`
y NADIE lo aplicaba -- el campo "Intentos máx." de la interfaz no hacía nada. La
columna lo saca de ahí y lo vuelve un ajuste de la encuesta, no del modo examen.

Idempotente. Una base nueva arranca por la 0001, que materializa el esquema
entero desde `SQLModel.metadata.create_all` con el modelo de HOY -- así que la
columna ya existe cuando esta migración corre ahí. El camino que sí se ejercita
es el de una base que venía de la 0023.
"""

import sqlalchemy as sa
from alembic import op

revision = "0024_survey_max_attempts"
down_revision = "0023_response_hygiene"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "max_attempts" not in cols:
            batch.add_column(sa.Column("max_attempts", sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "max_attempts" in cols:
            batch.drop_column("max_attempts")
