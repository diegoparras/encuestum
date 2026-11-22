"""survey_versions: motivo y autor de cada versión (historial del editor).

Revision ID: 0029_survey_version_meta
Revises: 0028_survey_drafts
Create Date: 2026-11-21

Idempotente: en una base nueva la 0001 ya creó las columnas.
"""

import sqlalchemy as sa
from alembic import op

revision = "0029_survey_version_meta"
down_revision = "0028_survey_drafts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("survey_versions")}
    with op.batch_alter_table("survey_versions") as batch:
        if "label" not in cols:
            batch.add_column(sa.Column("label", sa.String(), nullable=True))
        if "created_by" not in cols:
            batch.add_column(sa.Column("created_by", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_survey_versions_created_by", "users", ["created_by"], ["id"], ondelete="SET NULL"
            )
        if "created_by_email" not in cols:
            batch.add_column(sa.Column("created_by_email", sa.String(), nullable=True))


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("survey_versions")}
    with op.batch_alter_table("survey_versions") as batch:
        for c in ("created_by_email", "created_by", "label"):
            if c in cols:
                batch.drop_column(c)
