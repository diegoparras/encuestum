"""mod_sites: sitios de Moodle conectados por el módulo nativo (mod_encuestum).

Revision ID: 0021_mod_sites
Revises: 0020_lti_panel
Create Date: 2026-08-06

Idempotent: una base nueva arranca por la 0001, que materializa el esquema
entero desde `SQLModel.metadata.create_all` con el modelo de HOY -- así que
`mod_sites` ya existe cuando esta migración corre ahí. El camino que esta
migración sí ejercita es el de una base que venía de la 0020.
"""

import sqlalchemy as sa
from alembic import op

revision = "0021_mod_sites"
down_revision = "0020_lti_panel"
branch_labels = None
depends_on = None

_IX_ORG = "ix_mod_sites_org_id"


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "mod_sites" in set(insp.get_table_names()):
        return

    op.create_table(
        "mod_sites",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "org_id",
            sa.Uuid(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Unicidad por `wwwroot` solo, no por `(org_id, wwwroot)`: un Moodle
        # pertenece a exactamente una organización (ver el docstring de
        # `MoodleSite` en `app/models.py`). Con la unicidad compuesta, dos
        # registros concurrentes desde organizaciones distintas se colaban por
        # la ventana entre el SELECT y el INSERT del endpoint.
        # Se guarda en forma canónica (ver `normalizar_wwwroot` en
        # `app/mod/wwwroot.py`): si cada variante de escritura fuera una fila
        # distinta, la unicidad de acá abajo se esquivaría con una barra final.
        sa.Column("wwwroot", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        # Clave PÚBLICA RSA en PEM, no un secreto ni su hash: Moodle firma el
        # lanzamiento con su privada (RS256) y acá sólo se verifica. Se guarda
        # tal cual porque no es secreta -- ver el docstring de `MoodleSite`.
        sa.Column("public_key", sa.String(), nullable=False),
        sa.Column("ws_token", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("wwwroot", name="uq_mod_site"),
    )
    # El índice va aparte y no como `index=True` dentro del `sa.Column`: así el
    # nombre queda fijado acá y coincide con el que genera `create_all` para el
    # mismo modelo (`ix_<tabla>_<columna>`) -- si divergieran, una base nueva y
    # una migrada tendrían índices con nombres distintos sobre la misma columna.
    op.create_index(_IX_ORG, "mod_sites", ["org_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "mod_sites" not in set(insp.get_table_names()):
        return
    if _IX_ORG in {i["name"] for i in insp.get_indexes("mod_sites")}:
        op.drop_index(_IX_ORG, table_name="mod_sites")
    op.drop_table("mod_sites")
