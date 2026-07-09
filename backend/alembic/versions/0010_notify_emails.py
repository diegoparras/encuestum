"""surveys.notify_emails

Revision ID: 0010_notify_emails
Revises: 0009_survey_access
Create Date: 2026-07-09

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0010_notify_emails"
down_revision = "0009_survey_access"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    if "notify_emails" not in cols:
        with op.batch_alter_table("surveys") as batch:
            batch.add_column(sa.Column("notify_emails", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    if "notify_emails" in cols:
        with op.batch_alter_table("surveys") as batch:
            batch.drop_column("notify_emails")
