"""Test bootstrap: isolated SQLite, insecure cookies (HTTP TestClient), mocked LLM."""

import os
import tempfile
import uuid

# Must be set BEFORE importing the app (engine + settings read env at import).
_TMP = tempfile.mkdtemp()
os.environ["ENCUESTUM_DATA_DIR"] = _TMP
os.environ["ENCUESTUM_SESSION_SECRET"] = "test-secret-not-for-prod-but-long-enough-32b+"
os.environ["ENCUESTUM_COOKIE_SECURE"] = "false"
os.environ["ENCUESTUM_LOG_FORMAT"] = "text"
os.environ["ENCUESTUM_ENABLE_HSTS"] = "false"
os.environ["ENCUESTUM_RATE_LIMIT_ENABLED"] = "false"
os.environ["ENCUESTUM_SUPERADMIN_EMAIL"] = "super@example.com"
os.environ["ENCUESTUM_WEBHOOKS_ENABLED"] = "false"
os.environ["ENCUESTUM_BASE_DOMAIN"] = "encuestum.example"

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


@pytest.fixture(scope="session", autouse=True)
def _bootstrap():
    import app.grading
    import app.llm_calls
    app.grading.grade_open_answer = _fake_grade
    app.llm_calls.grade_open_answer = _fake_grade
    app.llm_calls.summarize_open_responses = _fake_sum
    app.llm_calls.generate_survey_questions = _fake_gen
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
    return c


@pytest.fixture
def client():
    return new_client()
