"""distribución, privacidad y API: seguimiento de invitaciones, recordatorios,
anonimato, retención, tope de IA y claves de API.

Revision ID: 0033_distribucion_privacidad
Revises: 0032_grade_appeals
Create Date: 2026-11-22

Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0033_distribucion_privacidad"
down_revision = "0032_grade_appeals"
branch_labels = None
depends_on = None

_COLS = {
    "organizations": [
        sa.Column("ai_monthly_budget_usd", sa.Float(), nullable=True),
        sa.Column("ai_budget_warned", sa.String(), nullable=True),
        sa.Column("retention_days", sa.Integer(), nullable=True),
        sa.Column("retention_action", sa.String(), nullable=True),
    ],
    "surveys": [
        sa.Column("anonymous", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("retention_days", sa.Integer(), nullable=True),
        sa.Column("retention_action", sa.String(), nullable=True),
        sa.Column("reminders", sa.JSON(), nullable=True),
    ],
    "survey_invitees": [
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reminders_sent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_reminded_at", sa.DateTime(timezone=True), nullable=True),
    ],
}


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for table, cols in _COLS.items():
        have = {c["name"] for c in insp.get_columns(table)}
        for col in cols:
            if col.name not in have:
                op.add_column(table, col)
    if "api_keys" not in insp.get_table_names():
        op.create_table(
            "api_keys",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("prefix", sa.String(), nullable=False),
            sa.Column("key_hash", sa.String(), nullable=False, unique=True),
            sa.Column("scope", sa.String(), nullable=False, server_default="read"),
            sa.Column("created_by", sa.Uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index("ix_api_keys_org_id", "api_keys", ["org_id"])
        op.create_index("ix_api_keys_prefix", "api_keys", ["prefix"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "api_keys" in insp.get_table_names():
        op.drop_table("api_keys")
    for table, cols in _COLS.items():
        have = {c["name"] for c in insp.get_columns(table)}
        for col in cols:
            if col.name in have:
                op.drop_column(table, col.name)
