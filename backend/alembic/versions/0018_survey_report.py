"""surveys.report (informe ejecutivo por IA, cacheado)

Revision ID: 0018_survey_report
Revises: 0017_survey_deleted_at
Create Date: 2026-07-14

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0018_survey_report"
down_revision = "0017_survey_deleted_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "report" not in cols:
            batch.add_column(sa.Column("report", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "report" in cols:
            batch.drop_column("report")
