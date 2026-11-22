"""Campos ocultos, cupos, tiempo por pregunta, resultados públicos y plantillas."""

from tests.conftest import new_client, register

API = "/api/v1/survey"
SCHEMA = {"pages": [{"name": "p", "elements": [
    {"type": "text", "name": "nombre", "title": "Nombre"},
    {"type": "radiogroup", "name": "turno", "title": "Turno", "choices": ["Mañana", "Tarde"]},
    {"type": "comment", "name": "opinion", "title": "Opinión"},
]}]}


def _setup(**extra):
    c = new_client()
    register(c)
    s = c.post(f"{API}/surveys", json={"title": "Cursada", "json_schema": SCHEMA, **extra}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    return c, s["id"], s["slug"]


def _enviar(slug, answers, **meta):
    return new_client().post(f"{API}/public/{slug}/submit", json={"answers": answers, "meta": meta})


def test_campos_ocultos_se_guardan_filtran_y_exportan():
    c, sid, slug = _setup()
    assert c.put(f"{API}/surveys/{sid}", json={"hidden_fields": ["1malo"]}).status_code == 422
    assert c.put(f"{API}/surveys/{sid}", json={"hidden_fields": ["area", "origen"]}).json()["hidden_fields"] == ["area", "origen"]
    assert new_client().get(f"{API}/public/{slug}").json()["hidden_fields"] == ["area", "origen"]
    _enviar(slug, {"turno": "Mañana"}, hidden={"area": "ventas", "origen": "mail", "intruso": "x"})
    _enviar(slug, {"turno": "Tarde"}, hidden={"area": "ventas"})
    _enviar(slug, {"turno": "Tarde"}, hidden={"area": "rrhh" * 100})
    r = c.get(f"{API}/surveys/{sid}/responses").json()
    ocultos = sorted((x["meta"] or {}).get("hidden", {}).get("area", "")[:6] for x in r)
    assert ocultos == ["rrhhrr", "ventas", "ventas"]
    assert all("intruso" not in (x["meta"] or {}).get("hidden", {}) for x in r)

    # En el resumen, como pregunta segmentable.
    resumen = c.get(f"{API}/surveys/{sid}/summary", params={"segment_by": "turno"}).json()
    area = next(q for q in resumen["questions"] if q["name"] == "@area")
    assert area["hidden_field"] and {o["label"]: o["count"] for o in area["options"]}["ventas"] == 2
    filtrado = c.get(f"{API}/surveys/{sid}/summary",
                     params={"filters": '[{"name": "@area", "values": ["ventas"]}]'}).json()
    assert filtrado["filtered_responses"] == 2
    csv = c.get(f"{API}/surveys/{sid}/export?format=csv").content.decode("utf-8-sig")
    assert "@area" in csv.splitlines()[0] and "ventas" in csv


def test_cupos_cierran_un_grupo_y_no_el_resto():
    c, sid, slug = _setup(hidden_fields=["area"])
    c.put(f"{API}/surveys/{sid}", json={"hidden_fields": ["area"]})
    assert c.put(f"{API}/surveys/{sid}", json={"quotas": [{"question": "nada", "values": ["x"], "limit": 1}]}).status_code == 422
    c.put(f"{API}/surveys/{sid}", json={"quotas": [
        {"question": "turno", "values": ["Mañana"], "limit": 2, "message": "Turno mañana completo"},
        {"question": "@area", "values": ["ventas"], "limit": 1},
    ]})
    assert _enviar(slug, {"turno": "Mañana"}).status_code == 201
    assert _enviar(slug, {"turno": "Mañana"}).status_code == 201
    lleno = _enviar(slug, {"turno": "Mañana"})
    assert lleno.status_code == 409 and lleno.json()["detail"] == {"code": "quota_full", "message": "Turno mañana completo"}
    assert _enviar(slug, {"turno": "Tarde"}).status_code == 201
    assert _enviar(slug, {"turno": "Tarde"}, hidden={"area": "ventas"}).status_code == 201
    assert _enviar(slug, {"turno": "Tarde"}, hidden={"area": "ventas"}).status_code == 409
    estado = c.get(f"{API}/surveys/{sid}/quotas").json()
    assert [(q["used"], q["full"]) for q in estado] == [(2, True), (1, True)]


def test_tiempo_por_pregunta():
    c, sid, slug = _setup()
    for t in (10, 20, 30):
        _enviar(slug, {"turno": "Tarde", "opinion": "ok"}, timing={"turno": t, "opinion": 99999, "otra": 5})
    q = {x["name"]: x for x in c.get(f"{API}/surveys/{sid}/summary").json()["questions"]}
    assert q["turno"]["timing"] == {"median_seconds": 20, "n": 3}
    assert "timing" not in q["opinion"]  # más de 6 h: se descarta
    _enviar(slug, {"turno": "Tarde"}, timing={"turno": -3, "opinion": 10 ** 9})
    assert c.get(f"{API}/surveys/{sid}/summary").json()["questions"][1]["timing"]["n"] == 3


def test_resultados_publicos():
    c, sid, slug = _setup()
    d = c.put(f"{API}/surveys/{sid}", json={"public_results": {"enabled": True, "min_responses": 3}}).json()
    token = d["public_results"]["token"]
    anon = new_client()
    r = anon.get(f"{API}/public/results/{token}").json()
    assert r["enough"] is False and r["summary"] is None
    for n, turno in (("Ana", "Mañana"), ("Beto", "Tarde"), ("Caro", "Tarde")):
        _enviar(slug, {"nombre": n, "turno": turno, "opinion": "bien"})
    r = anon.get(f"{API}/public/results/{token}").json()
    nombres = [q["name"] for q in r["summary"]["questions"]]
    assert r["enough"] and nombres == ["turno"]  # sin el nombre (identifica) ni texto libre
    c.put(f"{API}/surveys/{sid}", json={"public_results": {"enabled": True, "show_text": True}})
    assert "opinion" in [q["name"] for q in anon.get(f"{API}/public/results/{token}").json()["summary"]["questions"]]
    # Apagar y prender conserva el link; regenerar lo cambia.
    c.put(f"{API}/surveys/{sid}", json={"public_results": {"enabled": False}})
    assert anon.get(f"{API}/public/results/{token}").status_code == 404
    d = c.put(f"{API}/surveys/{sid}", json={"public_results": {"enabled": True}}).json()
    assert d["public_results"]["token"] == token
    nuevo = c.put(f"{API}/surveys/{sid}", json={"public_results": {"enabled": True, "regenerate": True}}).json()
    assert nuevo["public_results"]["token"] != token
    assert anon.get(f"{API}/public/results/{token}").status_code == 404


def test_plantillas_propias():
    c, sid, _slug = _setup()
    t = c.post(f"{API}/templates", json={"survey_id": sid, "description": "Para fin de cuatrimestre"}).json()
    assert t["title"] == "Cursada" and t["questions"] == 3
    nueva = c.post(f"{API}/templates/{t['id']}/use").json()
    assert nueva["status"] == "draft" and nueva["json_schema"] == SCHEMA and nueva["id"] != sid
    assert c.get(f"{API}/templates").json()[0]["uses"] == 1
    otra = new_client(); register(otra)
    assert otra.get(f"{API}/templates").json() == []
    assert otra.post(f"{API}/templates/{t['id']}/use").status_code == 404
    assert c.delete(f"{API}/templates/{t['id']}").status_code == 204
