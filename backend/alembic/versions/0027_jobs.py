"""jobs: cola de tareas persistente (entregas al LMS, webhooks, emails,
recorrecciones masivas).

Revision ID: 0027_jobs
Revises: 0026_trazabilidad
Create Date: 2026-11-21

Reemplaza a los `asyncio.create_task` sueltos (ver `app/jobs.py`). Es también
el registro de entregas: cada nota enviada, webhook o email es una fila con su
estado, intentos y último error.

`survey_id`/`response_id` sin FK a propósito, como en `audit_events`.

Idempotente: en una base nueva la 0001 ya la creó desde el modelo de hoy.
"""

import sqlalchemy as sa
from alembic import op

revision = "0027_jobs"
down_revision = "0026_trazabilidad"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "jobs" in insp.get_table_names():
        return
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="6"),
        sa.Column("run_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("progress", sa.JSON(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("dedupe_key", sa.String(), nullable=True),
        sa.Column("org_id", sa.Uuid(), nullable=True),
        sa.Column("survey_id", sa.Uuid(), nullable=True),
        sa.Column("response_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
    )
    for col in ("kind", "status", "run_after", "dedupe_key", "org_id", "survey_id", "response_id"):
        op.create_index(f"ix_jobs_{col}", "jobs", [col])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "jobs" in insp.get_table_names():
        op.drop_table("jobs")
