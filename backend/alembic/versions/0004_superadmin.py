"""users.is_superadmin

Revision ID: 0004_superadmin
Revises: 0003_assets
Create Date: 2026-07-09

Idempotent (0001 metadata.create_all builds it on fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0004_superadmin"
down_revision = "0003_assets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "is_superadmin" not in cols:
        with op.batch_alter_table("users") as batch:
            batch.add_column(
                sa.Column("is_superadmin", sa.Boolean(), nullable=False, server_default="0")
            )


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "is_superadmin" in cols:
        with op.batch_alter_table("users") as batch:
            batch.drop_column("is_superadmin")
