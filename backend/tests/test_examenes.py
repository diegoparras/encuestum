"""Fase 5: exámenes serios (intercambio, banco, sorteo, tiempo, integridad, reclamos)."""

import pytest

from app.interchange import InterchangeError, export_gift, parse_aiken, parse_gift, parse_moodle_xml
from tests.conftest import new_client, register

API = "/api/v1/survey"

GIFT = """// banco de prueba
::Capital:: ¿Capital de Francia? {=París ~Lyon ~Niza}

::VF:: El sol es una estrella {T}

::Num:: ¿Cuánto es 2+2? {#4:0.5}

::Corta:: Río más largo {=Amazonas =Río Amazonas}

::Varias:: Elegí los primos {~%50%2 ~%50%3 ~%-100%4}

::Ensayo:: Explicá la fotosíntesis {}

::Emparejar:: Uní {=a -> 1 =b -> 2}
"""


def test_gift_se_lee_con_clave_y_avisa_lo_que_no_soporta():
    r = parse_gift(GIFT)
    tipos = [(q.element["type"], q.grading.get("correct")) for q in r.questions]
    assert tipos == [
        ("radiogroup", "París"), ("boolean", True), ("text", 4.0),
        ("text", ["Amazonas", "Río Amazonas"]), ("checkbox", ["2", "3"]), ("comment", None),
    ]
    assert r.questions[2].element["inputType"] == "number" and r.questions[2].grading["tolerance"] == 0.5
    assert r.questions[5].grading["grader"] == "llm"
    assert r.warnings == ["Emparejamiento no soportado: «Uní»"]


def test_aiken_y_moodle_ida_y_vuelta():
    a = parse_aiken("¿Planeta más grande?\nA. Marte\nB. Júpiter\nANSWER: B\n")
    assert a.questions[0].grading["correct"] == "Júpiter"
    r = parse_gift(GIFT)
    schema = {"pages": [{"elements": [q.element for q in r.questions]}]}
    ev = {"questions": {q.element["name"]: q.grading for q in r.questions}}
    from app.interchange import export_moodle_xml

    xml, _ = export_moodle_xml(schema, ev)
    vuelta = parse_moodle_xml(xml)
    assert [(q.element["type"], q.grading.get("correct")) for q in vuelta.questions] == \
        [(q.element["type"], q.grading.get("correct")) for q in r.questions]
    texto, avisos = export_gift(schema, ev)
    assert "{=París ~Lyon ~Niza}" in texto and "{T}" in texto and avisos == []


def test_xml_con_entidades_se_rechaza():
    bomba = '<?xml version="1.0"?><!DOCTYPE q [<!ENTITY a "aaaa">]><quiz>&a;</quiz>'
    with pytest.raises(InterchangeError):
        parse_moodle_xml(bomba)


def test_importar_y_exportar_por_api():
    c = new_client(); register(c)
    s = c.post(f"{API}/surveys", json={"title": "T"}).json()
    r = c.post(f"{API}/surveys/{s['id']}/questions/import", data={"text": GIFT})
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["elements"]) == 6 and out["warnings"]
    nombre = out["elements"][0]["name"]
    assert out["evaluation_questions"][nombre]["correct"] == "París"
    c.put(f"{API}/surveys/{s['id']}", json={
        "json_schema": {"pages": [{"name": "p", "elements": out["elements"]}]},
        "evaluation": {"enabled": True, "questions": out["evaluation_questions"]},
    })
    g = c.get(f"{API}/surveys/{s['id']}/questions/export?format=gift")
    assert g.status_code == 200 and "=París" in g.text
    x = c.get(f"{API}/surveys/{s['id']}/questions/export?format=moodle")
    assert x.status_code == 200 and "<quiz>" in x.text and 'type="essay"' in x.text
    vacio = c.post(f"{API}/surveys/{s['id']}/questions/import", data={"text": "nada que ver"})
    assert vacio.status_code == 422


def test_banco_guardar_filtrar_importar_y_estadisticas():
    c = new_client(); register(c)
    el = {"type": "radiogroup", "name": "cap", "title": "Capital de Francia", "choices": ["París", "Lyon"],
          "visibleIf": "{otra} = 1"}
    r = c.post(f"{API}/bank", json={"items": [
        {"element": el, "grading": {"gradable": True, "grader": "auto", "points": 1, "correct": "París"},
         "topic": "Geografía", "tags": ["Europa", "europa", " capitales "], "bloom": "recordar"}]})
    assert r.status_code == 201
    item = r.json()["items"][0]
    # La lógica que apuntaba a otras preguntas de la encuesta de origen no viaja.
    assert "visibleIf" not in item["element"] and item["tags"] == ["Europa", "capitales"]
    c.post(f"{API}/bank/import", data={"text": GIFT, "topic": "Varios", "tags": "gift"})
    f = c.get(f"{API}/bank/facets").json()
    assert f["total"] == 7 and {"value": "Geografía", "count": 1} in f["topics"]
    assert [i["title"] for i in c.get(f"{API}/bank?topic=Geografía").json()] == ["Capital de Francia"]
    assert len(c.get(f"{API}/bank?q=capital").json()) == 2  # "Capital de Francia" y la de GIFT
    assert len(c.get(f"{API}/bank?tag=gift").json()) == 6

    # Se usa en un examen (el editor inserta el elemento con encBankId) y se responde.
    usado = {**item["element"], "name": "p1", "encBankId": item["id"]}
    s = c.post(f"{API}/surveys", json={"title": "Parcial", "json_schema": {"pages": [{"elements": [usado]}]},
                                       "evaluation": {"enabled": True, "questions": {"p1": item["grading"]}}}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    for resp in ["París", "París", "Lyon", "París"]:
        new_client().post(f"{API}/public/{s['slug']}/submit", json={"answers": {"p1": resp}})
    st = c.get(f"{API}/bank/{item['id']}/stats").json()
    assert st["used_in"] == 1 and st["responses"] == 4 and st["difficulty"] == 0.75

    # Otra organización no lo ve.
    otro = new_client(); register(otro)
    assert otro.get(f"{API}/bank").json() == []
    assert otro.delete(f"{API}/bank/{item['id']}").status_code == 404


# ── Sorteo, tiempo límite e integridad ───────────────────────────────────────

import asyncio  # noqa: E402

import asyncpg  # noqa: E402

from tests.conftest import TEST_DATABASE_URL  # noqa: E402


def _sql(q, *a):
    async def go():
        conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        try:
            return await conn.fetch(q, *a)
        finally:
            await conn.close()
    return asyncio.run(go())


def _examen(c, *, groups=None, limit=None, signals=False):
    els = [{"type": "radiogroup", "name": f"g{i}", "title": f"Pregunta {i}", "choices": ["a", "b"],
            "encGroup": "u1"} for i in range(6)]
    els.append({"type": "comment", "name": "fija", "title": "Siempre aparece"})
    qs = {f"g{i}": {"gradable": True, "grader": "auto", "points": 1, "correct": "a"} for i in range(6)}
    s = c.post(f"{API}/surveys", json={"title": "Parcial", "json_schema": {"pages": [{"name": "p", "elements": els}]},
                                       "evaluation": {"enabled": True, "questions": qs, "integrity": {
                                           "groups": groups or {}, "timeLimitSec": limit, "signals": signals,
                                           "shuffleChoices": True}}}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    return s


def test_sorteo_estable_y_correccion_solo_de_lo_que_toco():
    c = new_client(); register(c)
    s = _examen(c, groups={"u1": 3}, limit=1800)
    alumno = new_client()
    a = alumno.post(f"{API}/public/{s['slug']}/start", json={"visitor_id": "visitante-0001"}).json()["exam"]
    nombres = [el["name"] for el in a["json_schema"]["pages"][0]["elements"]]
    sorteadas = [n for n in nombres if n.startswith("g")]
    assert len(sorteadas) == 3 and "fija" in nombres
    assert a["json_schema"]["pages"][0]["elements"][0].get("choicesOrder") == "random"
    assert 1790 <= a["seconds_left"] <= 1800
    # Recargar devuelve el mismo intento: mismas preguntas, mismo plazo.
    b = alumno.post(f"{API}/public/{s['slug']}/start", json={"visitor_id": "visitante-0001"}).json()["exam"]
    assert b["deadline"] == a["deadline"]
    assert [el["name"] for el in b["json_schema"]["pages"][0]["elements"]] == nombres

    resp = {n: "a" for n in sorteadas}
    r = alumno.post(f"{API}/public/{s['slug']}/submit", json={"answers": resp, "attempt_token": a["attempt_token"]})
    assert r.status_code == 201, r.text
    item = next(x for x in c.get(f"{API}/surveys/{s['id']}/responses").json() if x["id"] == r.json()["id"])
    # 3 sorteadas de 1 punto: 3/3, no 3/6.
    assert item["score"] == 3 and item["max_score"] == 3
    assert sorted(item["meta"]["drawn"]) == sorted(sorteadas)
    # Recorregir también respeta el sorteo.
    rg = c.post(f"{API}/surveys/{s['id']}/responses/{item['id']}/grade").json()
    assert rg["max_score"] == 3
    # El intento ya entregado no se puede volver a usar.
    again = alumno.post(f"{API}/public/{s['slug']}/submit", json={"answers": resp, "attempt_token": a["attempt_token"]})
    assert again.status_code == 409
    # Sin intento no se acepta un examen con sorteo.
    assert new_client().post(f"{API}/public/{s['slug']}/submit", json={"answers": resp}).status_code == 409


def test_entrega_fuera_de_tiempo_y_senales_de_integridad():
    c = new_client(); register(c)
    s = _examen(c, limit=600, signals=True)
    alumno = new_client()
    a = alumno.post(f"{API}/public/{s['slug']}/start", json={"visitor_id": "visitante-0002"}).json()["exam"]
    _sql("UPDATE survey_attempts SET started_at = now() - interval '20 minutes', "
         "deadline = now() - interval '10 minutes' WHERE survey_id = $1::uuid", s["id"])
    r = alumno.post(f"{API}/public/{s['slug']}/submit", json={
        "answers": {"g0": "a", "fija": "texto"}, "attempt_token": a["attempt_token"],
        "meta": {"integrity": {"tab_switches": 4, "hidden_seconds": 95, "malicioso": "x",
                               "pastes": [{"question": "fija", "chars": 640}, {"question": "g0", "chars": 3}]}},
    })
    assert r.status_code == 201
    item = next(x for x in c.get(f"{API}/surveys/{s['id']}/responses").json() if x["id"] == r.json()["id"])
    codigos = [f["code"] for f in item["meta"]["server"]["flags"]]
    assert codigos == ["late", "tab_switches", "paste"]
    assert "Siempre aparece" in item["meta"]["server"]["flags"][2]["detail"]
    assert item["meta"]["integrity"]["tab_switches"] == 4 and "malicioso" not in item["meta"]["integrity"]
    assert 1190 <= item["meta"]["server"]["exam_seconds"] <= 1260


def test_sin_configuracion_de_examen_no_hay_intento():
    c = new_client(); register(c)
    s = c.post(f"{API}/surveys", json={"title": "Encuesta", "json_schema": {"pages": [{"elements": []}]}}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    assert new_client().post(f"{API}/public/{s['slug']}/start", json={}).json() == {"exam": None}


def test_reclamo_de_nota_aceptado_corrige_y_queda_en_el_historial():
    c = new_client(); register(c)
    schema = {"pages": [{"name": "p", "elements": [
        {"type": "radiogroup", "name": "cap", "title": "Capital", "choices": ["París", "Lyon"]}]}]}
    ev = {"enabled": True, "questions": {"cap": {"gradable": True, "grader": "auto", "points": 2, "correct": "París"}}}
    s = c.post(f"{API}/surveys", json={"title": "P", "json_schema": schema, "evaluation": ev}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    c.put(f"{API}/surveys/{s['id']}", json={"access_mode": "list", "results_mode": "immediate"})
    code = c.post(f"{API}/surveys/{s['id']}/invitees", json={"invitees": [{"email": "ana@escuela.com"}]}).json()[0]["code"]
    alu = new_client()
    tok = alu.post(f"{API}/public/{s['slug']}/access", json={"email": "ana@escuela.com", "code": code}).json()["access_token"]
    alu.post(f"{API}/public/{s['slug']}/submit", json={"answers": {"cap": "Lyon"}, "access_token": tok})

    cred = {"email": "ana@escuela.com", "code": code}
    r = alu.post(f"{API}/public/{s['slug']}/appeal", json={**cred, "question": "cap", "message": "Lyon también fue capital (de la Galia)."})
    assert r.status_code == 201
    assert alu.post(f"{API}/public/{s['slug']}/appeal", json={**cred, "question": "cap", "message": "otra vez"}).status_code == 409
    assert alu.post(f"{API}/public/{s['slug']}/appeal", json={**cred, "question": "no_existe", "message": "xxxxx"}).status_code == 422

    lista = c.get(f"{API}/surveys/{s['id']}/appeals").json()
    assert lista[0]["status"] == "open" and lista[0]["answer"] == "Lyon" and lista[0]["awarded"] == 0
    res = c.post(f"{API}/surveys/{s['id']}/appeals/{lista[0]['id']}/resolve",
                 json={"decision": "accept", "reply": "Tenés razón, va la mitad.", "award": 1})
    assert res.status_code == 200 and res.json()["status"] == "accepted"
    resp = c.get(f"{API}/surveys/{s['id']}/responses").json()[0]
    assert resp["score"] == 1
    revs = c.get(f"{API}/surveys/{s['id']}/responses/{resp['id']}/history").json()["grade_revisions"]
    assert revs[-1]["source"] == "manual" and revs[-1]["note"].startswith("Reclamo aceptado")

    vista = alu.post(f"{API}/public/{s['slug']}/result", json=cred).json()
    assert vista["appeals"] == [{**vista["appeals"][0], "status": "accepted", "reply": "Tenés razón, va la mitad."}]
    assert c.post(f"{API}/surveys/{s['id']}/appeals/{lista[0]['id']}/resolve",
                  json={"decision": "reject", "reply": "no"}).status_code == 409
