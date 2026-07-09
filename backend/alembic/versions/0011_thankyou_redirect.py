"""surveys.thankyou_message + surveys.redirect_url

Revision ID: 0011_thankyou_redirect
Revises: 0010_notify_emails
Create Date: 2026-07-09

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0011_thankyou_redirect"
down_revision = "0010_notify_emails"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "thankyou_message" not in cols:
            batch.add_column(sa.Column("thankyou_message", sa.String(), nullable=True))
        if "redirect_url" not in cols:
            batch.add_column(sa.Column("redirect_url", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "redirect_url" in cols:
            batch.drop_column("redirect_url")
        if "thankyou_message" in cols:
            batch.drop_column("thankyou_message")
