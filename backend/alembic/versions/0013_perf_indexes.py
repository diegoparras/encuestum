"""Composite performance indexes (survey_responses, ai_usage)

Revision ID: 0013_perf_indexes
Revises: 0012_survey_visits
Create Date: 2026-07-10

Idempotent (checks existing indexes before creating).
"""

import sqlalchemy as sa
from alembic import op

revision = "0013_perf_indexes"
down_revision = "0012_survey_visits"
branch_labels = None
depends_on = None


# (index name, table, columns)
_INDEXES = [
    ("ix_survey_responses_survey_submitted", "survey_responses", ["survey_id", "submitted_at"]),
    ("ix_survey_responses_survey_respondent", "survey_responses", ["survey_id", "respondent_code"]),
    ("ix_ai_usage_org_created", "ai_usage", ["org_id", "created_at"]),
]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    for name, table, cols in _INDEXES:
        if table not in tables:
            continue
        existing = {i["name"] for i in insp.get_indexes(table)}
        if name not in existing:
            op.create_index(name, table, cols)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    for name, table, _cols in _INDEXES:
        if table not in tables:
            continue
        existing = {i["name"] for i in insp.get_indexes(table)}
        if name in existing:
            op.drop_index(name, table_name=table)
