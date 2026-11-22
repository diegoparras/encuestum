"""Fase 3: generación con IA robusta, con material real y sin repetidas."""

import asyncio
import io
import json
import zipfile

import httpx
import pytest
import respx

import app.llm_calls as llm_calls
from app import llm
from app.llm_calls import GeneratedQuiz, validate_quiz
from app.material import (
    MaterialError, extract_text, fetch_url, quote_in_material, select_relevant,
)
from tests.conftest import new_client, register

API = "/api/v1/survey"
BASE = "https://llm.example.com/v1"


def _q(**kw):
    base = {"type": "radiogroup", "title": "¿Cuál es la capital de Francia?",
            "choices": ["París", "Lyon", "Niza"], "correctIndices": [0], "acceptableAnswers": [],
            "modelAnswer": "", "keyConcepts": [], "rubric": [], "points": 1, "explanations": [],
            "bloom": "recordar", "objective": "", "sourceQuote": ""}
    base.update(kw)
    return base


def _completion(obj):
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(obj)}}],
                                     "usage": {"prompt_tokens": 10, "completion_tokens": 5}})


@pytest.fixture
def proveedor(monkeypatch):
    monkeypatch.setenv("ENCUESTUM_LLM_API_KEY", "k")
    monkeypatch.setenv("ENCUESTUM_LLM_BASE_URL", BASE)
    llm._SIN_JSON_SCHEMA.discard(BASE)
    monkeypatch.setattr(llm, "_REINTENTOS_HTTP", (0, 0))
    yield


@respx.mock
def test_pide_esquema_estricto_y_si_no_lo_soporta_cae_a_json_object(proveedor):
    pedidos = []

    def responder(request):
        body = json.loads(request.content)
        pedidos.append(body["response_format"]["type"])
        if body["response_format"]["type"] == "json_schema":
            return httpx.Response(400, json={"error": "response_format json_schema not supported"})
        return _completion({"questions": [_q()]})

    respx.post(f"{BASE}/chat/completions").mock(side_effect=responder)
    out = asyncio.run(llm.structured(system="s", user="u", schema_model=GeneratedQuiz))
    assert out["questions"][0]["title"].startswith("¿Cuál")
    assert pedidos == ["json_schema", "json_object"]
    # La segunda vez ya no prueba el esquema estricto con ese proveedor.
    asyncio.run(llm.structured(system="s", user="u", schema_model=GeneratedQuiz))
    assert pedidos[-1] == "json_object" and len(pedidos) == 3


@respx.mock
def test_reintenta_ante_un_5xx_del_proveedor(proveedor):
    r = respx.post(f"{BASE}/chat/completions").mock(
        side_effect=[httpx.Response(503, text="ocupado"), _completion({"questions": [_q()]})]
    )
    out = asyncio.run(llm.structured(system="s", user="u", schema_model=GeneratedQuiz))
    assert out["questions"] and r.call_count == 2


@respx.mock
def test_los_errores_de_validacion_vuelven_al_modelo_para_que_corrija(proveedor):
    mala = _q(correctIndices=[7])
    respx.post(f"{BASE}/chat/completions").mock(
        side_effect=[_completion({"questions": [mala]}), _completion({"questions": [_q()]})]
    )
    out = asyncio.run(llm.structured(
        system="s", user="u", schema_model=GeneratedQuiz,
        validate=lambda d: validate_quiz(d, count=1, types=["radiogroup"]),
    ))
    assert out["questions"][0]["correctIndices"] == [0]
    segundo = json.loads(respx.calls[1].request.content)
    assert "fuera de rango" in segundo["messages"][-1]["content"]


def test_validacion_de_reglas_que_el_esquema_no_expresa():
    errs = validate_quiz({"questions": [
        _q(correctIndices=[0, 1]),
        _q(type="checkbox", choices=["a", "b", "Todas las anteriores"], correctIndices=[0]),
        _q(type="text", choices=[], correctIndices=[]),
        _q(type="boolean", modelAnswer="quizás"),
    ]}, count=5, types=["radiogroup", "checkbox", "text", "boolean"])
    texto = " | ".join(errs)
    assert "se pidieron 5" in texto
    assert "exactamente un índice" in texto
    assert "anteriores" in texto
    assert "acceptableAnswers" in texto
    assert "'true' o 'false'" in texto
    # La rúbrica que no suma los puntos se reescala, no se rechaza.
    q = {"questions": [_q(type="comment", choices=[], correctIndices=[], points=2,
                          rubric=[{"label": "a", "points": 3}, {"label": "b", "points": 1}])]}
    assert validate_quiz(q, count=1, types=["comment"]) == []
    assert [r["points"] for r in q["questions"][0]["rubric"]] == [1.5, 0.5]


# ── Material ─────────────────────────────────────────────────────────────────

def _pdf(texto: str) -> bytes:
    """Un PDF mínimo de una página con texto, armado a mano."""
    stream = f"BT /F1 12 Tf 72 720 Td ({texto}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


def _docx(parrafos: list[str]) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in parrafos)
    xml = ('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
           f'wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xml)
    return buf.getvalue()


def test_extrae_texto_de_pdf_docx_y_html():
    assert "fotosintesis convierte luz" in extract_text("apunte.pdf", _pdf("La fotosintesis convierte luz"))
    assert extract_text("tp.docx", _docx(["Primer parrafo", "Segundo &amp; final"])) == \
        "Primer parrafo\n\nSegundo & final"
    html = "<html><script>x()</script><body><h1>Título</h1><p>Hola <b>mundo</b></p></body></html>"
    assert extract_text("p.html", html.encode()) == "Título\n\nHola mundo"
    with pytest.raises(MaterialError):
        extract_text("viejo.doc", b"xx")


def test_material_largo_se_recorta_a_lo_relevante():
    relleno = "\n\n".join(f"Párrafo de relleno número {i} sobre cosas varias." * 20 for i in range(60))
    clave = "La mitocondria produce energía celular mediante la respiración."
    texto, recortado = select_relevant(relleno + "\n\n" + clave * 3 + "\n\n" + relleno, "mitocondria energía",
                                       budget=4000)
    assert recortado and len(texto) <= 4000 + 100
    assert "mitocondria" in texto


def test_la_cita_se_verifica_contra_el_material():
    m = "La Revolución de Mayo ocurrió en 1810, en Buenos Aires."
    assert quote_in_material("revolucion de mayo ocurrio en 1810", m) is True
    assert quote_in_material("La independencia fue en 1816", m) is False
    assert quote_in_material("", m) is None


@respx.mock
def test_url_baja_la_pagina_y_bloquea_destinos_internos(monkeypatch):
    respx.get("https://apuntes.example.com/tema").mock(
        return_value=httpx.Response(200, headers={"content-type": "text/html"},
                                    text="<p>Contenido del tema</p>")
    )
    assert asyncio.run(fetch_url("https://apuntes.example.com/tema")) == "Contenido del tema"
    monkeypatch.setenv("ENCUESTUM_ALLOW_PRIVATE_OUTBOUND", "false")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        with pytest.raises(MaterialError):
            asyncio.run(fetch_url("http://169.254.169.254/latest/meta-data"))
    finally:
        monkeypatch.setenv("ENCUESTUM_ALLOW_PRIVATE_OUTBOUND", "true")
        get_settings.cache_clear()


def test_endpoint_de_material_con_pdf_subido():
    c = new_client(); register(c)
    sid = c.post(f"{API}/surveys", json={"title": "T"}).json()["id"]
    r = c.post(f"{API}/surveys/{sid}/generate/material",
               files={"file": ("clase.pdf", _pdf("El ciclo del agua tiene cuatro etapas"), "application/pdf")})
    assert r.status_code == 200, r.text
    assert "ciclo del agua" in r.json()["text"] and r.json()["source"] == "clase.pdf"
    assert c.post(f"{API}/surveys/{sid}/generate/material", files={"file": ("x.doc", b"aa")}).status_code == 422


# ── Orquestación ─────────────────────────────────────────────────────────────

def test_genera_en_lotes_descarta_repetidas_y_verifica_citas(monkeypatch):
    llamadas = []

    async def falso(*, topic, count, types, language, difficulty, context=None, avoid=None, **kw):
        llamadas.append({"count": count, "avoid": list(avoid or []), "context": context})
        n = len(llamadas)
        temas = ["evaporación", "condensación", "precipitación", "infiltración", "escorrentía",
                 "transpiración", "sublimación", "acuíferos", "glaciares", "océanos", "nubes",
                 "humedad", "rocío", "granizo", "napas", "deshielo", "ríos", "lagos"]
        qs = [_q(title=f"¿Qué rol cumple {temas[(n - 1) * 5 + i]} en el ciclo? ({n}.{i})",
                 sourceQuote="el agua se evapora")
              for i in range(count)]
        if n == 1:
            qs[0]["title"] = "¿Qué es el ciclo del agua?"  # ya existe en la encuesta
            qs[1]["sourceQuote"] = "una cita inventada"
        return {"questions": qs}

    monkeypatch.setattr(llm_calls, "generate_survey_questions", falso)
    c = new_client(); register(c)
    schema = {"pages": [{"elements": [{"type": "comment", "name": "a", "title": "¿Qué es el ciclo del agua?"}]}]}
    sid = c.post(f"{API}/surveys", json={"title": "T", "json_schema": schema}).json()["id"]
    r = c.post(f"{API}/surveys/{sid}/generate-questions", json={
        "topic": "ciclo del agua", "count": 12, "types": ["radiogroup"],
        "context": "Con el calor, el agua se evapora y forma nubes.",
    })
    assert r.status_code == 200, r.text
    out = r.json()
    # 12 → lotes de 5, 5 y 2 en paralelo, más uno para reponer la repetida.
    assert [x["count"] for x in llamadas[:3]] == [5, 5, 2] and llamadas[3]["count"] == 1
    assert "¿Qué es el ciclo del agua?" in llamadas[0]["avoid"]
    assert len(out["questions"]) == 12 and out["dropped_duplicates"] == 1
    assert all(q["title"] != "¿Qué es el ciclo del agua?" for q in out["questions"])
    verif = {q["title"]: q["sourceVerified"] for q in out["questions"]}
    assert verif["¿Qué rol cumple condensación en el ciclo? (1.1)"] is False
    assert verif["¿Qué rol cumple precipitación en el ciclo? (1.2)"] is True
    assert out["material"]["truncated"] is False


def test_deduplicacion_respeta_variantes_numericas():
    from app.routers.evaluation import _es_duplicada, _fold_title

    assert _es_duplicada("¿Cuál es la capital de Francia?", [_fold_title("Cual es la capital de francia")])
    assert _es_duplicada("¿Cuál es la capital de Francia ?", [_fold_title("¿Cuál es la capital de Francia?")])
    assert not _es_duplicada("¿Cuánto es 2 + 3?", [_fold_title("¿Cuánto es 2 + 4?")])
    assert not _es_duplicada("¿Quién escribió el Quijote?", [_fold_title("¿Quién pintó la Gioconda?")])


def test_revisor_de_redaccion_y_rubrica_desde_respuestas_reales(monkeypatch):
    vistos = {}

    async def falso_revisor(*, questions, language):
        vistos["preguntas"] = questions
        return {"questions": [
            {"name": "q1", "issues": [{"kind": "doble", "detail": "Pregunta dos cosas",
                                       "suggestion": "Separala"}], "rewrite": "¿Te gustó el curso?"},
            {"name": "intrusa", "issues": [], "rewrite": ""},
        ]}

    async def falsa_rubrica(*, title, model_answer, points, answers, language):
        vistos["muestras"] = answers
        return {"rubric": [{"label": "Define", "points": points, "description": ""}],
                "keyConcepts": ["x"], "common_errors": ["confunde A con B"]}

    monkeypatch.setattr(llm_calls, "review_wording", falso_revisor)
    monkeypatch.setattr(llm_calls, "suggest_rubric", falsa_rubrica)
    c = new_client(); register(c)
    schema = {"pages": [{"elements": [{"type": "comment", "name": "op", "title": "Explicá la fotosíntesis"}]}]}
    s = c.post(f"{API}/surveys", json={"title": "T", "json_schema": schema, "evaluation": {
        "enabled": True, "questions": {"op": {"gradable": True, "grader": "llm", "points": 4}}}}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")

    r = c.post(f"{API}/surveys/{s['id']}/review-wording", json={"questions": [
        {"name": "q1", "title": "¿Te gustó el curso y el docente?", "type": "radiogroup", "choices": ["Sí", "No"]}]})
    assert r.status_code == 200
    # Sólo vuelven las preguntas que se mandaron.
    assert [q["name"] for q in r.json()["questions"]] == ["q1"]

    assert c.post(f"{API}/surveys/{s['id']}/questions/op/suggest-rubric", json={}).status_code == 409
    for i in range(14):
        new_client().post(f"{API}/public/{s['slug']}/submit", json={"answers": {"op": "x" * (i + 1)}})
    r = c.post(f"{API}/surveys/{s['id']}/questions/op/suggest-rubric", json={})
    assert r.status_code == 200, r.text
    assert r.json()["points"] == 4 and r.json()["sample_size"] == len(vistos["muestras"]) <= 10
    # La muestra va de las más cortas a las más largas.
    assert len(vistos["muestras"][0]) < len(vistos["muestras"][-1])


def test_preguntale_a_tus_datos_usa_solo_numeros_del_servidor(monkeypatch):
    recibido = {}

    async def falso(*, question, context, language):
        recibido.update(context)
        return {"answer": "Ventas está más conforme.", "figures": [{"label": "Sí en Ventas", "value": "2"}],
                "caveats": ["Grupos de menos de 30."], "answerable": True}

    monkeypatch.setattr(llm_calls, "ask_data", falso)
    c = new_client(); register(c)
    schema = {"pages": [{"elements": [
        {"type": "radiogroup", "name": "area", "title": "Área", "choices": ["Ventas", "Soporte"]},
        {"type": "radiogroup", "name": "ok", "title": "¿Conforme?", "choices": ["Sí", "No"]}]}]}
    s = c.post(f"{API}/surveys", json={"title": "T", "json_schema": schema}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    for area, ok in [("Ventas", "Sí"), ("Ventas", "Sí"), ("Soporte", "No")]:
        new_client().post(f"{API}/public/{s['slug']}/submit", json={"answers": {"area": area, "ok": ok}})
    r = c.post(f"{API}/surveys/{s['id']}/ask", json={"question": "¿Qué área está más conforme?", "segment_by": "area"})
    assert r.status_code == 200 and r.json()["answer"]
    assert recibido["total_responses"] == 3
    grupos = recibido["segment"]["questions"][0]["by_group"]
    assert grupos["Ventas"] == {"Sí": 2, "No": 0}
