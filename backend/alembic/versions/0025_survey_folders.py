"""survey_folders: carpetas (y subcarpetas) para agrupar encuestas.

Revision ID: 0025_survey_folders
Revises: 0024_survey_max_attempts
Create Date: 2026-08-11

Las carpetas son de la organización, cuelgan unas de otras (`parent_id`) y
llevan un color libre. La encuesta apunta a la suya con `surveys.folder_id`.

Dos decisiones de borrado, distintas a propósito:
* `survey_folders.parent_id` CASCADE: borrar una carpeta se lleva el subárbol de
  carpetas (el endpoint sube las hijas antes, así que en la práctica no
  encadena; el CASCADE está para que la base nunca quede con carpetas huérfanas).
* `surveys.folder_id` SET NULL: borrar una carpeta NUNCA borra encuestas. Las
  deja en la raíz.

Idempotente. Una base nueva arranca por la 0001, que materializa el esquema
entero desde `SQLModel.metadata.create_all` con el modelo de HOY -- así que todo
esto ya existe cuando esta migración corre ahí. El camino que sí se ejercita es
el de una base que venía de la 0024.
"""

import sqlalchemy as sa
from alembic import op

revision = "0025_survey_folders"
down_revision = "0024_survey_max_attempts"
branch_labels = None
depends_on = None

_IX_FOLDER = "ix_surveys_folder_id"


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if "survey_folders" not in insp.get_table_names():
        op.create_table(
            "survey_folders",
            sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("parent_id", sa.Uuid(), nullable=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("color", sa.String(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["parent_id"], ["survey_folders.id"], ondelete="CASCADE"),
        )
        op.create_index("ix_survey_folders_org_id", "survey_folders", ["org_id"])
        op.create_index("ix_survey_folders_parent_id", "survey_folders", ["parent_id"])

    cols = {c["name"] for c in insp.get_columns("surveys")}
    if "folder_id" not in cols:
        # La FK va en el mismo paso: en SQLite colgar una FK obliga a un rebuild
        # de la tabla, y hacerlo en un solo `batch` evita repetirlo.
        with op.batch_alter_table("surveys") as batch:
            batch.add_column(sa.Column("folder_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_surveys_folder_id_survey_folders",
                "survey_folders",
                ["folder_id"],
                ["id"],
                ondelete="SET NULL",
            )

    if _IX_FOLDER not in {i["name"] for i in insp.get_indexes("surveys")}:
        op.create_index(_IX_FOLDER, "surveys", ["folder_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _IX_FOLDER in {i["name"] for i in insp.get_indexes("surveys")}:
        op.drop_index(_IX_FOLDER, table_name="surveys")

    if "folder_id" in {c["name"] for c in insp.get_columns("surveys")}:
        with op.batch_alter_table("surveys") as batch:
            batch.drop_column("folder_id")

    if "survey_folders" in insp.get_table_names():
        op.drop_table("survey_folders")
