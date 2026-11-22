"""traducciones de encuestas y formas fijas de examen.

Revision ID: 0035_traducciones_formas
Revises: 0034_campos_cupos_plantillas
Create Date: 2026-11-22

Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0035_traducciones_formas"
down_revision = "0034_campos_cupos_plantillas"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "translations" not in {c["name"] for c in insp.get_columns("surveys")}:
        op.add_column("surveys", sa.Column("translations", sa.JSON(), nullable=True))
    if "form" not in {c["name"] for c in insp.get_columns("survey_attempts")}:
        op.add_column("survey_attempts", sa.Column("form", sa.String(), nullable=True))


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "translations" in {c["name"] for c in insp.get_columns("surveys")}:
        op.drop_column("surveys", "translations")
    if "form" in {c["name"] for c in insp.get_columns("survey_attempts")}:
        op.drop_column("survey_attempts", "form")
