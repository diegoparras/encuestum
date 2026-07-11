"""surveys.grading_message (texto mientras se corrige por IA)

Revision ID: 0016_survey_grading_message
Revises: 0015_survey_opens_at
Create Date: 2026-07-11

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0016_survey_grading_message"
down_revision = "0015_survey_opens_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "grading_message" not in cols:
            batch.add_column(sa.Column("grading_message", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "grading_message" in cols:
            batch.drop_column("grading_message")
