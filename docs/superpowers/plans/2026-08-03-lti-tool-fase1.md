# Fase 1 — LTI 1.3 Tool en Encuestum: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Encuestum funcione como herramienta LTI 1.3 Advantage, de modo que un Moodle
pueda lanzar una encuesta, identificar al alumno y recibir la nota de la corrección con IA
en su libro de calificaciones — sin escribir todavía nada de PHP.

**Architecture:** Un paquete nuevo `backend/app/lti/` con la lógica del protocolo (claves,
validación de JWT, servicios AGS y deep linking) y un router `backend/app/routers/lti.py`
que expone los endpoints bajo `/lti`. El lanzamiento termina sembrando una cookie firmada
de corta vida (`enc_lti`) que los endpoints públicos ya existentes reconocen para saltear
`access_mode` y atribuir la respuesta a un alumno de Moodle. La nota se devuelve por AGS
después de que el corrector con IA termina.

**Tech Stack:** Python 3.11+, FastAPI, SQLModel, Alembic, PyJWT + `cryptography` (ya en
`requirements.txt`), httpx, pytest. Docker Compose y Caddy para el entorno de pruebas.

## Global Constraints

- Toda la funcionalidad va detrás de `LTI_ENABLED` (default **apagado**). Con el flag
  apagado, `/lti/*` devuelve 404 y nada del comportamiento actual cambia.
- Firma de JWT: **RS256** exclusivamente. Nunca aceptar `alg: none` ni HMAC en tokens
  entrantes.
- Los claims LTI usan el prefijo `https://purl.imsglobal.org/spec/lti/claim/`.
- Cookies del flujo LTI: `SameSite=None; Secure; HttpOnly`. Requieren HTTPS.
- Comentarios y docstrings en español, como el resto de `backend/app/`.
- Migraciones Alembic **idempotentes** (patrón de `backend/alembic/versions/0018_survey_report.py`:
  inspeccionar antes de crear).
- Nunca poner email ni nombre del alumno en query strings. El traspaso de identidad va por
  cookie firmada.
- **Ruteo:** `/lti/*` pertenece entero al backend. `nginx.conf` hoy manda todo lo que no
  sea `/api/`, `/assets/`, `/docs` ni `/openapi.json` al frontend, así que hay que agregar
  una `location /lti/`. Por eso el selector del docente vive en `/lti-select` (frontend) y
  no en `/lti/select`: evita que las dos superficies se pisen.
- **Anti-replay:** el `nonce` viaja dentro del `state` firmado, que a su vez va en una
  cookie borrada al consumirse el lanzamiento. No hace falta almacenamiento en Redis: un
  replay solo sería posible desde el mismo navegador y dentro de los 10 minutos del TTL.
- Cada tarea termina con `pytest` verde y un commit.

---

### Task 1: Configuración, modelos y migración

**Files:**
- Modify: `backend/app/config.py` (al final del `__init__`, junto al resto de flags)
- Modify: `backend/app/models.py` (al final del archivo)
- Create: `backend/alembic/versions/0019_lti.py`
- Test: `backend/tests/test_lti_models.py`

**Interfaces:**
- Consumes: nada.
- Produces: `Settings.lti_enabled: bool`, `Settings.lti_private_key: str | None`,
  `Settings.lti_key_id: str`. Modelos `LtiPlatform`, `LtiResourceLink`, `LtiUser`, y las
  columnas `SurveyResponse.lti_link_id: uuid.UUID | None` y
  `SurveyResponse.lti_sub: str | None`.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_models.py`:

```python
"""Modelos LTI: que existan, que se persistan y que la respuesta se pueda atribuir."""

import uuid

import pytest
from sqlmodel import select

from app.db import async_session
from app.models import LtiPlatform, LtiResourceLink, LtiUser, Survey, SurveyResponse


@pytest.mark.asyncio
async def test_lti_platform_roundtrip():
    async with async_session() as session:
        p = LtiPlatform(
            issuer="https://moodle.localhost",
            client_id="abc123",
            deployment_ids=["1"],
            auth_login_url="https://moodle.localhost/mod/lti/auth.php",
            auth_token_url="https://moodle.localhost/mod/lti/token.php",
            jwks_url="https://moodle.localhost/mod/lti/certs.php",
            org_id=None,
        )
        session.add(p)
        await session.commit()

        got = (
            await session.scalars(
                select(LtiPlatform).where(LtiPlatform.issuer == "https://moodle.localhost")
            )
        ).first()
        assert got is not None
        assert got.client_id == "abc123"
        assert got.deployment_ids == ["1"]


@pytest.mark.asyncio
async def test_response_carries_lti_attribution():
    async with async_session() as session:
        org_id = uuid.uuid4()
        # La respuesta guarda a qué resource link y a qué sub de Moodle pertenece.
        r = SurveyResponse(
            survey_id=uuid.uuid4(),
            answers={},
            lti_link_id=uuid.uuid4(),
            lti_sub="moodle-user-42",
        )
        assert r.lti_sub == "moodle-user-42"
        assert r.lti_link_id is not None
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_models.py -v`
Expected: FAIL con `ImportError: cannot import name 'LtiPlatform' from 'app.models'`

- [ ] **Step 3: Agregar los flags de configuración**

En `backend/app/config.py`, dentro de `Settings.__init__`, después del bloque de
`allow_private_outbound`:

```python
        # ── LTI 1.3 (integración con LMS: Moodle, Canvas, Blackboard…) ────────
        # Apagado por defecto: con LTI_ENABLED=0 los endpoints /lti/* no existen
        # y nada del comportamiento actual cambia.
        self.lti_enabled = _bool("LTI_ENABLED", False)
        # Clave privada RSA (PEM) con la que el tool firma sus JWT: la respuesta
        # de deep linking y el client_assertion para pedir el token de AGS. Si no
        # se define, se genera una al arrancar y se guarda en la base.
        self.lti_private_key = (os.getenv("LTI_PRIVATE_KEY") or "").strip() or None
        # kid publicado en el JWKS. Cambiarlo obliga a las plataformas a releer.
        self.lti_key_id = (os.getenv("LTI_KEY_ID") or "encuestum-lti-1").strip()
```

- [ ] **Step 4: Agregar los modelos**

Al final de `backend/app/models.py`:

```python
# ── LTI 1.3 (Encuestum como herramienta de un LMS) ───────────────────────────


class LtiPlatform(SQLModel, table=True):
    """Un LMS registrado (típicamente un Moodle). En el modelo self-hosted suele
    haber una sola fila, pero el protocolo obliga a soportar varias."""

    __tablename__ = "lti_platforms"
    __table_args__ = (
        UniqueConstraint("issuer", "client_id", name="uq_lti_platform_issuer_client"),
    )

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    issuer: str = Field(sa_column=Column(String, index=True, nullable=False))
    client_id: str = Field(sa_column=Column(String, nullable=False))
    # Un mismo LMS puede desplegar la herramienta varias veces.
    deployment_ids: list = Field(sa_column=Column(JSON, nullable=False), default_factory=list)
    auth_login_url: str = Field(sa_column=Column(String, nullable=False))
    auth_token_url: str = Field(sa_column=Column(String, nullable=False))
    jwks_url: str = Field(sa_column=Column(String, nullable=False))
    # Organización de Encuestum a la que pertenecen las encuestas de este LMS.
    org_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True),
        default=None,
    )
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class LtiResourceLink(SQLModel, table=True):
    """La atadura entre una actividad concreta de un curso y una encuesta."""

    __tablename__ = "lti_resource_links"
    __table_args__ = (
        UniqueConstraint("platform_id", "resource_link_id", name="uq_lti_link"),
    )

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    platform_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("lti_platforms.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    resource_link_id: str = Field(sa_column=Column(String, nullable=False))
    context_id: Optional[str] = Field(sa_column=Column(String), default=None)
    survey_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("surveys.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    # Endpoint AGS donde se publica la nota. Null = la actividad no lleva nota.
    lineitem_url: Optional[str] = Field(sa_column=Column(String), default=None)
    lineitems_url: Optional[str] = Field(sa_column=Column(String), default=None)
    # Escala del libro de calificaciones del LMS (no la de la rúbrica).
    max_score: Optional[float] = Field(sa_column=Column(Float), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class LtiUser(SQLModel, table=True):
    """Un usuario del LMS. `sub` es el identificador estable que manda la
    plataforma; es único dentro de la plataforma, no globalmente."""

    __tablename__ = "lti_users"
    __table_args__ = (UniqueConstraint("platform_id", "sub", name="uq_lti_user"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    platform_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("lti_platforms.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    sub: str = Field(sa_column=Column(String, nullable=False, index=True))
    email: Optional[str] = Field(sa_column=Column(String), default=None)
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    roles: list = Field(sa_column=Column(JSON, nullable=False), default_factory=list)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class LtiKey(SQLModel, table=True):
    """Par de claves RSA del tool, generado al arrancar si no vino por entorno."""

    __tablename__ = "lti_keys"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    kid: str = Field(sa_column=Column(String, unique=True, nullable=False))
    private_pem: str = Field(sa_column=Column(String, nullable=False))
    public_pem: str = Field(sa_column=Column(String, nullable=False))
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )
```

Y en la clase `SurveyResponse`, justo antes del bloque `# Grading`, agregar:

```python
    # Atribución LTI: de qué actividad de qué LMS vino esta respuesta.
    lti_link_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("lti_resource_links.id", ondelete="SET NULL"), index=True),
        default=None,
    )
    lti_sub: Optional[str] = Field(sa_column=Column(String, index=True), default=None)
```

- [ ] **Step 5: Escribir la migración**

Crear `backend/alembic/versions/0019_lti.py`:

```python
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


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

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
```

- [ ] **Step 6: Correr los tests y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_models.py -v`
Expected: PASS, 2 tests.

- [ ] **Step 7: Correr la suite completa para descartar regresiones**

Run: `cd backend && python -m pytest -q`
Expected: todos los tests que pasaban antes siguen pasando.

- [ ] **Step 8: Commit**

```bash
git add backend/app/config.py backend/app/models.py backend/alembic/versions/0019_lti.py backend/tests/test_lti_models.py
git commit -m "feat(lti): modelos, configuración y migración para LTI 1.3"
```

---

### Task 2: Claves RSA del tool y endpoint JWKS

**Files:**
- Create: `backend/app/lti/__init__.py`
- Create: `backend/app/lti/keys.py`
- Create: `backend/app/routers/lti.py`
- Modify: `backend/app/main.py:16-19` (import) y `:119-136` (include_router)
- Modify: `nginx.conf` (nueva `location /lti/`)
- Test: `backend/tests/test_lti_jwks.py`

**Interfaces:**
- Consumes: `Settings.lti_enabled`, `Settings.lti_private_key`, `Settings.lti_key_id`,
  modelo `LtiKey` de la Task 1.
- Produces:
  - `app.lti.keys.get_tool_key(session) -> ToolKey` — dataclass con
    `kid: str`, `private_pem: str`, `public_pem: str`.
  - `app.lti.keys.public_jwk(key: ToolKey) -> dict` — el JWK RSA público.
  - `app.lti.keys.sign(payload: dict, key: ToolKey) -> str` — JWT RS256 con `kid` en el header.
  - Router `app.routers.lti.router` con prefijo `/lti`.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_jwks.py`:

```python
"""JWKS del tool: se publica una clave RSA usable y estable entre llamadas."""

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_jwks_404_cuando_lti_esta_apagado(monkeypatch):
    # conftest no enciende LTI, así que el default vale: apagado.
    r = client.get("/lti/jwks.json")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_jwks_publica_una_clave_rsa(lti_on):
    r = client.get("/lti/jwks.json")
    assert r.status_code == 200
    keys = r.json()["keys"]
    assert len(keys) == 1
    k = keys[0]
    assert k["kty"] == "RSA"
    assert k["alg"] == "RS256"
    assert k["use"] == "sig"
    assert k["kid"]
    assert k["n"] and k["e"]


@pytest.mark.asyncio
async def test_la_clave_es_estable_entre_llamadas(lti_on):
    a = client.get("/lti/jwks.json").json()["keys"][0]
    b = client.get("/lti/jwks.json").json()["keys"][0]
    assert a["kid"] == b["kid"]
    assert a["n"] == b["n"]


@pytest.mark.asyncio
async def test_se_puede_verificar_un_jwt_firmado_por_el_tool(lti_on):
    from app.db import async_session
    from app.lti.keys import get_tool_key, sign

    async with async_session() as session:
        key = await get_tool_key(session)
    token = sign({"iss": "encuestum", "sub": "x"}, key)

    jwks = client.get("/lti/jwks.json").json()
    pub = jwt.PyJWKClient  # noqa: F841 — verificamos a mano contra el JWK publicado
    from jwt.algorithms import RSAAlgorithm

    public_key = RSAAlgorithm.from_jwk(jwks["keys"][0])
    claims = jwt.decode(token, public_key, algorithms=["RS256"], options={"verify_aud": False})
    assert claims["sub"] == "x"
```

Agregar al final de `backend/tests/conftest.py` la fixture que enciende LTI:

```python
@pytest.fixture
def lti_on(monkeypatch):
    """Enciende LTI para un test. get_settings está cacheado con lru_cache, así
    que hay que limpiarlo antes y después."""
    from app.config import get_settings

    monkeypatch.setenv("LTI_ENABLED", "true")
    get_settings.cache_clear()
    yield
    monkeypatch.delenv("LTI_ENABLED", raising=False)
    get_settings.cache_clear()
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_jwks.py -v`
Expected: FAIL — los tests con `lti_on` dan 404 porque el router todavía no existe.

- [ ] **Step 3: Implementar el manejo de claves**

Crear `backend/app/lti/__init__.py` vacío (con un docstring):

```python
"""Implementación de LTI 1.3 Advantage: Encuestum como herramienta de un LMS."""
```

Crear `backend/app/lti/keys.py`:

```python
"""Par de claves RSA del tool.

El tool firma dos cosas: la respuesta de deep linking y el `client_assertion` con
el que pide el token de AGS. La clave puede venir por entorno (`LTI_PRIVATE_KEY`)
o generarse al primer uso y guardarse en la base, para que sobreviva reinicios.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.models import LtiKey


@dataclass(frozen=True)
class ToolKey:
    kid: str
    private_pem: str
    public_pem: str


def _generate() -> tuple[str, str]:
    """Devuelve (private_pem, public_pem) de un par RSA 2048 nuevo."""
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        private.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


async def get_tool_key(session: AsyncSession) -> ToolKey:
    """La clave del tool. Si `LTI_PRIVATE_KEY` está definida, manda esa; si no,
    se lee de la base y se crea la primera vez."""
    s = get_settings()
    if s.lti_private_key:
        private = serialization.load_pem_private_key(
            s.lti_private_key.encode(), password=None
        )
        public_pem = (
            private.public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode()
        )
        return ToolKey(kid=s.lti_key_id, private_pem=s.lti_private_key, public_pem=public_pem)

    row = (await session.scalars(select(LtiKey).where(LtiKey.kid == s.lti_key_id))).first()
    if row is None:
        private_pem, public_pem = _generate()
        row = LtiKey(kid=s.lti_key_id, private_pem=private_pem, public_pem=public_pem)
        session.add(row)
        await session.commit()
    return ToolKey(kid=row.kid, private_pem=row.private_pem, public_pem=row.public_pem)


def _b64u(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def public_jwk(key: ToolKey) -> dict:
    """El JWK público, en la forma que espera la plataforma."""
    public = serialization.load_pem_public_key(key.public_pem.encode())
    numbers = public.public_numbers()
    return {
        "kty": "RSA",
        "alg": "RS256",
        "use": "sig",
        "kid": key.kid,
        "n": _b64u(numbers.n),
        "e": _b64u(numbers.e),
    }


def sign(payload: dict, key: ToolKey) -> str:
    """Firma un JWT RS256 poniendo el `kid` en el header, que es como la
    plataforma sabe con cuál de nuestras claves verificar."""
    return jwt.encode(payload, key.private_pem, algorithm="RS256", headers={"kid": key.kid})
```

- [ ] **Step 4: Crear el router con el endpoint JWKS**

Crear `backend/app/routers/lti.py`:

```python
"""Endpoints LTI 1.3. Todo el router vive detrás de LTI_ENABLED."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.lti.keys import get_tool_key, public_jwk

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/lti", tags=["lti"])


def require_lti() -> None:
    """Con LTI apagado, la superficie entera no existe: 404, no 403, para no
    revelar que el endpoint está ahí."""
    if not get_settings().lti_enabled:
        raise HTTPException(status_code=404, detail="Not Found")


@router.get("/jwks.json", dependencies=[Depends(require_lti)])
async def jwks(session: AsyncSession = Depends(get_session)) -> dict:
    """Claves públicas del tool, para que la plataforma verifique lo que firmamos."""
    key = await get_tool_key(session)
    return {"keys": [public_jwk(key)]}
```

- [ ] **Step 5: Registrar el router**

En `backend/app/main.py`, agregar `lti` a la lista de imports de la línea 16-19:

```python
from app.routers import (
    admin, ai, assets, auth, evaluation, files, lti, orgs, panel, public, uploads,
    webhooks_api,
)
```

Y después de `app.include_router(files.router)` (línea 131), agregar:

```python
# LTI 1.3: sin prefijo de versión — las URLs las guarda el LMS y deben ser estables.
app.include_router(lti.router)
```

En `nginx.conf`, agregar una `location /lti/` **antes** del bloque `location /`, porque
si no todo `/lti/*` termina en Next.js:

```nginx
    # LTI 1.3 (routers/lti.py). Va sin /api/ a propósito: son URLs que el LMS
    # guarda al registrarse y tienen que quedar estables.
    location /lti/ {
      proxy_pass http://127.0.0.1:8000;
      proxy_set_header Host $http_host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
```

- [ ] **Step 6: Correr los tests y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_jwks.py -v`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add backend/app/lti/ backend/app/routers/lti.py backend/app/main.py nginx.conf backend/tests/test_lti_jwks.py backend/tests/conftest.py
git commit -m "feat(lti): claves RSA del tool y endpoint JWKS"
```

---

### Task 3: Validación del id_token de la plataforma

**Files:**
- Create: `backend/app/lti/validate.py`
- Test: `backend/tests/test_lti_validate.py`

**Interfaces:**
- Consumes: modelo `LtiPlatform` (Task 1).
- Produces:
  - `app.lti.validate.CLAIM` — dict con los nombres de claim usados
    (`MESSAGE_TYPE`, `VERSION`, `DEPLOYMENT_ID`, `TARGET_LINK_URI`, `RESOURCE_LINK`,
    `CONTEXT`, `ROLES`, `AGS`, `DEEP_LINKING_SETTINGS`, `DL_CONTENT_ITEMS`).
  - `app.lti.validate.LtiValidationError(Exception)`.
  - `app.lti.validate.fetch_jwks(url: str) -> list[dict]` — con caché de una hora.
  - `app.lti.validate.validate_launch(token: str, platform: LtiPlatform, expected_nonce: str | None) -> dict`
    — devuelve los claims verificados o levanta `LtiValidationError`.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_validate.py`:

```python
"""Validación del id_token: firma, claims obligatorios, deployment y nonce."""

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.lti.validate import CLAIM, LtiValidationError, validate_launch
from app.models import LtiPlatform

ISSUER = "https://moodle.localhost"
CLIENT_ID = "abc123"


@pytest.fixture
def platform_key():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return pem


@pytest.fixture
def platform():
    return LtiPlatform(
        id=uuid.uuid4(),
        issuer=ISSUER,
        client_id=CLIENT_ID,
        deployment_ids=["1"],
        auth_login_url=f"{ISSUER}/mod/lti/auth.php",
        auth_token_url=f"{ISSUER}/mod/lti/token.php",
        jwks_url=f"{ISSUER}/mod/lti/certs.php",
    )


def _launch_claims(**over):
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "sub": "moodle-user-42",
        "exp": now + 300,
        "iat": now,
        "nonce": "n-1",
        CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: "1",
        CLAIM["TARGET_LINK_URI"]: "https://encuestum.localhost/lti/launch",
        CLAIM["RESOURCE_LINK"]: {"id": "rl-7"},
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    }
    claims.update(over)
    return claims


def _sign(claims, pem):
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "platform-key"})


def _patch_jwks(monkeypatch, pem):
    """Sustituye la descarga del JWKS por la clave pública local."""
    public = serialization.load_pem_private_key(pem.encode(), password=None).public_key()

    async def fake(url):
        from jwt.algorithms import RSAAlgorithm
        import json

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "platform-key"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake)


@pytest.mark.asyncio
async def test_launch_valido_devuelve_los_claims(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(), platform_key)
    claims = await validate_launch(token, platform, expected_nonce="n-1")
    assert claims["sub"] == "moodle-user-42"
    assert claims[CLAIM["RESOURCE_LINK"]]["id"] == "rl-7"


@pytest.mark.asyncio
async def test_rechaza_firma_de_otra_clave(monkeypatch, platform_key, platform):
    otra = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(), otra)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_nonce_distinto(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(nonce="otro"), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_deployment_desconocido(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(**{CLAIM["DEPLOYMENT_ID"]: "99"}), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_version_incorrecta(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(**{CLAIM["VERSION"]: "1.1.0"}), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_token_vencido(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    now = int(time.time())
    token = _sign(_launch_claims(exp=now - 10, iat=now - 400), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_alg_none(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = jwt.encode(_launch_claims(), key="", algorithm="none")
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_validate.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'app.lti.validate'`

- [ ] **Step 3: Implementar la validación**

Crear `backend/app/lti/validate.py`:

```python
"""Validación del `id_token` que manda la plataforma en cada lanzamiento.

Sigue el mismo enfoque que `app/lockatus_client.py`: verificación RS256 offline
contra el JWKS de la contraparte, con caché de una hora.
"""

from __future__ import annotations

import logging
import time

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from app.models import LtiPlatform

LOGGER = logging.getLogger(__name__)

_BASE = "https://purl.imsglobal.org/spec/lti/claim/"
_DL = "https://purl.imsglobal.org/spec/lti-dl/claim/"

CLAIM = {
    "MESSAGE_TYPE": _BASE + "message_type",
    "VERSION": _BASE + "version",
    "DEPLOYMENT_ID": _BASE + "deployment_id",
    "TARGET_LINK_URI": _BASE + "target_link_uri",
    "RESOURCE_LINK": _BASE + "resource_link",
    "CONTEXT": _BASE + "context",
    "ROLES": _BASE + "roles",
    "LAUNCH_PRESENTATION": _BASE + "launch_presentation",
    "CUSTOM": _BASE + "custom",
    "AGS": "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
    "DEEP_LINKING_SETTINGS": _DL + "deep_linking_settings",
    "DL_CONTENT_ITEMS": _DL + "content_items",
    "DL_DATA": _DL + "data",
}

MESSAGE_RESOURCE_LINK = "LtiResourceLinkRequest"
MESSAGE_DEEP_LINKING = "LtiDeepLinkingRequest"

_JWKS_TTL_S = 3600
_jwks_cache: dict[str, tuple[float, list[dict]]] = {}


class LtiValidationError(Exception):
    """El lanzamiento no es de fiar. Nunca exponer el detalle al navegador."""


async def fetch_jwks(url: str) -> list[dict]:
    """Claves públicas de la plataforma, cacheadas una hora."""
    hit = _jwks_cache.get(url)
    if hit and time.time() - hit[0] < _JWKS_TTL_S:
        return hit[1]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
    resp.raise_for_status()
    keys = resp.json().get("keys", [])
    _jwks_cache[url] = (time.time(), keys)
    return keys


def _key_for(keys: list[dict], kid: str | None):
    """La clave cuyo kid coincide; si el token no trae kid y hay una sola, esa."""
    if kid:
        for k in keys:
            if k.get("kid") == kid:
                return RSAAlgorithm.from_jwk(k)
        return None
    if len(keys) == 1:
        return RSAAlgorithm.from_jwk(keys[0])
    return None


async def validate_launch(
    token: str, platform: LtiPlatform, expected_nonce: str | None
) -> dict:
    """Verifica firma y claims obligatorios. Devuelve los claims o levanta."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise LtiValidationError(f"header ilegible: {exc}") from exc

    if header.get("alg") != "RS256":
        raise LtiValidationError(f"alg no permitido: {header.get('alg')!r}")

    try:
        keys = await fetch_jwks(platform.jwks_url)
    except Exception as exc:  # noqa: BLE001 — la red puede fallar de mil formas
        raise LtiValidationError(f"no se pudo leer el JWKS: {exc}") from exc

    key = _key_for(keys, header.get("kid"))
    if key is None:
        raise LtiValidationError("ninguna clave del JWKS coincide con el kid del token")

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=platform.client_id,
            issuer=platform.issuer,
            options={"require": ["iss", "aud", "sub", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
        raise LtiValidationError(f"token inválido: {exc}") from exc

    if expected_nonce is not None and claims.get("nonce") != expected_nonce:
        raise LtiValidationError("nonce no coincide")

    if claims.get(CLAIM["VERSION"]) != "1.3.0":
        raise LtiValidationError(f"versión LTI no soportada: {claims.get(CLAIM['VERSION'])!r}")

    deployment_id = claims.get(CLAIM["DEPLOYMENT_ID"])
    if deployment_id not in (platform.deployment_ids or []):
        raise LtiValidationError(f"deployment_id desconocido: {deployment_id!r}")

    message_type = claims.get(CLAIM["MESSAGE_TYPE"])
    if message_type not in (MESSAGE_RESOURCE_LINK, MESSAGE_DEEP_LINKING):
        raise LtiValidationError(f"message_type no soportado: {message_type!r}")

    return claims
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_validate.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/app/lti/validate.py backend/tests/test_lti_validate.py
git commit -m "feat(lti): validación del id_token contra el JWKS de la plataforma"
```

---

### Task 4: OIDC login init, lanzamiento y traspaso de identidad

**Files:**
- Create: `backend/app/lti/state.py`
- Modify: `backend/app/routers/lti.py` (agregar `/login` y `/launch`)
- Modify: `backend/app/routers/public.py:151-158` (`get_public_survey`) y `:243-275` (`submit`)
- Test: `backend/tests/test_lti_launch.py`

**Interfaces:**
- Consumes: `validate_launch`, `CLAIM`, `MESSAGE_RESOURCE_LINK` (Task 3);
  `LtiPlatform`, `LtiResourceLink`, `LtiUser` (Task 1).
- Produces:
  - `app.lti.state.new_state() -> tuple[str, str]` — devuelve `(state, nonce)`.
  - `app.lti.state.LTI_STATE_COOKIE = "enc_lti_state"`, `app.lti.state.LTI_COOKIE = "enc_lti"`.
  - `app.lti.state.LTI_PURPOSE = "lti_access"`.
  - En `public.py`: `_lti_context(request, survey) -> dict | None` — devuelve
    `{"link_id": str, "sub": str, "email": str | None, "name": str | None}` o `None`.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_launch.py`:

```python
"""Flujo de lanzamiento: login init, launch, y acceso a la encuesta sin PIN."""

import time
import uuid
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.db import async_session
from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, LtiResourceLink, Survey

ISSUER = "https://moodle.test"
CLIENT_ID = "cid-1"


@pytest.fixture
def platform_pem():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


@pytest.fixture
async def registered(platform_pem, monkeypatch):
    """Deja en la base una plataforma, una encuesta con PIN y su resource link."""
    public = serialization.load_pem_private_key(platform_pem.encode(), password=None).public_key()

    async def fake_jwks(url):
        import json

        from jwt.algorithms import RSAAlgorithm

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "pk"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake_jwks)

    async with async_session() as session:
        org_id = uuid.uuid4()
        survey = Survey(org_id=org_id, title="Examen", status="published", access_mode="pin",
                        access_pin="1234", json_schema={"pages": []})
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER}/mod/lti/token.php",
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        link = LtiResourceLink(platform_id=platform.id, resource_link_id="rl-1",
                               context_id="course-9", survey_id=survey.id)
        session.add(link)
        await session.commit()
        return {"platform": platform, "survey": survey, "link": link, "pem": platform_pem}


def _id_token(pem, nonce, **over):
    now = int(time.time())
    claims = {
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "u-42", "exp": now + 300, "iat": now,
        "nonce": nonce, "email": "alumno@escuela.test", "name": "Ana Alumna",
        CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: "1",
        CLAIM["TARGET_LINK_URI"]: "https://encuestum.test/lti/launch",
        CLAIM["RESOURCE_LINK"]: {"id": "rl-1"},
        CLAIM["CONTEXT"]: {"id": "course-9", "title": "Historia"},
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    }
    claims.update(over)
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "pk"})


@pytest.mark.asyncio
async def test_login_redirige_al_authorize_de_la_plataforma(lti_on, registered):
    client = TestClient(app)
    r = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["response_type"] == ["id_token"]
    assert q["response_mode"] == ["form_post"]
    assert q["scope"] == ["openid"]
    assert q["client_id"] == [CLIENT_ID]
    assert q["login_hint"] == ["42"]
    assert q["state"] and q["nonce"]
    assert "enc_lti_state" in r.cookies


@pytest.mark.asyncio
async def test_launch_valido_redirige_a_la_encuesta_y_siembra_la_cookie(lti_on, registered):
    client = TestClient(app)
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post(
        "/lti/launch",
        data={"id_token": token, "state": q["state"][0]},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"] == f"/s/{registered['survey'].slug}"
    assert "enc_lti" in r.cookies


@pytest.mark.asyncio
async def test_launch_con_state_ajeno_es_rechazado(lti_on, registered):
    client = TestClient(app)
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post("/lti/launch", data={"id_token": token, "state": "otro-state"},
                    follow_redirects=False)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_la_cookie_lti_saltea_el_pin_de_la_encuesta(lti_on, registered):
    client = TestClient(app)
    slug = registered["survey"].slug

    # Sin cookie LTI, la encuesta con PIN no entrega su contenido: viene gated.
    sin = TestClient(app).get(f"/api/v1/survey/public/{slug}")
    assert sin.json()["gated"] is True

    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)

    # Con la cookie puesta, se puede enviar sin access_token.
    r = client.post(f"/api/v1/survey/public/{slug}/submit",
                    json={"answers": {"q1": "hola"}, "completed": True})
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_la_respuesta_queda_atribuida_al_alumno(lti_on, registered):
    from sqlmodel import select

    from app.models import SurveyResponse

    client = TestClient(app)
    slug = registered["survey"].slug
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)
    client.post(f"/api/v1/survey/public/{slug}/submit",
                json={"answers": {"q1": "hola"}, "completed": True})

    async with async_session() as session:
        r = (await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == registered["survey"].id)
        )).first()
        assert r.lti_sub == "u-42"
        assert r.lti_link_id == registered["link"].id
        assert r.respondent_email == "alumno@escuela.test"
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_launch.py -v`
Expected: FAIL — `/lti/login` devuelve 404 (el endpoint no existe todavía).

- [ ] **Step 3: Implementar el manejo de state y nonce**

Crear `backend/app/lti/state.py`:

```python
"""State y nonce del flujo OIDC, y la cookie que traspasa la identidad.

El `state` va en una cookie de vida corta y se compara contra el que devuelve la
plataforma: es lo que impide que alguien monte un lanzamiento desde otro lado.
El `nonce` viaja dentro del state firmado, así no hace falta almacenamiento.
"""

from __future__ import annotations

import secrets

LTI_STATE_COOKIE = "enc_lti_state"
LTI_COOKIE = "enc_lti"
LTI_STATE_PURPOSE = "lti_state"
LTI_PURPOSE = "lti_access"

# El lanzamiento debe consumirse enseguida; el acceso dura lo que la clase.
STATE_TTL_S = 600
ACCESS_TTL_S = 4 * 3600


def new_state() -> tuple[str, str]:
    """Un par (state, nonce) nuevo, ambos impredecibles."""
    return secrets.token_urlsafe(24), secrets.token_urlsafe(24)
```

Verificar que `backend/app/security.py` expone `create_purpose_token(purpose, data, ttl_s)`
y `read_purpose_token(purpose, token)`. Si la firma difiere, adaptar las llamadas de abajo
a la que exista — es el mismo mecanismo que usa `_ACCESS_PURPOSE` en `public.py`.

- [ ] **Step 4: Implementar `/lti/login` y `/lti/launch`**

Agregar a `backend/app/routers/lti.py` (después del endpoint `jwks`):

```python
from urllib.parse import urlencode

from fastapi import Form, Request
from sqlmodel import select
from starlette.responses import RedirectResponse

from app.lti.state import (
    ACCESS_TTL_S,
    LTI_COOKIE,
    LTI_PURPOSE,
    LTI_STATE_COOKIE,
    LTI_STATE_PURPOSE,
    STATE_TTL_S,
    new_state,
)
from app.lti.validate import (
    CLAIM,
    MESSAGE_DEEP_LINKING,
    MESSAGE_RESOURCE_LINK,
    LtiValidationError,
    validate_launch,
)
from app.models import LtiPlatform, LtiResourceLink, LtiUser
from app.security import create_purpose_token, read_purpose_token


def _lti_cookie_kwargs() -> dict:
    """Las cookies del flujo LTI viajan dentro de un iframe de otro dominio:
    sin SameSite=None; Secure el navegador las descarta."""
    return {"httponly": True, "secure": True, "samesite": "none", "path": "/"}


async def _platform_for(session: AsyncSession, issuer: str, client_id: str | None) -> LtiPlatform:
    q = select(LtiPlatform).where(LtiPlatform.issuer == issuer)
    if client_id:
        q = q.where(LtiPlatform.client_id == client_id)
    platform = (await session.scalars(q)).first()
    if platform is None:
        raise HTTPException(status_code=400, detail="Plataforma LTI no registrada.")
    return platform


@router.api_route("/login", methods=["GET", "POST"], dependencies=[Depends(require_lti)])
async def login(request: Request, session: AsyncSession = Depends(get_session)):
    """OIDC third-party initiated login: la plataforma nos avisa que viene un
    lanzamiento y nosotros la mandamos a su propio authorize."""
    params = dict(request.query_params)
    if request.method == "POST":
        params.update({k: str(v) for k, v in (await request.form()).items()})

    issuer = (params.get("iss") or "").strip()
    if not issuer:
        raise HTTPException(status_code=400, detail="Falta iss.")
    platform = await _platform_for(session, issuer, (params.get("client_id") or "").strip() or None)

    state, nonce = new_state()
    target = params.get("target_link_uri") or str(request.url_for("launch"))
    query = {
        "scope": "openid",
        "response_type": "id_token",
        "response_mode": "form_post",
        "prompt": "none",
        "client_id": platform.client_id,
        "redirect_uri": target,
        "state": state,
        "nonce": nonce,
    }
    if params.get("login_hint"):
        query["login_hint"] = params["login_hint"]
    if params.get("lti_message_hint"):
        query["lti_message_hint"] = params["lti_message_hint"]

    resp = RedirectResponse(f"{platform.auth_login_url}?{urlencode(query)}", status_code=302)
    resp.set_cookie(
        LTI_STATE_COOKIE,
        create_purpose_token(
            LTI_STATE_PURPOSE,
            {"state": state, "nonce": nonce, "platform_id": str(platform.id)},
            STATE_TTL_S,
        ),
        max_age=STATE_TTL_S,
        **_lti_cookie_kwargs(),
    )
    return resp


@router.post("/launch", name="launch", dependencies=[Depends(require_lti)])
async def launch(
    request: Request,
    id_token: str = Form(...),
    state: str = Form(...),
    session: AsyncSession = Depends(get_session),
):
    """Recibe el id_token firmado, lo valida, y deja al alumno adentro de la encuesta."""
    stored = read_purpose_token(LTI_STATE_PURPOSE, request.cookies.get(LTI_STATE_COOKIE) or "")
    if not stored or stored.get("state") != state:
        raise HTTPException(status_code=400, detail="Lanzamiento LTI inválido o vencido.")

    platform = await session.get(LtiPlatform, uuid.UUID(stored["platform_id"]))
    if platform is None:
        raise HTTPException(status_code=400, detail="Plataforma LTI no registrada.")

    try:
        claims = await validate_launch(id_token, platform, expected_nonce=stored.get("nonce"))
    except LtiValidationError as exc:
        LOGGER.warning("lanzamiento LTI rechazado (%s): %s", platform.issuer, exc)
        raise HTTPException(status_code=400, detail="Lanzamiento LTI inválido.") from exc

    # Alta o actualización del usuario del LMS.
    sub = claims["sub"]
    user = (
        await session.scalars(
            select(LtiUser).where(LtiUser.platform_id == platform.id, LtiUser.sub == sub)
        )
    ).first()
    if user is None:
        user = LtiUser(platform_id=platform.id, sub=sub)
    user.email = claims.get("email")
    user.name = claims.get("name")
    user.roles = claims.get(CLAIM["ROLES"]) or []
    session.add(user)
    await session.commit()

    if claims.get(CLAIM["MESSAGE_TYPE"]) == MESSAGE_DEEP_LINKING:
        return await _deep_linking_redirect(claims, platform, session)

    return await _resource_link_redirect(claims, platform, user, session)


async def _resource_link_redirect(claims, platform, user, session):
    """Lanzamiento normal: buscar la encuesta atada a esta actividad y entrar."""
    resource_link_id = (claims.get(CLAIM["RESOURCE_LINK"]) or {}).get("id")
    if not resource_link_id:
        raise HTTPException(status_code=400, detail="El lanzamiento no trae resource_link.")

    link = (
        await session.scalars(
            select(LtiResourceLink).where(
                LtiResourceLink.platform_id == platform.id,
                LtiResourceLink.resource_link_id == resource_link_id,
            )
        )
    ).first()
    if link is None:
        raise HTTPException(
            status_code=404,
            detail="Esta actividad todavía no tiene una encuesta asignada.",
        )

    # Guardamos los endpoints de notas que vengan en este lanzamiento: pueden
    # cambiar si el docente reconfigura la actividad.
    ags = claims.get(CLAIM["AGS"]) or {}
    if ags.get("lineitem"):
        link.lineitem_url = ags["lineitem"]
    if ags.get("lineitems"):
        link.lineitems_url = ags["lineitems"]
    session.add(link)
    await session.commit()

    survey = await session.get(Survey, link.survey_id)
    if survey is None or survey.deleted_at is not None:
        raise HTTPException(status_code=404, detail="La encuesta ya no existe.")

    token = create_purpose_token(
        LTI_PURPOSE,
        {
            "slug": survey.slug,
            "link_id": str(link.id),
            "sub": user.sub,
            "email": user.email,
            "name": user.name,
        },
        ACCESS_TTL_S,
    )
    resp = RedirectResponse(f"/s/{survey.slug}", status_code=302)
    resp.set_cookie(LTI_COOKIE, token, max_age=ACCESS_TTL_S, **_lti_cookie_kwargs())
    resp.delete_cookie(LTI_STATE_COOKIE, path="/")
    return resp
```

Agregar los imports que faltan al principio de `backend/app/routers/lti.py`:

```python
import uuid

from app.models import Survey
```

`_deep_linking_redirect` se implementa en la Task 5. Por ahora, para que este archivo
importe, agregar el stub que levanta un error claro:

```python
async def _deep_linking_redirect(claims, platform, session):
    raise HTTPException(status_code=501, detail="Deep linking todavía no implementado.")
```

- [ ] **Step 5: Enganchar la cookie LTI en los endpoints públicos**

En `backend/app/routers/public.py`, agregar debajo de `_valid_access` (línea ~57):

```python
def _lti_context(request: Request, s: Survey) -> dict | None:
    """Identidad que trajo un lanzamiento LTI para *esta* encuesta, si la hay.

    Cuando existe, la encuesta ya no pide PIN ni figurar en la lista: quien
    autenticó al alumno fue el LMS."""
    from app.lti.state import LTI_COOKIE, LTI_PURPOSE

    if not get_settings().lti_enabled:
        return None
    data = read_purpose_token(LTI_PURPOSE, request.cookies.get(LTI_COOKIE) or "")
    if not data or data.get("slug") != s.slug:
        return None
    return data
```

En `get_public_survey` (línea 151), agregar el parámetro `request` y desactivar el gate
cuando el lanzamiento LTI ya identificó a quien responde. Reemplazar la función entera por:

```python
@router.get("/{slug}", response_model=PublicSurvey)
async def get_public_survey(
    slug: str,
    request: Request,
    access_token: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    # Si llegó por un lanzamiento LTI, el LMS ya autenticó al alumno: no hay
    # puerta que tocar.
    gated = available and not _valid_access(s, access_token) and not _lti_context(request, s)
    return _public_payload(s, available, reason, gated)
```

En `submit` (línea ~266), reemplazar el bloque de acceso por:

```python
    # Gated surveys require a valid access token; capture respondent identity.
    resp_email = resp_code = None
    lti = _lti_context(request, s)
    if lti:
        resp_email = lti.get("email")
    elif getattr(s, "access_mode", "public") != "public":
        if not _valid_access(s, payload.access_token):
            raise HTTPException(status_code=403, detail="Necesitás acceso para responder esta encuesta.")
        data = read_purpose_token(_ACCESS_PURPOSE, payload.access_token or "") or {}
        resp_email, resp_code = data.get("email"), data.get("code")

    r = SurveyResponse(
        survey_id=s.id, answers=payload.answers or {}, completed=payload.completed, meta=payload.meta,
        respondent_email=resp_email, respondent_code=resp_code,
        lti_link_id=uuid.UUID(lti["link_id"]) if lti else None,
        lti_sub=lti.get("sub") if lti else None,
    )
```

Agregar `import uuid` al principio de `backend/app/routers/public.py`.

- [ ] **Step 6: Correr los tests y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_launch.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 7: Correr la suite completa**

Run: `cd backend && python -m pytest -q`
Expected: sin regresiones. En particular `tests/test_access.py` debe seguir verde: con
LTI apagado, `_lti_context` devuelve `None` y el camino viejo queda intacto.

- [ ] **Step 8: Commit**

```bash
git add backend/app/lti/state.py backend/app/routers/lti.py backend/app/routers/public.py backend/tests/test_lti_launch.py
git commit -m "feat(lti): login OIDC, lanzamiento y traspaso de identidad a la encuesta"
```

---

### Task 5: Deep Linking — selector de encuestas

**Files:**
- Create: `backend/app/lti/deeplink.py`
- Modify: `backend/app/routers/lti.py` (reemplazar el stub y agregar `/select`, `/select/return`)
- Create: `frontend/app/(public)/lti-select/page.tsx`
- Test: `backend/tests/test_lti_deeplink.py`

**Interfaces:**
- Consumes: `get_tool_key`, `sign` (Task 2); `CLAIM`, `MESSAGE_DEEP_LINKING` (Task 3);
  `create_purpose_token` / `read_purpose_token`.
- Produces:
  - `app.lti.deeplink.DL_PURPOSE = "lti_deeplink"`.
  - `app.lti.deeplink.build_response_jwt(*, platform, deployment_id, settings_claim, survey, launch_url, key) -> str`
    — el JWT `LtiDeepLinkingResponse` con un `content_item` de tipo `ltiResourceLink`.
  - `GET /lti/select/surveys?dl=<token>` — lista las encuestas publicadas de la
    organización de esa plataforma. El selector en sí lo sirve Next.js en `/lti-select`.
  - `POST /lti/select/return` — recibe `{"dl": <token>, "survey_id": "<uuid>"}` y devuelve
    `{"action": <deep_link_return_url>, "jwt": <JWT>}` para que el navegador lo auto-postee.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_deeplink.py`:

```python
"""Deep linking: el docente elige una encuesta y el LMS recibe el content item."""

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from app.db import async_session
from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, Survey

ISSUER = "https://moodle.dl"
CLIENT_ID = "cid-dl"
RETURN_URL = f"{ISSUER}/mod/lti/contentitem_return.php"


@pytest.fixture
async def dl_setup(monkeypatch):
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public = serialization.load_pem_private_key(pem.encode(), password=None).public_key()

    async def fake_jwks(url):
        import json

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "pk"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake_jwks)

    async with async_session() as session:
        org_id = uuid.uuid4()
        survey = Survey(org_id=org_id, title="Quiz de prueba", status="published",
                        json_schema={"pages": []})
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER}/mod/lti/token.php",
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        return {"pem": pem, "platform": platform, "survey": survey}


def _dl_token(pem, nonce):
    now = int(time.time())
    return jwt.encode(
        {
            "iss": ISSUER, "aud": CLIENT_ID, "sub": "teacher-1", "exp": now + 300,
            "iat": now, "nonce": nonce,
            CLAIM["MESSAGE_TYPE"]: "LtiDeepLinkingRequest",
            CLAIM["VERSION"]: "1.3.0",
            CLAIM["DEPLOYMENT_ID"]: "1",
            CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
            CLAIM["DEEP_LINKING_SETTINGS"]: {
                "deep_link_return_url": RETURN_URL,
                "accept_types": ["ltiResourceLink"],
                "accept_presentation_document_targets": ["iframe", "window"],
                "data": "opaque-123",
            },
        },
        pem,
        algorithm="RS256",
        headers={"kid": "pk"},
    )


def _launch_deeplink(client, setup):
    from urllib.parse import parse_qs, urlparse

    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "1",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    return client.post(
        "/lti/launch",
        data={"id_token": _dl_token(setup["pem"], q["nonce"][0]), "state": q["state"][0]},
        follow_redirects=False,
    )


@pytest.mark.asyncio
async def test_deep_linking_redirige_al_selector(lti_on, dl_setup):
    client = TestClient(app)
    r = _launch_deeplink(client, dl_setup)
    assert r.status_code == 302
    assert r.headers["location"].startswith("/lti-select?dl=")


@pytest.mark.asyncio
async def test_el_selector_lista_las_encuestas_de_la_organizacion(lti_on, dl_setup):
    client = TestClient(app)
    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]
    listado = client.get(f"/lti/select/surveys?dl={dl}")
    assert listado.status_code == 200
    titles = [s["title"] for s in listado.json()["surveys"]]
    assert "Quiz de prueba" in titles


@pytest.mark.asyncio
async def test_el_retorno_firma_un_content_item_verificable(lti_on, dl_setup):
    client = TestClient(app)
    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]

    ret = client.post("/lti/select/return",
                      json={"dl": dl, "survey_id": str(dl_setup["survey"].id)})
    assert ret.status_code == 200
    body = ret.json()
    assert body["action"] == RETURN_URL

    jwks = client.get("/lti/jwks.json").json()
    public_key = RSAAlgorithm.from_jwk(jwks["keys"][0])
    claims = jwt.decode(body["jwt"], public_key, algorithms=["RS256"], audience=ISSUER)
    assert claims[CLAIM["MESSAGE_TYPE"]] == "LtiDeepLinkingResponse"
    assert claims[CLAIM["DL_DATA"]] == "opaque-123"
    items = claims[CLAIM["DL_CONTENT_ITEMS"]]
    assert len(items) == 1
    assert items[0]["type"] == "ltiResourceLink"
    assert items[0]["title"] == "Quiz de prueba"
    assert str(dl_setup["survey"].id) in items[0]["custom"]["survey_id"]


@pytest.mark.asyncio
async def test_el_retorno_rechaza_una_encuesta_de_otra_organizacion(lti_on, dl_setup):
    client = TestClient(app)
    async with async_session() as session:
        ajena = Survey(org_id=uuid.uuid4(), title="Ajena", status="published", json_schema={})
        session.add(ajena)
        await session.commit()
        ajena_id = ajena.id

    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]
    ret = client.post("/lti/select/return", json={"dl": dl, "survey_id": str(ajena_id)})
    assert ret.status_code == 404
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_deeplink.py -v`
Expected: FAIL — el lanzamiento de deep linking devuelve 501 (el stub de la Task 4).

- [ ] **Step 3: Implementar la construcción de la respuesta**

Crear `backend/app/lti/deeplink.py`:

```python
"""Deep Linking 2.0: el docente elige la encuesta desde adentro del LMS.

La plataforma nos manda un `LtiDeepLinkingRequest` con una URL de retorno. Le
contestamos con un `LtiDeepLinkingResponse` firmado por nosotros, que contiene un
`content_item` describiendo la actividad elegida. Moodle lo guarda y a partir de
ahí lanza esa encuesta.
"""

from __future__ import annotations

import time
import uuid

from app.lti.keys import ToolKey, sign
from app.lti.validate import CLAIM
from app.models import LtiPlatform, Survey

DL_PURPOSE = "lti_deeplink"


def build_response_jwt(
    *,
    platform: LtiPlatform,
    deployment_id: str,
    settings_claim: dict,
    survey: Survey,
    launch_url: str,
    key: ToolKey,
) -> str:
    """El JWT que la plataforma espera de vuelta, con la encuesta elegida."""
    now = int(time.time())
    item = {
        "type": "ltiResourceLink",
        "title": survey.title or "Encuesta",
        "url": launch_url,
        "custom": {"survey_id": str(survey.id), "survey_slug": survey.slug},
        "presentation": {"documentTarget": "iframe"},
    }
    # Si la encuesta es un examen, declaramos la escala para que el LMS cree el
    # ítem del libro de calificaciones al aceptar el content item.
    #
    # Siempre 100: el puntaje máximo real depende de la rúbrica y recién se
    # conoce al corregir (`grade["max"]`), que puede variar entre respuestas si
    # hay preguntas condicionales. Se fija el libro en 100 y `ags._deliver`
    # reescala cada nota antes de publicarla.
    if (survey.evaluation or {}).get("enabled"):
        item["lineItem"] = {
            "scoreMaximum": 100.0,
            "label": survey.title or "Encuesta",
            "resourceId": str(survey.id),
        }

    payload = {
        "iss": platform.client_id,  # en la respuesta, el emisor es el tool
        "aud": platform.issuer,
        "sub": platform.client_id,
        "exp": now + 600,
        "iat": now,
        "nonce": uuid.uuid4().hex,
        CLAIM["MESSAGE_TYPE"]: "LtiDeepLinkingResponse",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: deployment_id,
        CLAIM["DL_CONTENT_ITEMS"]: [item],
    }
    if settings_claim.get("data"):
        payload[CLAIM["DL_DATA"]] = settings_claim["data"]
    return sign(payload, key)
```

- [ ] **Step 4: Reemplazar el stub y agregar los endpoints del selector**

En `backend/app/routers/lti.py`, borrar el stub `_deep_linking_redirect` de la Task 4 y
poner en su lugar:

```python
from pydantic import BaseModel

from app.lti.deeplink import DL_PURPOSE, build_response_jwt


async def _deep_linking_redirect(claims, platform, session):
    """Guardamos el contexto del pedido en un token y mandamos al selector."""
    settings_claim = claims.get(CLAIM["DEEP_LINKING_SETTINGS"]) or {}
    if not settings_claim.get("deep_link_return_url"):
        raise HTTPException(status_code=400, detail="El pedido de deep linking no trae URL de retorno.")

    token = create_purpose_token(
        DL_PURPOSE,
        {
            "platform_id": str(platform.id),
            "deployment_id": claims.get(CLAIM["DEPLOYMENT_ID"]),
            "settings": settings_claim,
        },
        STATE_TTL_S,
    )
    # Ojo con la ruta: el selector lo sirve Next.js en /lti-select, fuera del
    # espacio /lti/ que nginx manda entero al backend.
    resp = RedirectResponse(f"/lti-select?dl={token}", status_code=302)
    resp.delete_cookie(LTI_STATE_COOKIE, path="/")
    return resp


async def _dl_platform(session: AsyncSession, dl: str) -> tuple[LtiPlatform, dict]:
    data = read_purpose_token(DL_PURPOSE, dl or "")
    if not data:
        raise HTTPException(status_code=400, detail="Sesión de deep linking vencida.")
    platform = await session.get(LtiPlatform, uuid.UUID(data["platform_id"]))
    if platform is None:
        raise HTTPException(status_code=400, detail="Plataforma LTI no registrada.")
    return platform, data


@router.get("/select/surveys", dependencies=[Depends(require_lti)])
async def select_surveys(dl: str, session: AsyncSession = Depends(get_session)) -> dict:
    """Encuestas publicadas de la organización atada a esta plataforma."""
    platform, _ = await _dl_platform(session, dl)
    rows = (
        await session.scalars(
            select(Survey)
            .where(
                Survey.org_id == platform.org_id,
                Survey.deleted_at.is_(None),
                Survey.status == "published",
            )
            .order_by(Survey.updated_at.desc())
        )
    ).all()
    return {
        "surveys": [
            {
                "id": str(s.id),
                "title": s.title or "Sin título",
                "slug": s.slug,
                "is_exam": bool((s.evaluation or {}).get("enabled")),
            }
            for s in rows
        ]
    }


class DeepLinkReturn(BaseModel):
    dl: str
    survey_id: uuid.UUID


@router.post("/select/return", dependencies=[Depends(require_lti)])
async def select_return(
    payload: DeepLinkReturn,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Firma el content item de la encuesta elegida y dice a dónde postearlo."""
    platform, data = await _dl_platform(session, payload.dl)

    survey = await session.get(Survey, payload.survey_id)
    if survey is None or survey.deleted_at is not None or survey.org_id != platform.org_id:
        raise HTTPException(status_code=404, detail="Encuesta no encontrada.")

    key = await get_tool_key(session)
    token = build_response_jwt(
        platform=platform,
        deployment_id=data["deployment_id"],
        settings_claim=data["settings"],
        survey=survey,
        launch_url=str(request.url_for("launch")),
        key=key,
    )
    return {"action": data["settings"]["deep_link_return_url"], "jwt": token}
```

- [ ] **Step 5: Correr los tests del backend y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_deeplink.py -v`
Expected: PASS, 4 tests.

- [ ] **Step 6: Crear la página del selector**

Crear `frontend/app/(public)/lti-select/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

type Survey = { id: string; title: string; slug: string; is_exam: boolean };

export default function LtiSelect() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dl = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("dl") ?? "";

  useEffect(() => {
    if (!dl) return;
    fetch(`/lti/select/surveys?dl=${encodeURIComponent(dl)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No se pudieron listar las encuestas."))))
      .then((d) => setSurveys(d.surveys))
      .catch((e) => setError(e.message));
  }, [dl]);

  // El retorno de deep linking es un POST de formulario al LMS: se arma y se envía.
  async function choose(id: string) {
    setBusy(true);
    try {
      const r = await fetch("/lti/select/return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dl, survey_id: id }),
      });
      if (!r.ok) throw new Error("No se pudo confirmar la elección.");
      const { action, jwt } = await r.json();
      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "JWT";
      input.value = jwt;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado.");
      setBusy(false);
    }
  }

  if (error) return <main className="p-8"><p className="text-red-600">{error}</p></main>;

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">Elegí una encuesta</h1>
      {surveys.length === 0 ? (
        <p className="text-neutral-500">No hay encuestas publicadas en esta organización.</p>
      ) : (
        <ul className="space-y-2">
          {surveys.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => choose(s.id)}
                className="w-full rounded-lg border p-4 text-left hover:bg-neutral-50 disabled:opacity-50"
              >
                <span className="font-medium">{s.title}</span>
                {s.is_exam && <span className="ml-2 text-xs text-neutral-500">examen · lleva nota</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 7: Verificar que el frontend compila**

Run: `cd frontend && npm run build`
Expected: build exitoso, sin errores de TypeScript.

- [ ] **Step 8: Commit**

```bash
git add backend/app/lti/deeplink.py backend/app/routers/lti.py backend/tests/test_lti_deeplink.py "frontend/app/(public)/lti-select"
git commit -m "feat(lti): deep linking con selector de encuestas"
```

---

### Task 6: AGS — devolver la nota al libro de calificaciones

**Files:**
- Create: `backend/app/lti/ags.py`
- Modify: `backend/app/routers/public.py` (después del bloque de corrección en `submit`)
- Test: `backend/tests/test_lti_ags.py`

**Interfaces:**
- Consumes: `get_tool_key`, `sign` (Task 2); `LtiPlatform`, `LtiResourceLink` (Task 1).
- Produces:
  - `app.lti.ags.get_access_token(platform, key, scopes) -> str`.
  - `app.lti.ags.ensure_lineitem(platform, link, key, *, label, score_maximum) -> str`
    — devuelve la URL del line item, creándolo si hace falta.
  - `app.lti.ags.get_lineitem_max(platform, lineitem_url, key) -> float`.
  - `app.lti.ags.post_score(platform, link, key, *, sub, score, score_maximum, comment=None) -> None`.
  - `app.lti.ags.schedule_score(response_id: uuid.UUID) -> None` — dispara el envío en
    segundo plano, sin bloquear al alumno.
  - `app.lti.ags.DEFAULT_SCORE_MAXIMUM = 100.0`.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_ags.py`:

```python
"""AGS: pedido del token, alta del line item y publicación de la nota."""

import json
import time
import uuid

import httpx
import jwt
import pytest
from jwt.algorithms import RSAAlgorithm

from app.db import async_session
from app.lti.ags import ensure_lineitem, get_access_token, get_lineitem_max, post_score
from app.lti.keys import get_tool_key
from app.models import LtiPlatform, LtiResourceLink

ISSUER = "https://moodle.ags"
CLIENT_ID = "cid-ags"
TOKEN_URL = f"{ISSUER}/mod/lti/token.php"
LINEITEMS = f"{ISSUER}/mod/lti/services.php/2/lineitems"
LINEITEM = f"{LINEITEMS}/7/lineitem"


@pytest.fixture
async def ags_setup():
    async with async_session() as session:
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php", auth_token_url=TOKEN_URL,
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=uuid.uuid4(),
        )
        session.add(platform)
        await session.commit()
        link = LtiResourceLink(platform_id=platform.id, resource_link_id="rl-ags",
                               survey_id=uuid.uuid4(), lineitems_url=LINEITEMS)
        session.add(link)
        await session.commit()
        key = await get_tool_key(session)
        return {"platform": platform, "link": link, "key": key}


@pytest.mark.asyncio
async def test_el_token_se_pide_con_un_client_assertion_firmado(monkeypatch, lti_on, ags_setup):
    capturado = {}

    async def fake_post(self, url, **kw):
        capturado["url"] = url
        capturado["data"] = kw.get("data")
        return httpx.Response(200, json={"access_token": "tok-1", "expires_in": 3600})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    token = await get_access_token(
        ags_setup["platform"], ags_setup["key"],
        ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
    )
    assert token == "tok-1"
    assert capturado["url"] == TOKEN_URL
    assert capturado["data"]["grant_type"] == "client_credentials"
    assert capturado["data"]["client_assertion_type"] == (
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    )

    # El client_assertion está firmado por el tool y apunta a la plataforma.
    from app.lti.keys import public_jwk

    public_key = RSAAlgorithm.from_jwk(json.dumps(public_jwk(ags_setup["key"])))
    claims = jwt.decode(capturado["data"]["client_assertion"], public_key,
                        algorithms=["RS256"], audience=TOKEN_URL)
    assert claims["iss"] == CLIENT_ID
    assert claims["sub"] == CLIENT_ID


@pytest.mark.asyncio
async def test_ensure_lineitem_crea_uno_si_no_existe(monkeypatch, lti_on, ags_setup):
    llamadas = []

    async def fake_post(self, url, **kw):
        llamadas.append(url)
        if url == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        return httpx.Response(201, json={"id": LINEITEM, "scoreMaximum": 10.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    url = await ensure_lineitem(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                                label="Examen", score_maximum=10.0)
    assert url == LINEITEM
    assert LINEITEMS in llamadas


@pytest.mark.asyncio
async def test_ensure_lineitem_no_recrea_si_ya_hay_uno(monkeypatch, lti_on, ags_setup):
    ags_setup["link"].lineitem_url = LINEITEM

    async def boom(self, url, **kw):
        raise AssertionError(f"no debería postear a {url}")

    monkeypatch.setattr(httpx.AsyncClient, "post", boom)
    url = await ensure_lineitem(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                                label="Examen", score_maximum=10.0)
    assert url == LINEITEM


@pytest.mark.asyncio
async def test_post_score_manda_la_nota_en_el_formato_de_ags(monkeypatch, lti_on, ags_setup):
    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        enviado["url"] = url
        enviado["json"] = kw.get("json")
        enviado["headers"] = kw.get("headers")
        return httpx.Response(200, json={})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    await post_score(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                     sub="u-42", score=8.5, score_maximum=10.0, comment="Buen trabajo")

    assert enviado["url"] == f"{LINEITEM}/scores"
    assert enviado["headers"]["Content-Type"] == "application/vnd.ims.lis.v1.score+json"
    body = enviado["json"]
    assert body["userId"] == "u-42"
    assert body["scoreGiven"] == 8.5
    assert body["scoreMaximum"] == 10.0
    assert body["activityProgress"] == "Completed"
    assert body["gradingProgress"] == "FullyGraded"
    assert body["comment"] == "Buen trabajo"
    assert body["timestamp"].endswith("Z") or "+" in body["timestamp"]


@pytest.mark.asyncio
async def test_get_lineitem_max_lee_la_escala_del_libro(monkeypatch, lti_on, ags_setup):
    async def fake_post(self, url, **kw):
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})

    async def fake_get(self, url, **kw):
        assert url == LINEITEM
        return httpx.Response(200, json={"id": LINEITEM, "scoreMaximum": 20.0, "label": "Examen"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    assert await get_lineitem_max(ags_setup["platform"], LINEITEM, ags_setup["key"]) == 20.0


@pytest.mark.asyncio
async def test_la_nota_se_reescala_a_la_escala_del_libro(monkeypatch, lti_on, ags_setup):
    """Rúbrica sobre 10, libro sobre 20: un 8,5 tiene que llegar como 17."""
    from app.lti.ags import _deliver
    from app.models import Survey, SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return httpx.Response(200, json={})

    async def fake_get(self, url, **kw):
        return httpx.Response(200, json={"id": LINEITEM, "scoreMaximum": 20.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    async with async_session() as session:
        session.add(ags_setup["link"])
        survey = Survey(id=ags_setup["link"].survey_id, org_id=uuid.uuid4(),
                        title="Examen", json_schema={})
        session.add(survey)
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)
    assert enviado["json"]["scoreGiven"] == 17.0
    assert enviado["json"]["scoreMaximum"] == 20.0
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_ags.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'app.lti.ags'`

- [ ] **Step 3: Implementar AGS**

Crear `backend/app/lti/ags.py`:

```python
"""Assignment and Grade Services: devolver la nota al libro de calificaciones.

La plataforma no acepta cualquier request: hay que pedirle un token OAuth2
`client_credentials` probando quiénes somos con un `client_assertion` firmado con
la clave privada del tool. Con ese token se crea el line item (el ítem del libro)
si falta, y se publica el score.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

import httpx

from app.lti.keys import ToolKey, sign
from app.models import LtiPlatform, LtiResourceLink

LOGGER = logging.getLogger(__name__)

SCOPE_LINEITEM = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem"
SCOPE_LINEITEM_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly"
SCOPE_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score"

_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

# Escala con la que damos de alta el ítem del libro cuando lo creamos nosotros.
# La rúbrica tiene su propia escala y varía entre respuestas (preguntas
# condicionales), así que el libro se fija acá y cada nota se reescala.
DEFAULT_SCORE_MAXIMUM = 100.0


async def get_access_token(platform: LtiPlatform, key: ToolKey, scopes: list[str]) -> str:
    """Token OAuth2 para hablar con los servicios de la plataforma."""
    now = int(time.time())
    assertion = sign(
        {
            "iss": platform.client_id,
            "sub": platform.client_id,
            "aud": platform.auth_token_url,
            "iat": now,
            "exp": now + 300,
            "jti": uuid.uuid4().hex,
        },
        key,
    )
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            platform.auth_token_url,
            data={
                "grant_type": "client_credentials",
                "client_assertion_type": _ASSERTION_TYPE,
                "client_assertion": assertion,
                "scope": " ".join(scopes),
            },
        )
    resp.raise_for_status()
    return resp.json()["access_token"]


async def ensure_lineitem(
    platform: LtiPlatform,
    link: LtiResourceLink,
    key: ToolKey,
    *,
    label: str,
    score_maximum: float,
) -> str:
    """URL del line item de esta actividad, creándolo si la plataforma no lo hizo."""
    if link.lineitem_url:
        return link.lineitem_url
    if not link.lineitems_url:
        raise RuntimeError("La actividad no expone el servicio de notas (falta lineitems).")

    token = await get_access_token(platform, key, [SCOPE_LINEITEM])
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            link.lineitems_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/vnd.ims.lis.v2.lineitem+json",
            },
            json={
                "scoreMaximum": float(score_maximum),
                "label": label,
                "resourceLinkId": link.resource_link_id,
                "resourceId": str(link.survey_id),
            },
        )
    resp.raise_for_status()
    return resp.json()["id"]


async def get_lineitem_max(platform: LtiPlatform, lineitem_url: str, key: ToolKey) -> float:
    """Escala real del ítem del libro.

    AGS rechaza un score cuyo `scoreMaximum` no coincide con el del line item, y
    el docente puede haber cambiado la nota máxima en Moodle después de crearlo.
    Por eso se lee en vez de asumirse."""
    token = await get_access_token(platform, key, [SCOPE_LINEITEM_RO])
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            lineitem_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.ims.lis.v2.lineitem+json",
            },
        )
    resp.raise_for_status()
    return float(resp.json().get("scoreMaximum") or DEFAULT_SCORE_MAXIMUM)


async def post_score(
    platform: LtiPlatform,
    link: LtiResourceLink,
    key: ToolKey,
    *,
    sub: str,
    score: float,
    score_maximum: float,
    comment: str | None = None,
) -> None:
    """Publica la nota de un alumno en el line item de la actividad."""
    lineitem = link.lineitem_url
    if not lineitem:
        raise RuntimeError("La actividad no tiene line item donde publicar la nota.")

    token = await get_access_token(platform, key, [SCOPE_SCORE])
    body = {
        "userId": sub,
        "scoreGiven": float(score),
        "scoreMaximum": float(score_maximum),
        "activityProgress": "Completed",
        "gradingProgress": "FullyGraded",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if comment:
        body["comment"] = comment

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{lineitem.split('?')[0]}/scores",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/vnd.ims.lis.v1.score+json",
            },
            json=body,
        )
    resp.raise_for_status()


async def _deliver(response_id: uuid.UUID) -> None:
    """Toma la respuesta ya corregida y publica su nota. Nunca propaga errores:
    que falle el LMS no puede romper el envío del alumno."""
    from app.db import async_session
    from app.lti.keys import get_tool_key
    from app.models import Survey, SurveyResponse

    try:
        async with async_session() as session:
            r = await session.get(SurveyResponse, response_id)
            if r is None or r.lti_link_id is None or r.score is None:
                return
            link = await session.get(LtiResourceLink, r.lti_link_id)
            if link is None:
                return
            platform = await session.get(LtiPlatform, link.platform_id)
            if platform is None:
                return
            survey = await session.get(Survey, r.survey_id)
            key = await get_tool_key(session)

            link.lineitem_url = await ensure_lineitem(
                platform, link, key,
                label=(survey.title if survey else None) or "Encuesta",
                score_maximum=DEFAULT_SCORE_MAXIMUM,
            )
            # La escala la manda el libro, no la rúbrica: puede haberla cambiado
            # el docente en Moodle.
            maximum = await get_lineitem_max(platform, link.lineitem_url, key)
            link.max_score = maximum
            session.add(link)
            await session.commit()

            # La rúbrica tiene su propia escala: se reescala antes de publicar.
            given = float(r.score)
            if r.max_score and float(r.max_score) > 0 and float(r.max_score) != maximum:
                given = given / float(r.max_score) * maximum

            await post_score(
                platform, link, key,
                sub=r.lti_sub or "",
                score=given,
                score_maximum=maximum,
                comment=(r.grade or {}).get("feedback") if isinstance(r.grade, dict) else None,
            )
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("no se pudo publicar la nota LTI de %s: %s", response_id, exc)


def schedule_score(response_id: uuid.UUID) -> None:
    """Dispara el envío sin bloquear la respuesta al alumno, igual que los webhooks."""
    try:
        asyncio.get_running_loop().create_task(_deliver(response_id))
    except RuntimeError:  # sin loop corriendo (tests sincrónicos): no hacemos nada
        LOGGER.debug("sin event loop: se omite el envío de nota LTI de %s", response_id)
```

- [ ] **Step 4: Enganchar el envío en `submit`**

En `backend/app/routers/public.py`, dentro de `submit`, inmediatamente después de la línea
`schedule_response_delivery(s.id, r.id)`, agregar:

```python
    # Si vino de un LMS y quedó una nota, se la devolvemos al libro de calificaciones.
    if lti and r.score is not None:
        from app.lti.ags import schedule_score

        schedule_score(r.id)
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_ags.py -v`
Expected: PASS, 6 tests.

- [ ] **Step 6: Correr la suite completa**

Run: `cd backend && python -m pytest -q`
Expected: sin regresiones.

- [ ] **Step 7: Commit**

```bash
git add backend/app/lti/ags.py backend/app/routers/public.py backend/tests/test_lti_ags.py
git commit -m "feat(lti): publicación de notas por AGS al libro de calificaciones"
```

---

### Task 7: Registro de la plataforma (manual y dinámico)

**Files:**
- Modify: `backend/app/routers/lti.py` (agregar `/register` y el alta manual)
- Test: `backend/tests/test_lti_register.py`

**Interfaces:**
- Consumes: `get_tool_key`, `public_jwk` (Task 2); `LtiPlatform` (Task 1);
  `current_context` de `app.deps` (para el alta manual desde el panel).
- Produces:
  - `POST /api/v1/lti/platforms` — alta manual, requiere sesión y rol admin.
  - `GET /lti/register?openid_configuration=<url>&registration_token=<jwt>` — Dynamic
    Registration: lee la configuración del LMS, se da de alta y devuelve una página
    que avisa a la ventana madre.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/tests/test_lti_register.py`:

```python
"""Registro de plataformas: alta manual y Dynamic Registration."""

import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.db import async_session
from app.main import app
from app.models import LtiPlatform

ISSUER = "https://moodle.reg"


@pytest.mark.asyncio
async def test_dynamic_registration_da_de_alta_la_plataforma(monkeypatch, lti_on):
    org_id = uuid.uuid4()

    async def fake_get(self, url, **kw):
        return httpx.Response(200, json={
            "issuer": ISSUER,
            "authorization_endpoint": f"{ISSUER}/mod/lti/auth.php",
            "token_endpoint": f"{ISSUER}/mod/lti/token.php",
            "jwks_uri": f"{ISSUER}/mod/lti/certs.php",
            "registration_endpoint": f"{ISSUER}/mod/lti/openid-registration.php",
            "https://purl.imsglobal.org/spec/lti-platform-configuration": {
                "product_family_code": "moodle",
                "version": "5.0",
            },
        })

    async def fake_post(self, url, **kw):
        assert url == f"{ISSUER}/mod/lti/openid-registration.php"
        # El LMS devuelve el client_id que nos asigna.
        return httpx.Response(201, json={
            "client_id": "assigned-client-id",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {
                "deployment_id": "7",
            },
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{ISSUER}/mod/lti/openid-configuration.php",
            "registration_token": "reg-token",
            "org_id": str(org_id),
        },
    )
    assert r.status_code == 200
    assert "postMessage" in r.text  # avisa a Moodle que terminó

    async with async_session() as session:
        p = (await session.scalars(
            select(LtiPlatform).where(LtiPlatform.issuer == ISSUER)
        )).first()
        assert p is not None
        assert p.client_id == "assigned-client-id"
        assert p.deployment_ids == ["7"]
        assert p.org_id == org_id
        assert p.auth_token_url == f"{ISSUER}/mod/lti/token.php"


@pytest.mark.asyncio
async def test_alta_manual_requiere_sesion(lti_on):
    client = TestClient(app)
    r = client.post("/api/v1/lti/platforms", json={
        "issuer": "https://otro.moodle", "client_id": "x", "deployment_ids": ["1"],
        "auth_login_url": "https://otro.moodle/a", "auth_token_url": "https://otro.moodle/t",
        "jwks_url": "https://otro.moodle/j",
    })
    assert r.status_code == 401
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd backend && python -m pytest tests/test_lti_register.py -v`
Expected: FAIL — `/lti/register` devuelve 404.

- [ ] **Step 3: Implementar el registro**

Agregar al final de `backend/app/routers/lti.py`:

```python
from starlette.responses import HTMLResponse

from app.deps import OrgContext, current_context
from app.models import ROLE_ADMIN, ROLE_RANK

_PLATFORM_CONFIG = "https://purl.imsglobal.org/spec/lti-platform-configuration"
_TOOL_CONFIG = "https://purl.imsglobal.org/spec/lti-tool-configuration"

# Página mínima que le avisa a Moodle que el registro terminó bien. Es lo que
# espera el asistente de "registro dinámico" del LMS.
_DONE_HTML = """<!doctype html><meta charset="utf-8"><title>Encuestum</title>
<p>Encuestum quedó conectado. Ya podés cerrar esta ventana.</p>
<script>
  if (window.opener) { window.opener.postMessage({subject: 'org.imsglobal.lti.close'}, '*'); }
  else if (window.parent !== window) { window.parent.postMessage({subject: 'org.imsglobal.lti.close'}, '*'); }
</script>"""


@router.get("/register", response_class=HTMLResponse, dependencies=[Depends(require_lti)])
async def dynamic_registration(
    request: Request,
    openid_configuration: str,
    org_id: uuid.UUID,
    registration_token: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    """LTI Dynamic Registration: leemos la configuración del LMS, nos damos de
    alta contra su endpoint de registro y guardamos lo que nos devuelve."""
    async with httpx.AsyncClient(timeout=15) as client:
        conf = (await client.get(openid_configuration)).json()

    base = str(request.base_url).rstrip("/")
    key = await get_tool_key(session)
    tool = {
        "application_type": "web",
        "response_types": ["id_token"],
        "grant_types": ["client_credentials", "implicit"],
        "initiate_login_uri": f"{base}/lti/login",
        "redirect_uris": [f"{base}/lti/launch"],
        "client_name": "Encuestum",
        "jwks_uri": f"{base}/lti/jwks.json",
        "token_endpoint_auth_method": "private_key_jwt",
        "scope": " ".join([SCOPE_LINEITEM, SCOPE_SCORE]),
        _TOOL_CONFIG: {
            "domain": urlparse(base).netloc,
            "target_link_uri": f"{base}/lti/launch",
            "claims": ["iss", "sub", "name", "email"],
            "messages": [
                {
                    "type": "LtiDeepLinkingRequest",
                    "target_link_uri": f"{base}/lti/launch",
                    "label": "Elegir una encuesta de Encuestum",
                }
            ],
        },
    }

    headers = {"Content-Type": "application/json"}
    if registration_token:
        headers["Authorization"] = f"Bearer {registration_token}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(conf["registration_endpoint"], headers=headers, json=tool)
    resp.raise_for_status()
    registered = resp.json()

    deployment_id = (registered.get(_TOOL_CONFIG) or {}).get("deployment_id")
    platform = LtiPlatform(
        issuer=conf["issuer"],
        client_id=registered["client_id"],
        deployment_ids=[deployment_id] if deployment_id else [],
        auth_login_url=conf["authorization_endpoint"],
        auth_token_url=conf["token_endpoint"],
        jwks_url=conf["jwks_uri"],
        org_id=org_id,
        name=(conf.get(_PLATFORM_CONFIG) or {}).get("product_family_code"),
    )
    session.add(platform)
    await session.commit()
    LOGGER.info("plataforma LTI registrada: %s (%s)", platform.issuer, platform.client_id)
    return HTMLResponse(_DONE_HTML)


class PlatformIn(BaseModel):
    issuer: str
    client_id: str
    deployment_ids: list[str]
    auth_login_url: str
    auth_token_url: str
    jwks_url: str
    name: str | None = None


# Router aparte: el alta manual sí va bajo /api/v1 y detrás de sesión.
admin_router = APIRouter(prefix="/lti", tags=["lti"])


@admin_router.post("/platforms", status_code=201, dependencies=[Depends(require_lti)])
async def create_platform(
    payload: PlatformIn,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Alta manual, para los LMS que no soportan registro dinámico."""
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Necesitás ser admin de la organización.")
    platform = LtiPlatform(**payload.model_dump(), org_id=ctx.org.id)
    session.add(platform)
    await session.commit()
    return {"id": str(platform.id)}
```

Agregar al principio de `backend/app/routers/lti.py` los imports que faltan:

```python
from urllib.parse import urlparse

import httpx

from app.lti.ags import SCOPE_LINEITEM, SCOPE_SCORE
```

Y en `backend/app/main.py`, junto a los otros routers de `/api/v1`, agregar:

```python
app.include_router(lti.admin_router, prefix=API)
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cd backend && python -m pytest tests/test_lti_register.py -v`
Expected: PASS, 2 tests.

- [ ] **Step 5: Correr la suite completa**

Run: `cd backend && python -m pytest -q`
Expected: sin regresiones.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/lti.py backend/app/main.py backend/tests/test_lti_register.py
git commit -m "feat(lti): registro dinámico y alta manual de plataformas"
```

---

### Task 8: Entorno Docker con Moodle y Encuestum

**Files:**
- Create: `dev/moodle/docker-compose.yml`
- Create: `dev/moodle/Caddyfile`
- Create: `dev/moodle/.env.example`
- Create: `dev/moodle/up.ps1`
- Create: `dev/moodle/README.md`

**Interfaces:**
- Consumes: la imagen de Encuestum que construye el `Dockerfile` de la raíz.
- Produces: `https://moodle.localhost` y `https://encuestum.localhost` levantados y
  hablándose entre sí por HTTPS.

- [ ] **Step 1: Escribir el compose**

Crear `dev/moodle/docker-compose.yml`:

```yaml
# Entorno de desarrollo para la integración LTI: un Moodle y un Encuestum que se
# ven entre sí por HTTPS, que es condición para que el lanzamiento embebido
# funcione (las cookies SameSite=None exigen Secure).
name: encuestum-moodle-dev

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      default:
        aliases:
          - moodle.localhost
          - encuestum.localhost

  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: root
      MARIADB_DATABASE: moodle
      MARIADB_USER: moodle
      MARIADB_PASSWORD: moodle
      MARIADB_CHARACTER_SET: utf8mb4
      MARIADB_COLLATE: utf8mb4_unicode_ci
    volumes:
      - mariadb_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 20

  moodle:
    image: bitnami/moodle:5.0
    restart: unless-stopped
    depends_on:
      mariadb:
        condition: service_healthy
    environment:
      MOODLE_DATABASE_HOST: mariadb
      MOODLE_DATABASE_USER: moodle
      MOODLE_DATABASE_PASSWORD: moodle
      MOODLE_DATABASE_NAME: moodle
      MOODLE_USERNAME: admin
      MOODLE_PASSWORD: ${MOODLE_ADMIN_PASSWORD:-Encuestum#2026}
      MOODLE_EMAIL: admin@moodle.localhost
      MOODLE_SITE_NAME: Moodle de pruebas
      # Moodle tiene que generar sus URLs en https o el iframe rompe.
      MOODLE_REVERSEPROXY: "yes"
      MOODLE_SSLPROXY: "yes"
      BITNAMI_DEBUG: "true"
    volumes:
      - moodle_data:/bitnami/moodle
      - moodledata:/bitnami/moodledata
      # El plugin de la Fase 2 se monta acá para editarlo sin reconstruir.
      # Descomentar cuando exista:
      # - ../../../moodle-mod_encuestum:/bitnami/moodle/mod/encuestum

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: encuestum
      POSTGRES_USER: encuestum
      POSTGRES_PASSWORD: encuestum
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U encuestum"]
      interval: 10s
      timeout: 5s
      retries: 20

  encuestum:
    build:
      context: ../..
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      ENCUESTUM_DATABASE_URL: postgresql+asyncpg://encuestum:encuestum@postgres:5432/encuestum
      ENCUESTUM_SESSION_SECRET: dev-secret-solo-para-pruebas-32-bytes-o-mas
      ENCUESTUM_COOKIE_SECURE: "true"
      ENCUESTUM_TRUST_PROXY: "true"
      # El LMS vive en una IP privada de la red de Docker: sin esto el guard
      # SSRF bloquearía las llamadas a AGS. Nunca poner esto en producción.
      ENCUESTUM_ALLOW_PRIVATE_OUTBOUND: "true"
      LTI_ENABLED: "true"
      ENCUESTUM_SUPERADMIN_EMAIL: admin@encuestum.localhost

volumes:
  caddy_data:
  caddy_config:
  mariadb_data:
  moodle_data:
  moodledata:
  postgres_data:
```

- [ ] **Step 2: Escribir el Caddyfile**

Crear `dev/moodle/Caddyfile`:

```caddyfile
# TLS local con la CA interna de Caddy. Hay que confiar en esa CA una vez;
# está explicado en el README de esta carpeta.

moodle.localhost {
	tls internal
	reverse_proxy moodle:8080
}

encuestum.localhost {
	tls internal
	reverse_proxy encuestum:8080
}
```

> Verificar el puerto real que expone la imagen de Encuestum leyendo el `EXPOSE`
> del `Dockerfile` de la raíz, y ajustar `encuestum:8080` si no coincide.

- [ ] **Step 3: Escribir el script de arranque**

Crear `dev/moodle/up.ps1`:

```powershell
#!/usr/bin/env pwsh
# Levanta Moodle + Encuestum y explica los pasos manuales que quedan.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Levantando el entorno (la primera vez Moodle tarda varios minutos)..." -ForegroundColor Cyan
docker compose up -d --build

Write-Host "Esperando a que Moodle responda..." -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(10)
do {
    Start-Sleep -Seconds 10
    try {
        $r = Invoke-WebRequest -Uri "https://moodle.localhost/login/index.php" -SkipCertificateCheck -TimeoutSec 10
        $ok = $r.StatusCode -eq 200
    } catch { $ok = $false }
    if (-not $ok -and (Get-Date) -gt $deadline) {
        throw "Moodle no respondió en 10 minutos. Revisá: docker compose logs moodle"
    }
} until ($ok)

Write-Host ""
Write-Host "Listo." -ForegroundColor Green
Write-Host "  Moodle:    https://moodle.localhost     (admin / $($env:MOODLE_ADMIN_PASSWORD ?? 'Encuestum#2026'))"
Write-Host "  Encuestum: https://encuestum.localhost"
Write-Host ""
Write-Host "Si el navegador desconfía del certificado, instalá la CA de Caddy:" -ForegroundColor Yellow
Write-Host '  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt'
Write-Host '  Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root'
```

- [ ] **Step 4: Escribir el README con el recorrido manual**

Crear `dev/moodle/README.md`:

```markdown
# Entorno de pruebas: Moodle + Encuestum

Levanta un Moodle y un Encuestum que se hablan por HTTPS, para desarrollar y
probar la integración LTI 1.3.

## Arrancar

```powershell
.\up.ps1
```

- Moodle: <https://moodle.localhost> (usuario `admin`)
- Encuestum: <https://encuestum.localhost>

La primera vez Moodle tarda varios minutos en instalarse.

## Por qué HTTPS

El lanzamiento LTI ocurre dentro de un iframe: Encuestum se muestra embebido en
una página de Moodle. Las cookies que viajan en ese contexto necesitan
`SameSite=None; Secure`, y `Secure` exige HTTPS. Sobre HTTP plano el navegador
descarta la cookie y el alumno ve un error de sesión.

Caddy emite los certificados con su CA interna. Hay que confiar en ella una vez:

```powershell
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt
Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Si preferís no tocar el almacén de certificados, configurá la herramienta externa
en Moodle con **Contenedor de lanzamiento: Ventana nueva**. Ahí las cookies dejan
de ser de terceros y funciona sobre HTTP.

## Probar la integración sin el plugin

Hasta que exista `mod_encuestum` (Fase 2), se prueba con la herramienta externa
que ya trae Moodle:

1. En Encuestum, crear una organización y una encuesta publicada. Si querés
   probar las notas, activá la evaluación con IA.
2. En Moodle: *Administración del sitio → Plugins → Módulos de actividad →
   Herramienta externa → Gestionar herramientas*.
3. Pegar la URL de registro dinámico:
   `https://encuestum.localhost/lti/register?org_id=<UUID de tu organización>`
   y confirmar. Moodle hace el registro solo.
4. En un curso: *Agregar una actividad → Herramienta externa*, elegir Encuestum,
   y usar **Seleccionar contenido** para elegir la encuesta.
5. Entrar como alumno y responder. Si la encuesta es un examen, la nota aparece
   en el libro de calificaciones del curso.

## Apagar

```powershell
docker compose down          # conserva los datos
docker compose down -v       # borra todo y empieza de cero
```
```

- [ ] **Step 5: Levantar el entorno y verificar que ambos responden**

Run: `cd dev/moodle && pwsh ./up.ps1`
Expected: el script termina imprimiendo "Listo." y las dos URLs.

Verificación adicional:

Run: `curl -k https://encuestum.localhost/lti/jwks.json`
Expected: un JSON con `{"keys":[{"kty":"RSA",...}]}`

- [ ] **Step 6: Recorrer el flujo completo a mano**

Seguir los pasos de la sección "Probar la integración sin el plugin" del README y
confirmar los tres hitos:

1. El registro dinámico deja la plataforma dada de alta (verificable con
   `docker compose exec postgres psql -U encuestum -c "select issuer, client_id from lti_platforms;"`).
2. El selector de deep linking lista las encuestas y, al elegir una, Moodle guarda la
   actividad.
3. Al responder como alumno, la nota aparece en el libro de calificaciones del curso.

Si alguno falla, este es el momento de arreglarlo: es la primera vez que el código se
enfrenta a un Moodle de verdad, y los tests unitarios usan un JWKS simulado.

- [ ] **Step 7: Commit**

```bash
git add dev/moodle/
git commit -m "chore(dev): entorno Docker con Moodle y Encuestum para probar LTI"
```

---

## Cierre de la Fase 1

Al terminar la Task 8, la integración funciona de punta a punta contra un Moodle real, sin
haber escrito PHP. Lo que queda para la Fase 2 es experiencia de usuario: que el docente
vea "Encuestum" en el menú de actividades en vez de "Herramienta externa".

Antes de dar la fase por cerrada:

- [ ] `cd backend && python -m pytest -q` en verde.
- [ ] `cd frontend && npm run build` sin errores.
- [ ] Documentar `LTI_ENABLED`, `LTI_PRIVATE_KEY` y `LTI_KEY_ID` en `.env.example` y en la
      sección de configuración del `README.md`.
- [ ] Crear `docs/MOODLE.md` con las instrucciones de conexión para quien se autohostea,
      tomando como base la sección "Probar la integración sin el plugin" de
      `dev/moodle/README.md`.
