"""Traducción de encuestas, formas fijas, ranking/matriz y QTI."""

import io
import zipfile

from app import llm_calls
from app.grading import grade_deterministic
from app.llm_calls import validate_quiz
from app.translation import localize, source_texts
from tests.conftest import new_client, register

API = "/api/v1/survey"
SCHEMA = {"title": "Clima", "pages": [{"name": "p", "elements": [
    {"type": "radiogroup", "name": "turno", "title": "¿Qué turno, {nombre}?", "choices": ["Mañana", {"value": "T", "text": "Tarde"}]},
    {"type": "boolean", "name": "ok", "title": "¿Volverías?", "labelTrue": "Sí", "labelFalse": "No"},
    {"type": "rating", "name": "n", "title": "Nota", "rateMin": 1, "rateMax": 5},
]}]}


def test_memoria_de_traduccion_y_esquema_localizado():
    textos = source_texts(SCHEMA)
    assert textos == ["Clima", "¿Qué turno, {nombre}?", "Mañana", "Tarde", "¿Volverías?", "Sí", "No", "Nota"]
    loc = localize(SCHEMA, {"en": {"Clima": "Climate", "Mañana": "Morning", "Tarde": "Afternoon"}})
    els = loc["pages"][0]["elements"]
    assert loc["title"] == {"default": "Clima", "en": "Climate"}
    # El valor se conserva (es lo que se guarda y se corrige); sólo cambia el texto.
    assert els[0]["choices"] == [{"value": "Mañana", "text": {"default": "Mañana", "en": "Morning"}},
                                 {"value": "T", "text": {"default": "Tarde", "en": "Afternoon"}}]
    assert els[1]["title"] == "¿Volverías?"  # sin traducción: queda el original
    assert SCHEMA["title"] == "Clima"  # no muta el original


def test_traducir_por_api_revisar_y_servir(monkeypatch):
    llamadas = []

    async def falso(*, texts, source_language, target_language):
        llamadas.append((target_language, len(texts)))
        return {t: f"[{target_language}] {t}" for t in texts}

    monkeypatch.setattr(llm_calls, "translate_texts", falso)
    c = new_client(); register(c)
    s = c.post(f"{API}/surveys", json={"title": "Clima", "json_schema": SCHEMA, "language": "es"}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    assert c.post(f"{API}/surveys/{s['id']}/translate", json={"languages": ["es"]}).status_code == 422
    assert c.post(f"{API}/surveys/{s['id']}/translate", json={"languages": ["xx"]}).status_code == 422
    r = c.post(f"{API}/surveys/{s['id']}/translate", json={"languages": ["en", "pt"]}).json()
    assert r["translated"] == {"en": 8, "pt": 8} and sorted(llamadas) == [("en", 8), ("pt", 8)]

    pub = new_client().get(f"{API}/public/{s['slug']}").json()
    assert pub["languages"] == ["es", "en", "pt"]
    assert pub["json_schema"]["pages"][0]["elements"][2]["title"] == {"default": "Nota", "en": "[en] Nota", "pt": "[pt] Nota"}

    # Corrección a mano; un marcador {…} roto se rechaza.
    assert c.put(f"{API}/surveys/{s['id']}/translations/en",
                 json={"items": {"¿Qué turno, {nombre}?": "Which shift?"}}).status_code == 422
    c.put(f"{API}/surveys/{s['id']}/translations/en", json={"items": {"Nota": "Grade"}})
    filas = {x["source"]: x["text"] for x in c.get(f"{API}/surveys/{s['id']}/translations/en").json()}
    assert filas["Nota"] == "Grade"

    # Editar la pregunta deja ese texto sin traducción (no una vieja) y
    # "sólo lo que falta" traduce sólo eso.
    nuevo = {**SCHEMA, "pages": [{"name": "p", "elements": [{**SCHEMA["pages"][0]["elements"][2], "title": "Puntaje"}]}]}
    c.put(f"{API}/surveys/{s['id']}", json={"json_schema": nuevo})
    cov = {x["language"]: x for x in c.get(f"{API}/surveys/{s['id']}/translations").json()["languages"]}
    assert cov["en"]["missing"] == 1
    llamadas.clear()
    c.post(f"{API}/surveys/{s['id']}/translate", json={"languages": ["en"]})
    assert llamadas == [("en", 1)]
    assert c.delete(f"{API}/surveys/{s['id']}/translations/pt").status_code == 204
    assert new_client().get(f"{API}/public/{s['slug']}").json()["languages"] == ["es", "en"]


def test_formas_fijas_reparten_y_mantienen_orden():
    c = new_client(); register(c)
    elementos = [{"type": "radiogroup", "name": f"q{i}", "title": f"Pregunta {i}", "choices": ["a", "b", "c", "d"],
                  **({"encGroup": "g"} if i < 4 else {})} for i in range(6)]
    ev = {"enabled": True, "questions": {f"q{i}": {"gradable": True, "grader": "auto", "correct": "a"} for i in range(6)},
          "integrity": {"forms": 2, "shuffleQuestions": True, "shuffleChoices": True, "groups": {"g": 2}}}
    s = c.post(f"{API}/surveys", json={"title": "Parcial", "json_schema": {"pages": [{"name": "p", "elements": elementos}]},
                                       "evaluation": ev}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    vistas = []
    for i in range(4):
        r = new_client().post(f"{API}/public/{s['slug']}/start", json={"visitor_id": f"visitante-{i:06d}"}).json()["exam"]
        els = r["json_schema"]["pages"][0]["elements"]
        vistas.append((r["form"], [e["name"] for e in els], [e["choices"] for e in els]))
    assert [v[0] for v in vistas] == ["A", "B", "A", "B"]
    assert vistas[0][1:] == vistas[2][1:] and vistas[1][1:] == vistas[3][1:]  # misma forma, mismo examen
    assert len(vistas[0][1]) == 4  # 2 del grupo + 2 fijas


def test_ranking_y_matriz_se_corrigen():
    rk = {"points": 3, "correct": ["a", "b", "c"]}
    assert grade_deterministic(rk, "ranking", ["a", "b", "c"])["awarded"] == 3
    assert grade_deterministic(rk, "ranking", ["a", "c", "b"])["awarded"] == 0
    assert grade_deterministic({**rk, "partialCredit": True}, "ranking", ["a", "c", "b"])["awarded"] == 1
    mx = {"points": 2, "correct": {"Perro": "Mamífero", "Rana": "Anfibio"}, "partialCredit": True}
    assert grade_deterministic(mx, "matrix", {"Perro": "Mamífero", "Rana": "Reptil"})["awarded"] == 1
    assert grade_deterministic(mx, "matrix", {})["verdict"] == "incorrect"


def test_el_generador_valida_ranking_y_matriz():
    ok = {"questions": [
        {"type": "ranking", "title": "Ordená", "choices": ["1810", "1816", "1853"]},
        {"type": "matrix", "title": "Clasificá", "rows": ["Perro", "Rana"], "columns": ["Mamífero", "Anfibio"],
         "correctColumns": [0, 1]},
    ]}
    assert validate_quiz(ok, count=2, types=["ranking", "matrix"]) == []
    malo = {"questions": [{"type": "matrix", "title": "X", "rows": ["a", "b"], "columns": ["x", "y"], "correctColumns": [0]}]}
    assert "un índice por fila" in validate_quiz(malo, count=1, types=["matrix"])[0]


def test_exportar_qti():
    c = new_client(); register(c)
    schema = {"pages": [{"name": "p", "elements": [
        {"type": "radiogroup", "name": "cap", "title": "Capital de Francia", "choices": ["París", "Lyon"]},
        {"type": "checkbox", "name": "pr", "title": "Primos", "choices": ["2", "3", "4"]},
        {"type": "text", "name": "rio", "title": "Río más largo"},
        {"type": "ranking", "name": "ord", "title": "Ordená", "choices": ["b", "a"]},
        {"type": "matrix", "name": "mx", "title": "Grilla", "rows": ["r"], "columns": ["c"]},
    ]}]}
    ev = {"enabled": True, "questions": {
        "cap": {"gradable": True, "correct": "París", "points": 2},
        "pr": {"gradable": True, "correct": ["2", "3"]},
        "rio": {"gradable": True, "grader": "auto", "correct": ["Amazonas", "Nilo"]},
        "ord": {"gradable": True, "correct": ["a", "b"]},
    }}
    s = c.post(f"{API}/surveys", json={"title": "Q", "json_schema": schema, "evaluation": ev}).json()
    r = c.get(f"{API}/surveys/{s['id']}/questions/export?format=qti")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert r.headers["x-encuestum-warnings"] == "1"  # la matriz
    z = zipfile.ZipFile(io.BytesIO(r.content))
    nombres = z.namelist()
    assert "imsmanifest.xml" in nombres and len(nombres) == 5
    import xml.etree.ElementTree as ET

    for n in nombres:
        ET.fromstring(z.read(n))  # XML bien formado
    cap = z.read(next(n for n in nombres if "cap" in n)).decode()
    assert '<correctResponse><value>c0</value></correctResponse>' in cap and 'maxChoices="1"' in cap
    orden = z.read(next(n for n in nombres if "ord" in n)).decode()
    assert 'cardinality="ordered"' in orden and "<value>c1</value><value>c0</value>" in orden
    rio = z.read(next(n for n in nombres if "rio" in n)).decode()
    assert 'mapKey="Nilo"' in rio
