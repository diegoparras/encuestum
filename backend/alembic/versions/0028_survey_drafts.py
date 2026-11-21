"""survey_drafts: respuestas a medio hacer, para retomar desde otro dispositivo.

Revision ID: 0028_survey_drafts
Revises: 0027_jobs
Create Date: 2026-11-21

Sólo para quien tiene identidad (invitado con código o alumno desde Moodle);
ver `app/models.py::SurveyDraft`. Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0028_survey_drafts"
down_revision = "0027_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "survey_drafts" in insp.get_table_names():
        return
    op.create_table(
        "survey_drafts",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("survey_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.Column("page", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("survey_id", "key", name="uq_survey_draft_key"),
    )
    op.create_index("ix_survey_drafts_survey_id", "survey_drafts", ["survey_id"])
    op.create_index("ix_survey_drafts_updated_at", "survey_drafts", ["updated_at"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "survey_drafts" in insp.get_table_names():
        op.drop_table("survey_drafts")
