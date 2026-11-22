"""bank_items: banco de preguntas por organización.

Revision ID: 0030_bank_items
Revises: 0029_survey_version_meta
Create Date: 2026-11-22

Idempotente: en una base nueva la 0001 ya la creó desde el modelo de hoy.
"""

import sqlalchemy as sa
from alembic import op

revision = "0030_bank_items"
down_revision = "0029_survey_version_meta"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "bank_items" in insp.get_table_names():
        return
    op.create_table(
        "bank_items",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("qtype", sa.String(), nullable=False),
        sa.Column("element", sa.JSON(), nullable=False),
        sa.Column("grading", sa.JSON(), nullable=True),
        sa.Column("topic", sa.String(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("difficulty", sa.String(), nullable=True),
        sa.Column("bloom", sa.String(), nullable=True),
        sa.Column("source_survey_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
    )
    for col in ("org_id", "qtype", "topic"):
        op.create_index(f"ix_bank_items_{col}", "bank_items", [col])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "bank_items" in insp.get_table_names():
        op.drop_table("bank_items")
