"""Trazabilidad: versiones de encuesta, historial de notas y auditoría general.

Revision ID: 0026_trazabilidad
Revises: 0025_survey_folders
Create Date: 2026-11-21

* `survey_versions`: foto inmutable de estructura + rúbrica. Cada respuesta
  apunta a la que contestó (`survey_responses.survey_version_id`).
* `grade_revisions`: cada cambio de nota (al enviar, re-corrida, manual) con la
  nota anterior y la nueva, quién y con qué versión.
* `audit_events`: quién hizo qué y cuándo. `survey_id`/`response_id` sin FK a
  propósito, para sobrevivir al borrado definitivo de lo que describen.
* `survey_responses.integrity_hash`: SHA-256 de lo que llegó.
* `ai_usage.response_id`: qué respuesta se corrigió con cada llamada.

Idempotente. Una base nueva arranca por la 0001, que materializa el esquema
entero desde `SQLModel.metadata.create_all` con el modelo de HOY -- así que todo
esto ya existe cuando esta migración corre ahí. El camino que sí se ejercita es
el de una base que venía de la 0025.
"""

import sqlalchemy as sa
from alembic import op

revision = "0026_trazabilidad"
down_revision = "0025_survey_folders"
branch_labels = None
depends_on = None


def _cols(insp, tabla: str) -> set:
    return {c["name"] for c in insp.get_columns(tabla)}


def _indices(insp, tabla: str) -> set:
    return {i["name"] for i in insp.get_indexes(tabla)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tablas = set(insp.get_table_names())

    if "survey_versions" not in tablas:
        op.create_table(
            "survey_versions",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("survey_id", sa.Uuid(), nullable=False),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("json_schema", sa.JSON(), nullable=False),
            sa.Column("evaluation", sa.JSON(), nullable=True),
            sa.Column("content_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("survey_id", "number", name="uq_survey_version_number"),
        )
        op.create_index("ix_survey_versions_survey_id", "survey_versions", ["survey_id"])
        op.create_index("ix_survey_versions_content_hash", "survey_versions", ["content_hash"])

    if "grade_revisions" not in tablas:
        op.create_table(
            "grade_revisions",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("response_id", sa.Uuid(), nullable=False),
            sa.Column("survey_id", sa.Uuid(), nullable=False),
            sa.Column("source", sa.String(), nullable=False),
            sa.Column("actor_id", sa.Uuid(), nullable=True),
            sa.Column("actor_email", sa.String(), nullable=True),
            sa.Column("score_before", sa.Float(), nullable=True),
            sa.Column("score_after", sa.Float(), nullable=True),
            sa.Column("max_score", sa.Float(), nullable=True),
            sa.Column("grade_before", sa.JSON(), nullable=True),
            sa.Column("grade_after", sa.JSON(), nullable=True),
            sa.Column("survey_version_id", sa.Uuid(), nullable=True),
            sa.Column("note", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["response_id"], ["survey_responses.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["survey_version_id"], ["survey_versions.id"], ondelete="SET NULL"),
        )
        for col in ("response_id", "survey_id", "actor_id", "created_at"):
            op.create_index(f"ix_grade_revisions_{col}", "grade_revisions", [col])

    if "audit_events" not in tablas:
        op.create_table(
            "audit_events",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("org_id", sa.Uuid(), nullable=True),
            sa.Column("survey_id", sa.Uuid(), nullable=True),
            sa.Column("response_id", sa.Uuid(), nullable=True),
            sa.Column("actor_id", sa.Uuid(), nullable=True),
            sa.Column("actor_email", sa.String(), nullable=True),
            sa.Column("action", sa.String(), nullable=False),
            sa.Column("detail", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
        )
        for col in ("org_id", "survey_id", "response_id", "actor_id", "action", "created_at"):
            op.create_index(f"ix_audit_events_{col}", "audit_events", [col])

    cols = _cols(insp, "survey_responses")
    if "survey_version_id" not in cols or "integrity_hash" not in cols:
        with op.batch_alter_table("survey_responses") as batch:
            if "survey_version_id" not in cols:
                batch.add_column(sa.Column("survey_version_id", sa.Uuid(), nullable=True))
                batch.create_foreign_key(
                    "fk_survey_responses_survey_version_id",
                    "survey_versions",
                    ["survey_version_id"],
                    ["id"],
                    ondelete="SET NULL",
                )
            if "integrity_hash" not in cols:
                batch.add_column(sa.Column("integrity_hash", sa.String(), nullable=True))
    if "ix_survey_responses_survey_version_id" not in _indices(insp, "survey_responses"):
        op.create_index(
            "ix_survey_responses_survey_version_id", "survey_responses", ["survey_version_id"]
        )

    if "response_id" not in _cols(insp, "ai_usage"):
        with op.batch_alter_table("ai_usage") as batch:
            batch.add_column(sa.Column("response_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_ai_usage_response_id",
                "survey_responses",
                ["response_id"],
                ["id"],
                ondelete="SET NULL",
            )
    if "ix_ai_usage_response_id" not in _indices(insp, "ai_usage"):
        op.create_index("ix_ai_usage_response_id", "ai_usage", ["response_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if "ix_ai_usage_response_id" in _indices(insp, "ai_usage"):
        op.drop_index("ix_ai_usage_response_id", table_name="ai_usage")
    if "response_id" in _cols(insp, "ai_usage"):
        with op.batch_alter_table("ai_usage") as batch:
            batch.drop_column("response_id")

    if "ix_survey_responses_survey_version_id" in _indices(insp, "survey_responses"):
        op.drop_index("ix_survey_responses_survey_version_id", table_name="survey_responses")
    cols = _cols(insp, "survey_responses")
    with op.batch_alter_table("survey_responses") as batch:
        if "survey_version_id" in cols:
            batch.drop_column("survey_version_id")
        if "integrity_hash" in cols:
            batch.drop_column("integrity_hash")

    tablas = set(insp.get_table_names())
    for tabla in ("audit_events", "grade_revisions", "survey_versions"):
        if tabla in tablas:
            op.drop_table(tabla)
