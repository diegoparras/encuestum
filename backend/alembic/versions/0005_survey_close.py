"""surveys.closes_at + surveys.max_responses

Revision ID: 0005_survey_close
Revises: 0004_superadmin
Create Date: 2026-07-09

Idempotent (0001 metadata.create_all builds them on fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0005_survey_close"
down_revision = "0004_superadmin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "closes_at" not in cols:
            batch.add_column(sa.Column("closes_at", sa.DateTime(timezone=True), nullable=True))
        if "max_responses" not in cols:
            batch.add_column(sa.Column("max_responses", sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "max_responses" in cols:
            batch.drop_column("max_responses")
        if "closes_at" in cols:
            batch.drop_column("closes_at")
