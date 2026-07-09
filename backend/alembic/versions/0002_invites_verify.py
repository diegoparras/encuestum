"""invitations table + users.email_verified

Revision ID: 0002_invites_verify
Revises: 0001_initial
Create Date: 2026-07-09

Idempotente a propósito: la 0001 materializa el esquema desde el metadata actual,
así que en una DB nueva estas columnas/tablas ya existen y este paso las saltea;
en una DB que sólo corrió la 0001 vieja, las agrega.
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_invites_verify"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    user_cols = {c["name"] for c in insp.get_columns("users")}
    if "email_verified" not in user_cols:
        with op.batch_alter_table("users") as batch:
            batch.add_column(
                sa.Column("email_verified", sa.Boolean(), nullable=False, server_default="0")
            )

    if "invitations" not in set(insp.get_table_names()):
        op.create_table(
            "invitations",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("invited_by", sa.Uuid(), nullable=True),
            sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["invited_by"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index("ix_invitations_org_id", "invitations", ["org_id"])
        op.create_index("ix_invitations_email", "invitations", ["email"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "invitations" in set(insp.get_table_names()):
        op.drop_table("invitations")
    user_cols = {c["name"] for c in insp.get_columns("users")}
    if "email_verified" in user_cols:
        with op.batch_alter_table("users") as batch:
            batch.drop_column("email_verified")
