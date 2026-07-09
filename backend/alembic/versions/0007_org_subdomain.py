"""organizations.subdomain + organizations.logo

Revision ID: 0007_org_subdomain
Revises: 0006_webhooks
Create Date: 2026-07-09

Idempotent (0001 metadata.create_all builds them on fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0007_org_subdomain"
down_revision = "0006_webhooks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("organizations")}
    idx = {i["name"] for i in insp.get_indexes("organizations")}
    with op.batch_alter_table("organizations") as batch:
        if "subdomain" not in cols:
            batch.add_column(sa.Column("subdomain", sa.String(), nullable=True))
        if "logo" not in cols:
            batch.add_column(sa.Column("logo", sa.String(), nullable=True))
    if "ix_organizations_subdomain" not in idx:
        op.create_index("ix_organizations_subdomain", "organizations", ["subdomain"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    idx = {i["name"] for i in insp.get_indexes("organizations")}
    if "ix_organizations_subdomain" in idx:
        op.drop_index("ix_organizations_subdomain", table_name="organizations")
    cols = {c["name"] for c in insp.get_columns("organizations")}
    with op.batch_alter_table("organizations") as batch:
        if "logo" in cols:
            batch.drop_column("logo")
        if "subdomain" in cols:
            batch.drop_column("subdomain")
