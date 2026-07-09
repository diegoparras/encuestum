"""assets table (uploaded images/audio for survey design)

Revision ID: 0003_assets
Revises: 0002_invites_verify
Create Date: 2026-07-09

Idempotent (the 0001 metadata.create_all already builds it on fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0003_assets"
down_revision = "0002_invites_verify"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "assets" not in set(insp.get_table_names()):
        op.create_table(
            "assets",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("filename", sa.String(), nullable=False),
            sa.Column("original_name", sa.String(), nullable=True),
            sa.Column("content_type", sa.String(), nullable=False),
            sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_by", sa.Uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        )
        op.create_index("ix_assets_org_id", "assets", ["org_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "assets" in set(insp.get_table_names()):
        op.drop_table("assets")
