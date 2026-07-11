"""surveys.opens_at (fecha/hora de apertura programada)

Revision ID: 0015_survey_opens_at
Revises: 0014_require_captcha
Create Date: 2026-07-11

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0015_survey_opens_at"
down_revision = "0014_require_captcha"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "opens_at" not in cols:
            batch.add_column(
                sa.Column("opens_at", sa.DateTime(timezone=True), nullable=True)
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "opens_at" in cols:
            batch.drop_column("opens_at")
