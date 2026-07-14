"""surveys.deleted_at (papelera / soft-delete)

Revision ID: 0017_survey_deleted_at
Revises: 0016_survey_grading_message
Create Date: 2026-07-14

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0017_survey_deleted_at"
down_revision = "0016_survey_grading_message"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    indexes = {i["name"] for i in insp.get_indexes("surveys")}
    with op.batch_alter_table("surveys") as batch:
        if "deleted_at" not in cols:
            batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    # Se filtra por deleted_at IS NULL en cada listado y en el acceso público.
    if "ix_surveys_deleted_at" not in indexes:
        op.create_index("ix_surveys_deleted_at", "surveys", ["deleted_at"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("surveys")}
    indexes = {i["name"] for i in insp.get_indexes("surveys")}
    if "ix_surveys_deleted_at" in indexes:
        op.drop_index("ix_surveys_deleted_at", table_name="surveys")
    with op.batch_alter_table("surveys") as batch:
        if "deleted_at" in cols:
            batch.drop_column("deleted_at")
