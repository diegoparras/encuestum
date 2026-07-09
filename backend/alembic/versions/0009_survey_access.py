"""survey access control: modes, pin, results release, invitees allowlist

Revision ID: 0009_survey_access
Revises: 0008_ai_providers
Create Date: 2026-07-09

Idempotent (0001 metadata.create_all builds fresh DBs).
"""

import sqlalchemy as sa
from alembic import op

revision = "0009_survey_access"
down_revision = "0008_ai_providers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    scols = {c["name"] for c in insp.get_columns("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "access_mode" not in scols:
            batch.add_column(sa.Column("access_mode", sa.String(), nullable=False, server_default="public"))
        if "access_pin" not in scols:
            batch.add_column(sa.Column("access_pin", sa.String(), nullable=True))
        if "results_mode" not in scols:
            batch.add_column(sa.Column("results_mode", sa.String(), nullable=False, server_default="immediate"))
        if "results_released" not in scols:
            batch.add_column(sa.Column("results_released", sa.Boolean(), nullable=False, server_default="0"))

    rcols = {c["name"] for c in insp.get_columns("survey_responses")}
    ridx = {i["name"] for i in insp.get_indexes("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "respondent_email" not in rcols:
            batch.add_column(sa.Column("respondent_email", sa.String(), nullable=True))
        if "respondent_code" not in rcols:
            batch.add_column(sa.Column("respondent_code", sa.String(), nullable=True))
    if "ix_survey_responses_respondent_email" not in ridx:
        op.create_index("ix_survey_responses_respondent_email", "survey_responses", ["respondent_email"])
    if "ix_survey_responses_respondent_code" not in ridx:
        op.create_index("ix_survey_responses_respondent_code", "survey_responses", ["respondent_code"])

    if "survey_invitees" not in set(insp.get_table_names()):
        op.create_table(
            "survey_invitees",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("survey_id", sa.Uuid(), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("email", sa.String(), nullable=False, index=True),
            sa.Column("code", sa.String(), nullable=False, index=True),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("survey_id", "email", name="uq_invitee_survey_email"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "survey_invitees" in set(insp.get_table_names()):
        op.drop_table("survey_invitees")
    ridx = {i["name"] for i in insp.get_indexes("survey_responses")}
    for ix in ("ix_survey_responses_respondent_email", "ix_survey_responses_respondent_code"):
        if ix in ridx:
            op.drop_index(ix, table_name="survey_responses")
    with op.batch_alter_table("survey_responses") as batch:
        for c in ("respondent_email", "respondent_code"):
            if c in {col["name"] for col in insp.get_columns("survey_responses")}:
                batch.drop_column(c)
    with op.batch_alter_table("surveys") as batch:
        for c in ("access_mode", "access_pin", "results_mode", "results_released"):
            if c in {col["name"] for col in insp.get_columns("surveys")}:
                batch.drop_column(c)
