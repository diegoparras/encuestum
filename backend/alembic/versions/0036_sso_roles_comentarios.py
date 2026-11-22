"""SSO por organización, alcance por carpetas, comentarios y aprobación.

Revision ID: 0036_sso_roles_comentarios
Revises: 0035_traducciones_formas
Create Date: 2026-11-22

Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0036_sso_roles_comentarios"
down_revision = "0035_traducciones_formas"
branch_labels = None
depends_on = None


def _add(insp, table, col):
    if col.name not in {c["name"] for c in insp.get_columns(table)}:
        op.add_column(table, col)


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    _add(insp, "memberships", sa.Column("folder_scope", sa.JSON(), nullable=True))
    _add(insp, "organizations", sa.Column("require_publish_approval", sa.Boolean(), nullable=False,
                                          server_default=sa.false()))
    _add(insp, "surveys", sa.Column("approval", sa.JSON(), nullable=True))
    tablas = insp.get_table_names()
    if "survey_comments" not in tablas:
        op.create_table(
            "survey_comments",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("survey_id", sa.Uuid(), nullable=False),
            sa.Column("question", sa.String(), nullable=True),
            sa.Column("body", sa.String(), nullable=False),
            sa.Column("author_id", sa.Uuid(), nullable=True),
            sa.Column("author_email", sa.String(), nullable=True),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index("ix_survey_comments_survey_id", "survey_comments", ["survey_id"])
    if "org_sso" not in tablas:
        op.create_table(
            "org_sso",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("org_id", sa.Uuid(), nullable=False, unique=True),
            sa.Column("issuer", sa.String(), nullable=False),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("client_secret", sa.String(), nullable=True),
            sa.Column("domains", sa.JSON(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("auto_provision", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("default_role", sa.String(), nullable=False, server_default="member"),
            sa.Column("enforce", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        )


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for t in ("org_sso", "survey_comments"):
        if t in insp.get_table_names():
            op.drop_table(t)
    for table, col in (("memberships", "folder_scope"), ("organizations", "require_publish_approval"),
                       ("surveys", "approval")):
        if col in {c["name"] for c in insp.get_columns(table)}:
            op.drop_column(table, col)
