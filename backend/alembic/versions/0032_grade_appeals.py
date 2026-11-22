"""grade_appeals: reclamos de nota por pregunta.

Revision ID: 0032_grade_appeals
Revises: 0031_survey_attempts
Create Date: 2026-11-22

Idempotente.
"""

import sqlalchemy as sa
from alembic import op

revision = "0032_grade_appeals"
down_revision = "0031_survey_attempts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "grade_appeals" in insp.get_table_names():
        return
    op.create_table(
        "grade_appeals",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("survey_id", sa.Uuid(), nullable=False),
        sa.Column("response_id", sa.Uuid(), nullable=False),
        sa.Column("question", sa.String(), nullable=False),
        sa.Column("message", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("reply", sa.String(), nullable=True),
        sa.Column("award_before", sa.Float(), nullable=True),
        sa.Column("award_after", sa.Float(), nullable=True),
        sa.Column("resolved_by_email", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["response_id"], ["survey_responses.id"], ondelete="CASCADE"),
    )
    for col in ("survey_id", "response_id", "status"):
        op.create_index(f"ix_grade_appeals_{col}", "grade_appeals", [col])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "grade_appeals" in insp.get_table_names():
        op.drop_table("grade_appeals")
