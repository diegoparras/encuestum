"""campos ocultos, cupos, resultados públicos y plantillas propias.

Revision ID: 0034_campos_cupos_plantillas
Revises: 0033_distribucion_privacidad
Create Date: 2026-11-22

Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0034_campos_cupos_plantillas"
down_revision = "0033_distribucion_privacidad"
branch_labels = None
depends_on = None

_SURVEY_COLS = ("hidden_fields", "quotas", "public_results")


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    have = {c["name"] for c in insp.get_columns("surveys")}
    for name in _SURVEY_COLS:
        if name not in have:
            op.add_column("surveys", sa.Column(name, sa.JSON(), nullable=True))
    if "survey_templates" not in insp.get_table_names():
        op.create_table(
            "survey_templates",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("category", sa.String(), nullable=True),
            sa.Column("json_schema", sa.JSON(), nullable=False),
            sa.Column("evaluation", sa.JSON(), nullable=True),
            sa.Column("theme", sa.JSON(), nullable=True),
            sa.Column("language", sa.String(), nullable=True),
            sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_by", sa.Uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index("ix_survey_templates_org_id", "survey_templates", ["org_id"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "survey_templates" in insp.get_table_names():
        op.drop_table("survey_templates")
    have = {c["name"] for c in insp.get_columns("surveys")}
    for name in _SURVEY_COLS:
        if name in have:
            op.drop_column("surveys", name)
