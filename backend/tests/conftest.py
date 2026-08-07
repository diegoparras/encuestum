"""Test bootstrap: Postgres desechable, cookies inseguras (TestClient va por HTTP), LLM mockeado.

La suite corre contra **PostgreSQL**, el mismo motor que producción, no contra
SQLite. La diferencia no es cosmética: SQLite ignora las cláusulas `ON DELETE`
salvo que se emita `PRAGMA foreign_keys=ON` en cada conexión, cosa que este
proyecto no hace en ningún lado. `app/models.py` declara 25 `ondelete=`; bajo
SQLite ninguna se aplicaba, así que todo test que dependiera de un CASCADE o de
un SET NULL pasaba sin comprobar nada.

La base la levanta `dev/test-db/docker-compose.yml`:

    docker compose -f dev/test-db/docker-compose.yml up -d

Si no está arriba, la sesión falla de entrada con instrucciones. Deliberadamente
**no** hay fallback a SQLite: un fallback silencioso es exactamente lo que hizo
que esto pasara inadvertido durante toda la fase 1.
"""

import os
import tempfile
import uuid

# Must be set BEFORE importing the app (engine + settings read env at import).
_TMP = tempfile.mkdtemp()
os.environ["ENCUESTUM_DATA_DIR"] = _TMP
# `setdefault`: CI puede apuntar a su propio servicio de Postgres.
TEST_DATABASE_URL = os.environ.setdefault(
    "DATABASE_URL", "postgresql://encuestum:encuestum@localhost:5433/encuestum_test"
)
# Ver `app.db._engine_kwargs`: la suite mezcla event loops y asyncpg no lo tolera.
os.environ["ENCUESTUM_DB_NULLPOOL"] = "1"
os.environ["ENCUESTUM_SESSION_SECRET"] = "test-secret-not-for-prod-but-long-enough-32b+"
os.environ["ENCUESTUM_COOKIE_SECURE"] = "false"
os.environ["ENCUESTUM_LOG_FORMAT"] = "text"
os.environ["ENCUESTUM_ENABLE_HSTS"] = "false"
os.environ["ENCUESTUM_RATE_LIMIT_ENABLED"] = "false"
os.environ["ENCUESTUM_SUPERADMIN_EMAIL"] = "super@example.com"
os.environ["ENCUESTUM_WEBHOOKS_ENABLED"] = "false"
os.environ["ENCUESTUM_BASE_DOMAIN"] = "encuestum.example"
# Los tests no deben depender de DNS; el guard SSRF se prueba aparte por unidad.
os.environ["ENCUESTUM_ALLOW_PRIVATE_OUTBOUND"] = "true"

import pytest
from fastapi.testclient import TestClient

from app.main import app as fastapi_app


# ── Mock the LLM so grading/insights/generation are deterministic ────────────
async def _fake_grade(*, language, question_title, model_answer, key_concepts, rubric, max_points, student_answer, criteria=None):
    low = (student_answer or "").lower()
    if "ignore" in low:
        return {"score": 0.0, "verdict": "incorrect", "criteria": [], "feedback": "inyección",
                "evidence": [student_answer[:10]], "confidence": 0.9, "needs_review": True, "injection_flag": True}
    hit = (key_concepts or ["_"])[0].lower() in low
    sc = float(max_points) if hit else float(max_points) / 2
    return {"score": sc, "verdict": "correct" if hit else "partial", "criteria": [],
            "feedback": "ok" if hit else "falta", "evidence": [student_answer[:10]],
            "confidence": 0.9, "needs_review": False, "injection_flag": False}


async def _fake_sum(*, question_title, language, answers):
    return {"overall": f"{len(answers)} respuestas",
            "themes": [{"label": "Positivo", "count": len(answers), "sentiment": "positive",
                        "summary": "ok", "evidence": [answers[0][:10]]}],
            "key_takeaways": ["a", "b"]}


async def _fake_gen(*, topic, count, types, language, difficulty, context=None):
    return {"questions": [{"type": "radiogroup", "title": f"P {topic}", "choices": ["A", "B"],
                           "correctIndices": [1], "modelAnswer": "", "keyConcepts": [],
                           "rubric": [], "points": 1.0}]}


async def _fake_report(*, language, context):
    n = context.get("total_responses", 0)
    return {
        "headline": f"Informe sobre {n} respuestas",
        "summary": "Resumen de prueba.",
        "findings": [{"title": "Hallazgo", "detail": "Detalle", "evidence": []}],
        "recommendations": ["Acción sugerida"],
    }


def _reset_schema() -> None:
    """Deja la base vacía antes de migrar.

    El contenedor guarda los datos en tmpfs, pero sobrevive entre corridas de
    pytest: sin esto, la segunda corrida arrancaría con las filas de la primera
    y las migraciones ya aplicadas."""
    import asyncio

    import asyncpg

    async def _run():
        try:
            conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        except (OSError, asyncpg.PostgresError) as e:
            raise RuntimeError(
                f"No hay Postgres en {TEST_DATABASE_URL} ({e}).\n"
                "La suite corre contra Postgres, no SQLite. Levantalo con:\n"
                "    docker compose -f dev/test-db/docker-compose.yml up -d"
            ) from e
        try:
            await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        finally:
            await conn.close()

    asyncio.run(_run())


@pytest.fixture(scope="session", autouse=True)
def _bootstrap():
    import app.grading
    import app.llm_calls

    _reset_schema()
    app.grading.grade_open_answer = _fake_grade
    app.llm_calls.grade_open_answer = _fake_grade
    app.llm_calls.summarize_open_responses = _fake_sum
    app.llm_calls.generate_survey_questions = _fake_gen
    app.llm_calls.generate_executive_report = _fake_report
    # Enter lifespan once to run migrations (creates the schema).
    with TestClient(fastapi_app):
        yield


def new_client() -> TestClient:
    """A fresh client with its own cookie jar (no lifespan re-run)."""
    return TestClient(fastapi_app)


def register(client: TestClient, email: str | None = None, password: str = "supersecret1", name: str = "Tester"):
    email = email or f"u{uuid.uuid4().hex[:10]}@example.com"
    r = client.post("/api/v1/auth/register", json={"email": email, "password": password, "name": name})
    assert r.status_code == 201, r.text
    return email, password, r.json()


def super_client() -> TestClient:
    """A super-admin client (email matches ENCUESTUM_SUPERADMIN_EMAIL). Registers
    the account or logs in if a prior test already created it — the email is
    unique and the DB is shared across the session."""
    c = new_client()
    r = c.post(
        "/api/v1/auth/register",
        json={"email": "super@example.com", "password": "supersecret1", "name": "Super"},
    )
    if r.status_code == 409:
        r = c.post(
            "/api/v1/auth/login",
            json={"email": "super@example.com", "password": "supersecret1"},
        )
    assert r.status_code in (200, 201), r.text
    # Super-admin via env email requires a VERIFIED account (security fix). Tests
    # don't run the email flow, so we mark it verified directly in the test DB.
    # Conexión cruda y no el engine de la app: asyncpg ata cada conexión al
    # event loop que la creó, y el pool del engine vive en el loop del
    # TestClient. Usarlo desde un `asyncio.run()` nuevo cuelga sin error.
    import asyncio

    import asyncpg

    async def _verify():
        conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        try:
            await conn.execute(
                "UPDATE users SET email_verified = true WHERE email = $1",
                "super@example.com",
            )
        finally:
            await conn.close()

    asyncio.run(_verify())
    return c


@pytest.fixture
def client():
    return new_client()


@pytest.fixture
def db_session():
    """El sessionmaker async de la app, para tests que necesitan hablar con la
    base directamente. `app.db` no expone un nombre público para esto — el
    sessionmaker interno es `_session_maker` — así que el acoplamiento a ese
    nombre privado vive acá y no en cada archivo de test."""
    from app.db import _session_maker

    return _session_maker


async def crear_org(session, nombre: str = "Org de prueba"):
    """Inserta una organización real y devuelve su `id`.

    Bajo Postgres las claves foráneas se aplican de verdad, así que fabricar un
    `uuid.uuid4()` suelto como `org_id` —que es lo que hacían varios tests
    mientras la suite corría en SQLite— ahora revienta con
    `ForeignKeyViolationError`. Es una mejora: esas filas nunca existieron en
    producción."""
    from app.models import Organization

    org = Organization(name=nombre)
    session.add(org)
    await session.commit()
    return org.id


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


@pytest.fixture
def mod_on(monkeypatch):
    """Enciende el módulo nativo de Moodle (`mod_encuestum`) para un test.

    Gemela de `lti_on`: `get_settings` está cacheado con `lru_cache`, así que
    hay que limpiarlo antes y después."""
    from app.config import get_settings

    monkeypatch.setenv("MOD_ENABLED", "true")
    get_settings.cache_clear()
    yield
    monkeypatch.delenv("MOD_ENABLED", raising=False)
    get_settings.cache_clear()
