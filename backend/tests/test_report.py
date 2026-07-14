"""Informe ejecutivo por IA: el contexto lo calcula el servidor (puro) y la IA
solo redacta. Acá probamos el cálculo del contexto y el endpoint (con LLM mockeado)."""

from app.summarizing import build_report_context
from tests.conftest import new_client, register


class _R:
    def __init__(self, answers):
        self.answers = answers


NPS_SCHEMA = {
    "pages": [
        {
            "elements": [
                {"type": "rating", "name": "nps", "title": "¿Recomendarías?", "rateMin": 0, "rateMax": 10},
                {"type": "comment", "name": "why", "title": "¿Por qué?"},
            ]
        }
    ]
}


def test_report_context_computes_nps():
    responses = [
        _R({"nps": 10, "why": "excelente"}),
        _R({"nps": 9, "why": "muy bueno"}),
        _R({"nps": 7, "why": "zafa"}),  # pasivo
        _R({"nps": 3, "why": "malo"}),  # detractor
    ]
    ctx = build_report_context(NPS_SCHEMA, responses)
    nps_q = next(q for q in ctx["questions"] if q["title"] == "¿Recomendarías?")
    # 2 promotores (9,10), 1 pasivo (7), 1 detractor (3) → NPS = (2-1)/4*100 = 25.
    assert nps_q["nps"] == {"score": 25, "promoters": 2, "passives": 1, "detractors": 1}


def test_report_context_samples_open_text_and_percents():
    responses = [
        _R({"nps": 10, "why": "cita textual A"}),
        _R({"nps": 3, "why": "cita textual B"}),
    ]
    ctx = build_report_context(NPS_SCHEMA, responses)
    why = next(q for q in ctx["questions"] if q["title"] == "¿Por qué?")
    assert why["kind"] == "text"
    # La IA solo podrá citar de estas muestras textuales.
    assert why["samples"] == ["cita textual A", "cita textual B"]


def test_report_context_includes_funnel():
    ctx = build_report_context(
        NPS_SCHEMA,
        [_R({"nps": 9})],
        funnel={"views": 10, "starts": 6, "completions": 4, "dropoff": []},
    )
    assert ctx["funnel"]["completion_rate"] == 40.0


SIMPLE = {"pages": [{"elements": [{"type": "text", "name": "q1", "title": "Nombre"}]}]}


def _make_published(c, title="Encuesta"):
    sv = c.post("/api/v1/survey/surveys", json={"title": title, "json_schema": SIMPLE}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    return sv


def test_generate_and_cache_report_endpoint():
    c = new_client()
    register(c)
    sv = _make_published(c)
    c.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"q1": "Ana"}})

    # Genera el informe (LLM mockeado en conftest).
    r = c.post(f"/api/v1/survey/surveys/{sv['id']}/report")
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    assert report["headline"]
    assert report["response_count"] == 1
    assert "generated_at" in report

    # Queda cacheado: el GET lo devuelve sin regenerar.
    got = c.get(f"/api/v1/survey/surveys/{sv['id']}/report").json()["report"]
    assert got["headline"] == report["headline"]


def test_report_requires_responses():
    c = new_client()
    register(c)
    sv = _make_published(c)  # sin respuestas
    r = c.post(f"/api/v1/survey/surveys/{sv['id']}/report")
    assert r.status_code == 409


def test_report_is_org_isolated():
    a = new_client()
    register(a)
    sv = _make_published(a)
    a.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"q1": "Ana"}})

    b = new_client()
    register(b)
    assert b.post(f"/api/v1/survey/surveys/{sv['id']}/report").status_code == 404
    assert b.get(f"/api/v1/survey/surveys/{sv['id']}/report").status_code == 404
