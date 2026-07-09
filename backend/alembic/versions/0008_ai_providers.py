"""ai_providers + ai_usage + ai_model_prices

Revision ID: 0008_ai_providers
Revises: 0007_org_subdomain
Create Date: 2026-07-09

Idempotent: only creates tables that don't already exist (0001 metadata.create_all
builds them on fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0008_ai_providers"
down_revision = "0007_org_subdomain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "ai_providers" not in tables:
        op.create_table(
            "ai_providers",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("base_url", sa.String(), nullable=False),
            sa.Column("api_key", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default="0"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
            sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )

    if "ai_usage" not in tables:
        op.create_table(
            "ai_usage",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True),
            sa.Column("provider_id", sa.Uuid(), sa.ForeignKey("ai_providers.id", ondelete="SET NULL"), nullable=True, index=True),
            sa.Column("survey_id", sa.Uuid(), sa.ForeignKey("surveys.id", ondelete="SET NULL"), nullable=True, index=True),
            sa.Column("operation", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("cost_usd", sa.Float(), nullable=True),
            sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )

    if "ai_model_prices" not in tables:
        op.create_table(
            "ai_model_prices",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("input_per_m", sa.Float(), nullable=False),
            sa.Column("output_per_m", sa.Float(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("kind", "model", name="uq_ai_price_kind_model"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    for t in ("ai_usage", "ai_model_prices", "ai_providers"):
        if t in tables:
            op.drop_table(t)
