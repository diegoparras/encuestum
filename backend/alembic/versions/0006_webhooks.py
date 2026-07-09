"""webhooks table

Revision ID: 0006_webhooks
Revises: 0005_survey_close
Create Date: 2026-07-09

Idempotent (0001 metadata.create_all builds it on fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_webhooks"
down_revision = "0005_survey_close"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "webhooks" not in set(sa.inspect(bind).get_table_names()):
        op.create_table(
            "webhooks",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("survey_id", sa.Uuid(), nullable=True),
            sa.Column("url", sa.String(), nullable=False),
            sa.Column("secret", sa.String(), nullable=False),
            sa.Column("active", sa.Boolean(), nullable=False, server_default="1"),
            sa.Column("created_by", sa.Uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index("ix_webhooks_org_id", "webhooks", ["org_id"])
        op.create_index("ix_webhooks_survey_id", "webhooks", ["survey_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if "webhooks" in set(sa.inspect(bind).get_table_names()):
        op.drop_table("webhooks")
