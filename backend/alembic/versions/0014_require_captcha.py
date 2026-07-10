"""surveys.require_captcha (anti-bot proof-of-work)

Revision ID: 0014_require_captcha
Revises: 0013_perf_indexes
Create Date: 2026-07-10

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0014_require_captcha"
down_revision = "0013_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "require_captcha" not in cols:
            batch.add_column(
                sa.Column(
                    "require_captcha",
                    sa.Boolean(),
                    nullable=False,
                    server_default="0",
                )
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "require_captcha" in cols:
            batch.drop_column("require_captcha")
