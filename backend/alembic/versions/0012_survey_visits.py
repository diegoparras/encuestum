"""survey_visits (funnel: view → start → complete + drop-off)

Revision ID: 0012_survey_visits
Revises: 0011_thankyou_redirect
Create Date: 2026-07-09

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0012_survey_visits"
down_revision = "0011_thankyou_redirect"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "survey_visits" not in set(insp.get_table_names()):
        op.create_table(
            "survey_visits",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("survey_id", sa.Uuid(), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("visitor_id", sa.String(), nullable=False, index=True),
            sa.Column("started", sa.Boolean(), nullable=False, server_default="0"),
            sa.Column("completed", sa.Boolean(), nullable=False, server_default="0"),
            sa.Column("last_question", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("survey_id", "visitor_id", name="uq_visit_survey_visitor"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "survey_visits" in set(insp.get_table_names()):
        op.drop_table("survey_visits")
