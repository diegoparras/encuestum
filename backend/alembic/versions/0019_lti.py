"""Tablas LTI 1.3 y atribución LTI en las respuestas.

Revision ID: 0019_lti
Revises: 0018_survey_report
Create Date: 2026-08-03

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0019_lti"
down_revision = "0018_survey_report"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "lti_platforms" not in tables:
        op.create_table(
            "lti_platforms",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("issuer", sa.String(), nullable=False, index=True),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("deployment_ids", sa.JSON(), nullable=False),
            sa.Column("auth_login_url", sa.String(), nullable=False),
            sa.Column("auth_token_url", sa.String(), nullable=False),
            sa.Column("jwks_url", sa.String(), nullable=False),
            sa.Column(
                "org_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                nullable=True,
                index=True,
            ),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("issuer", "client_id", name="uq_lti_platform_issuer_client"),
        )

    if "lti_resource_links" not in tables:
        op.create_table(
            "lti_resource_links",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column(
                "platform_id",
                sa.Uuid(),
                sa.ForeignKey("lti_platforms.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("resource_link_id", sa.String(), nullable=False),
            sa.Column("context_id", sa.String(), nullable=True),
            sa.Column(
                "survey_id",
                sa.Uuid(),
                sa.ForeignKey("surveys.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("lineitem_url", sa.String(), nullable=True),
            sa.Column("lineitems_url", sa.String(), nullable=True),
            sa.Column("max_score", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("platform_id", "resource_link_id", name="uq_lti_link"),
        )

    if "lti_users" not in tables:
        op.create_table(
            "lti_users",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column(
                "platform_id",
                sa.Uuid(),
                sa.ForeignKey("lti_platforms.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("sub", sa.String(), nullable=False, index=True),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("roles", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("platform_id", "sub", name="uq_lti_user"),
        )

    if "lti_keys" not in tables:
        op.create_table(
            "lti_keys",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("kid", sa.String(), nullable=False, unique=True),
            sa.Column("private_pem", sa.String(), nullable=False),
            sa.Column("public_pem", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "lti_link_id" not in cols:
            batch.add_column(sa.Column("lti_link_id", sa.Uuid(), nullable=True))
        if "lti_sub" not in cols:
            batch.add_column(sa.Column("lti_sub", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "lti_sub" in cols:
            batch.drop_column("lti_sub")
        if "lti_link_id" in cols:
            batch.drop_column("lti_link_id")

    tables = set(insp.get_table_names())
    for t in ("lti_keys", "lti_users", "lti_resource_links", "lti_platforms"):
        if t in tables:
            op.drop_table(t)
