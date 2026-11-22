"""survey_attempts: intentos de examen (inicio, plazo y preguntas sorteadas).

Revision ID: 0031_survey_attempts
Revises: 0030_bank_items
Create Date: 2026-11-22

Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0031_survey_attempts"
down_revision = "0030_bank_items"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "survey_attempts" in insp.get_table_names():
        return
    op.create_table(
        "survey_attempts",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("survey_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("drawn", sa.JSON(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("response_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_survey_attempts_survey_id", "survey_attempts", ["survey_id"])
    op.create_index("ix_survey_attempts_key", "survey_attempts", ["key"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "survey_attempts" in insp.get_table_names():
        op.drop_table("survey_attempts")
