"""Tablas LTI 1.3 y atribución LTI en las respuestas.

Revision ID: 0019_lti
Revises: 0018_survey_report
Create Date: 2026-08-03

Idempotent.
"""

import sqlalchemy as sa
from alembic import op

revision = "0019_lti"
down_revision = "0018_survey_report"
branch_labels = None
depends_on = None

_FK_LTI_LINK = "fk_survey_responses_lti_link_id_lti_resource_links"
_IX_LTI_LINK = "ix_survey_responses_lti_link_id"
_IX_LTI_SUB = "ix_survey_responses_lti_sub"


def _has_fk(insp: sa.engine.reflection.Inspector, table: str, column: str, ref_table: str) -> bool:
    """True si ya existe una FK de `table.column` a `ref_table`, sin importar
    su nombre -- una fila creada por `SQLModel.metadata.create_all` (ver la
    0001, que arma el esquema entero desde el modelo actual) trae la misma FK
    que esta migración agrega a mano, pero sin ningún nombre explícito."""
    for fk in insp.get_foreign_keys(table):
        if fk.get("referred_table") == ref_table and column in (fk.get("constrained_columns") or []):
            return True
    return False


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "lti_platforms" not in tables:
        op.create_table(
            "lti_platforms",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("issuer", sa.String(), nullable=False, index=True),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("deployment_ids", sa.JSON(), nullable=False),
            sa.Column("auth_login_url", sa.String(), nullable=False),
            sa.Column("auth_token_url", sa.String(), nullable=False),
            sa.Column("jwks_url", sa.String(), nullable=False),
            sa.Column(
                "org_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                nullable=True,
                index=True,
            ),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("issuer", "client_id", name="uq_lti_platform_issuer_client"),
        )

    if "lti_resource_links" not in tables:
        op.create_table(
            "lti_resource_links",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column(
                "platform_id",
                sa.Uuid(),
                sa.ForeignKey("lti_platforms.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("resource_link_id", sa.String(), nullable=False),
            sa.Column("context_id", sa.String(), nullable=True),
            sa.Column(
                "survey_id",
                sa.Uuid(),
                sa.ForeignKey("surveys.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("lineitem_url", sa.String(), nullable=True),
            sa.Column("lineitems_url", sa.String(), nullable=True),
            sa.Column("max_score", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("platform_id", "resource_link_id", name="uq_lti_link"),
        )

    if "lti_users" not in tables:
        op.create_table(
            "lti_users",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column(
                "platform_id",
                sa.Uuid(),
                sa.ForeignKey("lti_platforms.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("sub", sa.String(), nullable=False, index=True),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("roles", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("platform_id", "sub", name="uq_lti_user"),
        )

    if "lti_keys" not in tables:
        op.create_table(
            "lti_keys",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("kid", sa.String(), nullable=False, unique=True),
            sa.Column("private_pem", sa.String(), nullable=False),
            sa.Column("public_pem", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "lti_link_id" not in cols:
            batch.add_column(sa.Column("lti_link_id", sa.Uuid(), nullable=True))
        if "lti_sub" not in cols:
            batch.add_column(sa.Column("lti_sub", sa.String(), nullable=True))

    # El modelo (`app/models.py::SurveyResponse`) declara `lti_link_id` con
    # `ForeignKey(..., ondelete="SET NULL")` e `index=True` en ambas columnas
    # -- lo que arriba sólo agregó fue las columnas pelonas. Sin este bloque,
    # una base que YA venía de la 0018 (la 0019 vieja corrió sobre ella)
    # queda con el esquema divergiendo en silencio del modelo para siempre:
    # una base nueva, en cambio, arranca por la 0001
    # (`SQLModel.metadata.create_all` con el modelo de HOY) y ya trae FK e
    # índices -- por eso los tres chequeos de abajo, para no duplicar nada ahí.
    #
    # Se separa del `add_column` de arriba porque en SQLite `add_column` sólo
    # es una ALTER TABLE nativa cuando no toca agregar una FK -- agregarla si
    # requiere reconstruir la tabla entera, que es lo que dispara
    # `batch_alter_table` cuando la operación lo exige.
    insp = sa.inspect(bind)
    idx = {i["name"] for i in insp.get_indexes("survey_responses")}
    if _IX_LTI_LINK not in idx:
        op.create_index(_IX_LTI_LINK, "survey_responses", ["lti_link_id"])
    if _IX_LTI_SUB not in idx:
        op.create_index(_IX_LTI_SUB, "survey_responses", ["lti_sub"])

    insp = sa.inspect(bind)
    if not _has_fk(insp, "survey_responses", "lti_link_id", "lti_resource_links"):
        with op.batch_alter_table("survey_responses") as batch:
            batch.create_foreign_key(
                _FK_LTI_LINK,
                "lti_resource_links",
                ["lti_link_id"],
                ["id"],
                ondelete="SET NULL",
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Sólo se dropea explícitamente la FK que esta migración pudo haber creado
    # con nombre propio (`_FK_LTI_LINK`). Una FK sin nombre (la que deja
    # `SQLModel.metadata.create_all` en una base nueva -- ver `upgrade()`) no
    # se puede apuntar por nombre para dropearla acá, pero no hace falta:
    # `drop_column` más abajo dispara un rebuild de tabla en SQLite que ya
    # omite cualquier FK atada a una columna que se está borrando.
    fk_names = {fk.get("name") for fk in insp.get_foreign_keys("survey_responses")}
    if _FK_LTI_LINK in fk_names:
        with op.batch_alter_table("survey_responses") as batch:
            batch.drop_constraint(_FK_LTI_LINK, type_="foreignkey")

    insp = sa.inspect(bind)
    idx = {i["name"] for i in insp.get_indexes("survey_responses")}
    if _IX_LTI_SUB in idx:
        op.drop_index(_IX_LTI_SUB, table_name="survey_responses")
    if _IX_LTI_LINK in idx:
        op.drop_index(_IX_LTI_LINK, table_name="survey_responses")

    cols = {c["name"] for c in insp.get_columns("survey_responses")}
    with op.batch_alter_table("survey_responses") as batch:
        if "lti_sub" in cols:
            batch.drop_column("lti_sub")
        if "lti_link_id" in cols:
            batch.drop_column("lti_link_id")

    tables = set(insp.get_table_names())
    for t in ("lti_keys", "lti_users", "lti_resource_links", "lti_platforms"):
        if t in tables:
            op.drop_table(t)
