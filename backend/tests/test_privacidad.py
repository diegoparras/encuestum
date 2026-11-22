"""Fase 6: distribución, privacidad y ecosistema."""

import asyncio
import json
import re

import asyncpg

from app import jobs
from app.config import get_settings
from app.webhooks import chat_body, chat_kind
from tests.conftest import TEST_DATABASE_URL, new_client, register

API = "/api/v1/survey"
SCHEMA = {"pages": [{"name": "p", "elements": [
    {"type": "text", "name": "nombre", "title": "Nombre"},
    {"type": "text", "name": "mail", "title": "Email", "inputType": "email"},
    {"type": "radiogroup", "name": "color", "title": "Color", "choices": ["Rojo", "Azul"]},
]}]}


def _sql(query, *args):
    async def _go():
        conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        try:
            return await conn.fetch(query, *args)
        finally:
            await conn.close()

    return asyncio.run(_go())


def _setup(**extra):
    c = new_client()
    register(c)
    s = c.post(f"{API}/surveys", json={"title": "Clima", "json_schema": SCHEMA, **extra}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    return c, s["id"], s["slug"]


def _lista(c, sid, slug, email="ana@escuela.com"):
    c.put(f"{API}/surveys/{sid}", json={"access_mode": "list"})
    code = c.post(f"{API}/surveys/{sid}/invitees", json={"invitees": [{"email": email, "name": "Ana"}]}).json()[0]["code"]
    return code


def _token(slug, email, code):
    r = new_client().post(f"{API}/public/{slug}/access", json={"email": email, "code": code})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _emails(sid):
    return [json.loads(r["payload"]) if isinstance(r["payload"], str) else r["payload"]
            for r in _sql("SELECT payload FROM jobs WHERE kind='email.send' AND survey_id=$1::uuid ORDER BY created_at", sid)]


# ── Anonimato ───────────────────────────────────────────────────────────────


def test_anonimato_garantizado_no_guarda_identidad():
    c, sid, slug = _setup()
    assert c.put(f"{API}/surveys/{sid}", json={"anonymous": True}).json()["anonymous"] is True
    code = _lista(c, sid, slug)
    tok = _token(slug, "ana@escuela.com", code)
    r = new_client().post(f"{API}/public/{slug}/submit", headers={"User-Agent": "Navegador/1.0"}, json={
        "answers": {"color": "Rojo"}, "access_token": tok,
        "meta": {"visitor_id": "visitante-123456", "locale": "es-AR", "referrer": "https://x.example"},
    })
    assert r.status_code == 201, r.text
    fila = _sql("SELECT respondent_email, respondent_code, meta FROM survey_responses WHERE survey_id=$1::uuid", sid)[0]
    meta = json.loads(fila["meta"]) if isinstance(fila["meta"], str) else fila["meta"]
    assert fila["respondent_email"] is None and fila["respondent_code"] is None
    assert "visitor_id" not in meta and "referrer" not in meta and meta.get("locale") == "es-AR"
    assert "user_agent" not in meta["server"] and "ip_hash" not in meta["server"]
    # Se sabe QUE respondió (para no mandarle recordatorios), pero sólo el día.
    inv = c.get(f"{API}/surveys/{sid}/invitees").json()[0]
    assert inv["responded_at"] and inv["responded_at"][11:19] == "00:00:00"


# ── Seguimiento y recordatorios ────────────────────────────────────────────


def test_seguimiento_de_invitaciones_y_recordatorios(monkeypatch):
    monkeypatch.setattr(get_settings(), "smtp_host", "smtp.example.com")
    c, sid, slug = _setup()
    code = _lista(c, sid, slug)
    c.post(f"{API}/surveys/{sid}/invitees", json={"invitees": [{"email": "beto@escuela.com"}]})
    assert c.post(f"{API}/surveys/{sid}/invitees/send").json()["sent"] == 2

    mails = _emails(sid)
    ana = next(m for m in mails if m["to"] == "ana@escuela.com")
    assert "Responder" in ana["html"] and code in ana["text"]
    pixel = re.search(r'src="[^"]*(/api/v1/survey/public/track/open/[^"]+\.gif)"', ana["html"]).group(1)
    assert pixel.startswith("/api/v1/survey/public/track/open/")
    # El píxel responde siempre una imagen, válido o no.
    p = new_client().get(pixel)
    assert p.status_code == 200 and p.headers["content-type"] == "image/gif"
    assert new_client().get(f"{API}/public/track/open/basura.gif").status_code == 200
    t = c.get(f"{API}/surveys/{sid}/invitees/tracking").json()
    assert (t["sent"], t["opened"], t["clicked"], t["responded"]) == (2, 1, 0, 0)

    tok = _token(slug, "ana@escuela.com", code)
    new_client().post(f"{API}/public/{slug}/submit", json={"answers": {"color": "Azul"}, "access_token": tok})
    t = c.get(f"{API}/surveys/{sid}/invitees/tracking").json()
    assert (t["opened"], t["clicked"], t["responded"], t["response_rate"]) == (1, 1, 1, 0.5)

    # Recordatorio automático: cada 2 días, uno como máximo, sólo a quien no respondió.
    assert c.put(f"{API}/surveys/{sid}", json={"reminders": {"enabled": True, "every_days": 9, "max": 9}}).status_code == 422
    c.put(f"{API}/surveys/{sid}", json={"reminders": {"enabled": True, "every_days": 2, "max": 1}})
    asyncio.run(jobs.maintenance())
    assert not [m for m in _emails(sid) if m["subject"].startswith("Recordatorio")]  # todavía no pasaron 2 días
    _sql("UPDATE survey_invitees SET sent_at = now() - interval '3 days' WHERE survey_id=$1::uuid", sid)
    asyncio.run(jobs.maintenance())
    asyncio.run(jobs.maintenance())
    recordatorios = [m for m in _emails(sid) if m["subject"].startswith("Recordatorio")]
    assert [m["to"] for m in recordatorios] == ["beto@escuela.com"]
    # Manual: también sólo a quien no respondió.
    assert c.post(f"{API}/surveys/{sid}/invitees/remind").json()["sent"] == 1
    assert c.get(f"{API}/surveys/{sid}/invitees/tracking").json()["reminders"] == 2


# ── Retención ───────────────────────────────────────────────────────────────


def test_retencion_anonimiza_y_mantiene_la_integridad():
    c, sid, slug = _setup()
    assert c.put(f"{API}/surveys/{sid}", json={"retention_days": 0.5}).status_code == 422
    assert c.put(f"{API}/surveys/{sid}", json={"retention_days": 30, "retention_action": "borrar"}).status_code == 422
    d = c.put(f"{API}/surveys/{sid}", json={"retention_days": 30}).json()
    assert (d["retention_days"], d["retention_action"]) == (30, "anonymize")
    for nombre in ("Vieja", "Nueva"):
        new_client().post(f"{API}/public/{slug}/submit", json={
            "answers": {"nombre": nombre, "mail": f"{nombre.lower()}@x.com", "color": "Rojo"},
            "meta": {"visitor_id": "visitante-abcdef"}})
    _sql("UPDATE survey_responses SET submitted_at = now() - interval '40 days' "
         "WHERE survey_id=$1::uuid AND answers->>'nombre' = 'Vieja'", sid)
    asyncio.run(jobs.maintenance())
    filas = {r["answers"].get("nombre", "anon"): r for r in c.get(f"{API}/surveys/{sid}/responses").json()}
    assert set(filas) == {"Nueva", "anon"}
    anon = filas["anon"]
    assert anon["answers"] == {"color": "Rojo"}  # nombre y email fuera, el resto sigue contando
    assert anon["integrity_ok"] is True
    eventos = [e["action"] for e in c.get(f"{API}/surveys/{sid}/audit").json()]
    assert "response.anonymized" in eventos


def test_retencion_que_borra_y_la_de_la_organizacion():
    c, sid, slug = _setup()
    assert c.put("/api/v1/privacy/settings", json={"retention_days": 10, "retention_action": "delete"}).json() == \
        {"retention_days": 10, "retention_action": "delete"}
    new_client().post(f"{API}/public/{slug}/submit", json={"answers": {"color": "Rojo"}})
    _sql("UPDATE survey_responses SET submitted_at = now() - interval '11 days' WHERE survey_id=$1::uuid", sid)
    asyncio.run(jobs.maintenance())
    assert c.get(f"{API}/surveys/{sid}/responses").json() == []
    assert _sql("SELECT deleted_by_email FROM response_deletions WHERE survey_id=$1::uuid", sid)[0]["deleted_by_email"] \
        .startswith("sistema")


# ── Derechos de la persona ─────────────────────────────────────────────────


def test_buscar_exportar_y_borrar_los_datos_de_una_persona():
    c, sid, slug = _setup()
    code = _lista(c, sid, slug, "lu@escuela.com")
    tok = _token(slug, "lu@escuela.com", code)
    new_client().post(f"{API}/public/{slug}/submit", json={"answers": {"color": "Azul"}, "access_token": tok})
    # Otra encuesta pública donde escribió su email en una pregunta.
    otra = c.post(f"{API}/surveys", json={"title": "Otra", "json_schema": SCHEMA}).json()
    sid2, slug2 = otra["id"], otra["slug"]
    c.post(f"{API}/surveys/{sid2}/publish")
    new_client().post(f"{API}/public/{slug2}/submit", json={"answers": {"mail": "LU@escuela.com", "color": "Rojo"}})
    new_client().post(f"{API}/public/{slug2}/submit", json={"answers": {"mail": "otro@x.com", "color": "Rojo"}})

    f = c.get("/api/v1/privacy/person", params={"email": "lu@escuela.com"}).json()
    assert (f["responses"], f["invitations"]) == (2, 1) and len(f["surveys"]) == 2
    e = c.get("/api/v1/privacy/person/export", params={"email": "lu@escuela.com"})
    assert e.status_code == 200 and "attachment" in e.headers["content-disposition"]
    datos = e.json()
    assert {r["survey"] for r in datos["responses"]} == {"Clima", "Otra"} and datos["invitations"][0]["used_at"]

    assert c.post("/api/v1/privacy/person/erase", json={"email": "lu@escuela.com", "confirm": "otra@cosa.com"}).status_code == 422
    out = c.post("/api/v1/privacy/person/erase", json={"email": "lu@escuela.com", "confirm": "LU@escuela.com"}).json()
    assert out == {"responses": 2, "invitations": 1, "drafts": 0, "mode": "delete"}
    assert c.get("/api/v1/privacy/person", params={"email": "lu@escuela.com"}).json()["responses"] == 0
    assert len(c.get(f"{API}/surveys/{sid2}/responses").json()) == 1  # la de otra persona sigue
    # La auditoría no guarda el email borrado en claro.
    detalle = _sql("SELECT detail FROM audit_events WHERE action='person.erased' ORDER BY created_at DESC LIMIT 1")[0]["detail"]
    assert "lu@escuela.com" not in str(detalle)


# ── Tope de IA ──────────────────────────────────────────────────────────────


def test_tope_mensual_de_ia_frena_y_avisa():
    c, sid, _slug = _setup()
    org = c.get("/api/v1/auth/me").json()["orgs"][0]["id"]
    assert c.get("/api/v1/ai/budget").json()["budget_usd"] is None
    b = c.put("/api/v1/ai/budget", json={"budget_usd": 1.0}).json()
    assert b["budget_usd"] == 1.0 and b["blocked"] is False

    _sql("INSERT INTO ai_usage (id, org_id, operation, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at) "
         "VALUES (gen_random_uuid(), $1::uuid, 'grade', 'm', 1, 1, 2, 0.85, now())", org)
    assert c.get("/api/v1/ai/budget").json()["warn"] is True

    from app.ai_usage import _warn_if_needed
    from app.db import _session_maker
    import uuid as _uuid

    async def avisar():
        async with _session_maker() as s:
            await _warn_if_needed(s, _uuid.UUID(org))
            await s.commit()
            await _warn_if_needed(s, _uuid.UUID(org))  # una vez por mes
            await s.commit()

    asyncio.run(avisar())
    avisos = _sql("SELECT payload FROM jobs WHERE kind='email.send' AND org_id=$1::uuid", org)
    assert len(avisos) == 1 and "85%" in str(avisos[0]["payload"])

    _sql("INSERT INTO ai_usage (id, org_id, operation, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at) "
         "VALUES (gen_random_uuid(), $1::uuid, 'grade', 'm', 1, 1, 2, 0.2, now())", org)
    r = c.post(f"{API}/surveys/{sid}/generate-questions", json={"topic": "x", "count": 2, "types": ["radiogroup"]})
    assert r.status_code == 402 and "tope mensual" in r.json()["detail"]
    # Subir el tope destraba.
    c.put("/api/v1/ai/budget", json={"budget_usd": 50})
    assert c.post(f"{API}/surveys/{sid}/generate-questions",
                  json={"topic": "x", "count": 2, "types": ["radiogroup"]}).status_code == 200


# ── API pública ─────────────────────────────────────────────────────────────


def test_api_publica_con_claves():
    c, sid, slug = _setup()
    new_client().post(f"{API}/public/{slug}/submit", json={"answers": {"color": "Rojo"}})
    new_client().post(f"{API}/public/{slug}/submit", json={"answers": {"color": "Azul"}})
    k = c.post("/api/v1/api-keys", json={"name": "BI", "scope": "read"}).json()
    clave = k["key"]
    assert clave.startswith("enc_") and k["prefix"].endswith("_…")
    assert "key" not in c.get("/api/v1/api-keys").json()[0]

    api = new_client()  # sin cookies: sólo la clave
    assert api.get("/api/v1/ext/surveys").status_code == 401
    assert api.get("/api/v1/ext/surveys", headers={"Authorization": "Bearer enc_x_y"}).status_code == 401
    h = {"Authorization": f"Bearer {clave}"}
    lst = api.get("/api/v1/ext/surveys", headers=h).json()
    assert [(s["id"], s["response_count"]) for s in lst] == [(sid, 2)]
    p1 = api.get(f"/api/v1/ext/surveys/{sid}/responses", params={"limit": 1}, headers=h).json()
    assert p1["total"] == 2 and p1["next_offset"] == 1 and p1["items"][0]["answers"] == {"color": "Rojo"}
    assert p1["items"][0]["integrity_ok"] is True
    desde = p1["items"][0]["submitted_at"]
    p2 = api.get(f"/api/v1/ext/surveys/{sid}/responses", params={"since": desde}, headers={"X-Api-Key": clave}).json()
    assert [i["answers"]["color"] for i in p2["items"]] == ["Azul"]
    assert api.get(f"/api/v1/ext/surveys/{sid}/summary", headers=h).status_code == 200

    # Sólo lectura: no carga invitados.
    c.put(f"{API}/surveys/{sid}", json={"access_mode": "list"})
    assert api.post(f"/api/v1/ext/surveys/{sid}/invitees", headers=h,
                    json={"invitees": [{"email": "a@b.com"}]}).status_code == 403
    w = c.post("/api/v1/api-keys", json={"name": "CRM", "scope": "write"}).json()["key"]
    r = api.post(f"/api/v1/ext/surveys/{sid}/invitees", headers={"Authorization": f"Bearer {w}"},
                 json={"invitees": [{"email": "a@b.com"}, {"email": "A@b.com"}]})
    assert r.status_code == 201 and r.json()["created"] == 1

    # Otra organización no ve la encuesta.
    otra = new_client(); register(otra)
    ko = otra.post("/api/v1/api-keys", json={"name": "x"}).json()["key"]
    assert api.get(f"/api/v1/ext/surveys/{sid}", headers={"Authorization": f"Bearer {ko}"}).status_code == 404

    # Revocada deja de andar.
    c.delete(f"/api/v1/api-keys/{k['id']}")
    assert api.get("/api/v1/ext/surveys", headers=h).status_code == 401
    spec = new_client().get("/api/v1/ext/openapi.json").json()
    assert "/ext/surveys/{sid}/responses" in spec["paths"] and "ApiKey" in spec["components"]["securitySchemes"]
    assert not any(p.startswith("/survey") for p in spec["paths"])


# ── Slack / Teams ───────────────────────────────────────────────────────────


def test_webhooks_de_chat_salen_en_su_formato():
    assert chat_kind("https://hooks.slack.com/services/T/B/x") == "slack"
    assert chat_kind("https://acme.webhook.office.com/webhookb2/x") == "teams"
    assert chat_kind("https://prod-1.westus.logic.azure.com/workflows/x") == "teams_workflow"
    assert chat_kind("https://discord.com/api/webhooks/1/x") == "discord"
    assert chat_kind("https://hooks.zapier.com/x") is None
    payload = {"event": "response.created", "survey": {"id": "s1", "title": "Clima"},
               "response": {"score": 7.0, "max_score": 10.0, "percent": 70.0, "needs_review": True}}
    slack = chat_body("slack", payload)
    assert "«Clima»" in slack["text"] and "7/10 (70%)" in slack["text"] and "/surveys/s1" in slack["text"]
    teams = chat_body("teams", payload)
    assert teams["@type"] == "MessageCard" and teams["title"] == "Clima"
    flujo = chat_body("teams_workflow", payload)
    assert flujo["attachments"][0]["content"]["type"] == "AdaptiveCard"
