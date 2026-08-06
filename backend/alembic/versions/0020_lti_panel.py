"""lti_resource_links: título del curso y vínculo anónimo.

Revision ID: 0020_lti_panel
Revises: 0019_lti
Create Date: 2026-08-06

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0020_lti_panel"
down_revision = "0019_lti"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("lti_resource_links")}
    with op.batch_alter_table("lti_resource_links") as batch:
        if "context_title" not in cols:
            batch.add_column(sa.Column("context_title", sa.String(), nullable=True))
        if "anonymous" not in cols:
            # `server_default="0"` (string, no `sa.text`) es el patrón que ya usa
            # el resto de las migraciones de esta suite para columnas Boolean
            # agregadas a tablas existentes (ver 0009_survey_access.py y
            # 0014_require_captcha.py) -- SQLAlchemy lo traduce al literal
            # correcto según el dialecto (`0` en SQLite, `false` en PostgreSQL),
            # verificado a mano contra la PostgreSQL de `dev/moodle/`. No hace
            # falta branchear por `bind.dialect.name`.
            batch.add_column(
                sa.Column("anonymous", sa.Boolean(), nullable=False, server_default="0")
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("lti_resource_links")}
    with op.batch_alter_table("lti_resource_links") as batch:
        if "anonymous" in cols:
            batch.drop_column("anonymous")
        if "context_title" in cols:
            batch.drop_column("context_title")
