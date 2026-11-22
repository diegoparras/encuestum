"""Cola persistente (Fase 1 del roadmap): nada se pierde en silencio.

El worker está apagado en los tests (`ENCUESTUM_JOBS_WORKER=false`): la cola se
vacía a mano con `jobs.drain()` para que cada test vea exactamente lo suyo.
"""

import asyncio
from datetime import datetime, timedelta, timezone

import asyncpg

import app.routers.public as public_router
import app.webhooks as webhooks
from app import jobs
from app.config import get_settings
from tests.conftest import TEST_DATABASE_URL, new_client, register

API = "/api/v1/survey"

SCHEMA = {"pages": [{"name": "p", "elements": [
    {"type": "radiogroup", "name": "cap", "title": "Capital", "choices": ["Madrid", "París"]},
]}]}
EVAL = {"enabled": True, "passingScore": 60, "questions": {
    "cap": {"gradable": True, "grader": "auto", "points": 1, "correct": "París"},
}}


def _drain() -> int:
    return asyncio.run(jobs.drain())


def _sql(query, *args):
    async def _go():
        conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        try:
            return await conn.fetch(query, *args)
        finally:
            await conn.close()

    return asyncio.run(_go())


def _setup(ev=EVAL, **extra):
    c = new_client()
    _, _, me = register(c)
    s = c.post(f"{API}/surveys", json={"title": "T", "json_schema": SCHEMA, "evaluation": ev, **extra}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    return c, me, s["id"], s["slug"]


def _submit(slug, answers):
    r = new_client().post(f"{API}/public/{slug}/submit", json={"answers": answers})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_webhook_que_falla_se_reintenta_y_despues_entrega(monkeypatch):
    monkeypatch.setattr(get_settings(), "webhooks_enabled", True)
    intentos = []

    async def receptor(url, secret, payload, event="response.created"):
        intentos.append(payload["response"]["id"])
        return len(intentos) > 1  # el primero falla

    monkeypatch.setattr(webhooks, "post_webhook", receptor)
    c, me, sid, slug = _setup()
    org = me["orgs"][0]["id"]
    c.post(f"/api/v1/orgs/{org}/webhooks", json={"url": "https://example.com/hook"})
    rid = _submit(slug, {"cap": "París"})

    _drain()  # fanout -> una entrega por webhook -> primer intento falla
    fila = _sql("SELECT id, status, attempts, last_error FROM jobs WHERE kind='webhook.deliver' "
                "AND response_id=$1::uuid", rid)[0]
    assert fila["status"] == "pending" and fila["attempts"] == 1
    assert "no aceptó" in fila["last_error"]

    # Desde el panel se ve y se puede reintentar ya, sin esperar el backoff.
    fallidas = c.get(f"{API}/surveys/{sid}/deliveries").json()
    assert any(d["kind"] == "webhook.deliver" and d["last_error"] for d in fallidas)
    r = c.post(f"{API}/surveys/{sid}/deliveries/{fila['id']}/retry")
    assert r.status_code == 200
    _drain()
    assert _sql("SELECT status FROM jobs WHERE id=$1", fila["id"])[0]["status"] == "done"
    assert intentos == [rid, rid]


def test_una_tarea_interrumpida_se_retoma():
    _c, _me, sid, slug = _setup()
    rid = _submit(slug, {"cap": "París"})
    viejo = datetime.now(timezone.utc) - timedelta(hours=1)
    _sql(
        "INSERT INTO jobs (id, kind, payload, status, attempts, max_attempts, run_after, locked_at, "
        "survey_id, response_id, created_at) VALUES (gen_random_uuid(), 'grade.response', $1, "
        "'running', 1, 6, $2, $2, $3::uuid, $4::uuid, $2)",
        f'{{"response_id": "{rid}"}}', viejo, sid, rid,
    )
    _drain()
    fila = _sql("SELECT status, attempts FROM jobs WHERE kind='grade.response' AND response_id=$1::uuid", rid)[0]
    assert fila["status"] == "done" and fila["attempts"] == 2


def test_si_la_correccion_falla_al_enviar_se_reintenta_sola(monkeypatch):
    async def ia_caida(**kw):
        raise RuntimeError("proveedor caído")

    monkeypatch.setattr(public_router, "grade_response", ia_caida)
    c, _me, sid, slug = _setup()
    rid = _submit(slug, {"cap": "París"})
    resp = next(x for x in c.get(f"{API}/surveys/{sid}/responses").json() if x["id"] == rid)
    assert resp["score"] is None and resp["needs_review"] is True

    # El reintento espera un minuto: se adelanta para el test.
    _sql("UPDATE jobs SET run_after = now() WHERE kind='grade.response' AND response_id=$1::uuid", rid)
    _drain()
    resp = next(x for x in c.get(f"{API}/surveys/{sid}/responses").json() if x["id"] == rid)
    assert resp["score"] == 1
    fuentes = [g["source"] for g in c.get(f"{API}/surveys/{sid}/responses/{rid}/history").json()["grade_revisions"]]
    assert fuentes == ["submit_retry"]


def test_recorregir_todo_en_segundo_plano_informa_el_avance():
    c, _me, sid, slug = _setup()
    for _ in range(7):
        _submit(slug, {"cap": "Madrid"})
    c.put(f"{API}/surveys/{sid}", json={"evaluation": {**EVAL, "questions": {
        "cap": {**EVAL["questions"]["cap"], "correct": "Madrid"}}}})

    r = c.post(f"{API}/surveys/{sid}/grade-all?only_ungraded=false&background=true")
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    assert c.get(f"{API}/surveys/{sid}/jobs/{job_id}").json()["status"] == "pending"
    # Pedirlo de nuevo mientras espera no duplica la corrida.
    assert c.post(f"{API}/surveys/{sid}/grade-all?only_ungraded=false&background=true").json()["job_id"] == job_id

    _drain()
    j = c.get(f"{API}/surveys/{sid}/jobs/{job_id}").json()
    assert j["status"] == "done"
    assert j["result"] == {"graded": 7, "total": 7}
    assert j["progress"]["done"] == 7
    assert all(x["score"] == 1 for x in c.get(f"{API}/surveys/{sid}/responses").json())


def test_los_avisos_por_email_quedan_encolados_con_la_respuesta():
    c, _me, sid, slug = _setup(notify_emails=None)
    c.put(f"{API}/surveys/{sid}", json={"notify_emails": "dueno@escuela.com, otro@escuela.com"})
    rid = _submit(slug, {"cap": "París"})
    filas = _sql("SELECT payload, status FROM jobs WHERE kind='email.send' AND survey_id=$1::uuid", sid)
    destinos = sorted(f["payload"] for f in filas)
    assert len(destinos) == 2 and "dueno@escuela.com" in destinos[0]
    _drain()  # sin SMTP: queda en el log y la tarea se da por hecha
    assert {f["status"] for f in _sql("SELECT status FROM jobs WHERE kind='email.send' AND survey_id=$1::uuid", sid)} == {"done"}
    assert rid


def test_las_entregas_de_otra_organizacion_no_se_ven_ni_se_reintentan(monkeypatch):
    monkeypatch.setattr(get_settings(), "webhooks_enabled", True)
    c, _me, sid, slug = _setup()
    _submit(slug, {"cap": "París"})
    fila = _sql("SELECT id FROM jobs WHERE kind='webhooks.fanout' AND survey_id=$1::uuid", sid)[0]
    otro, _o, otra_sid, _ = _setup()
    assert otro.get(f"{API}/surveys/{sid}/deliveries").status_code == 404
    assert otro.post(f"{API}/surveys/{otra_sid}/deliveries/{fila['id']}/retry").status_code == 404


def test_respuestas_paginadas_y_filtradas_del_lado_del_servidor():
    c, _me, sid, slug = _setup()
    ids = [_submit(slug, {"cap": "París" if i % 2 else "Madrid"}) for i in range(5)]
    r = c.get(f"{API}/surveys/{sid}/responses?limit=2&offset=0")
    assert r.headers["x-total-count"] == "5" and len(r.json()) == 2
    pagina2 = c.get(f"{API}/surveys/{sid}/responses?limit=2&offset=2").json()
    pagina3 = c.get(f"{API}/surveys/{sid}/responses?limit=2&offset=4").json()
    vistos = [x["id"] for x in r.json() + pagina2 + pagina3]
    assert sorted(vistos) == sorted(ids) and len(set(vistos)) == 5
    c.post(f"{API}/surveys/{sid}/responses/bulk", json={"ids": ids[:2], "action": "exclude"})
    excl = c.get(f"{API}/surveys/{sid}/responses?filter=excluded")
    assert excl.headers["x-total-count"] == "2"
    assert c.get(f"{API}/surveys/{sid}/responses?filter=counted").headers["x-total-count"] == "3"
    # Sin `limit`, como antes: todas.
    assert len(c.get(f"{API}/surveys/{sid}/responses").json()) == 5


def test_dos_pestanas_editando_no_se_pisan_sin_aviso():
    c, _me, sid, _slug = _setup()
    base = c.get(f"{API}/surveys/{sid}").json()["content_hash"]
    # Pestaña A guarda con la huella que tenía: pasa y recibe la nueva.
    a = c.put(f"{API}/surveys/{sid}", json={"title": "Desde A", "base_content_hash": base})
    assert a.status_code == 200 and a.json()["content_hash"] != base
    # Pestaña B todavía tiene la huella vieja: conflicto, nada se pisa.
    b = c.put(f"{API}/surveys/{sid}", json={"title": "Desde B", "base_content_hash": base})
    assert b.status_code == 409 and b.json()["detail"]["code"] == "survey_conflict"
    assert c.get(f"{API}/surveys/{sid}").json()["title"] == "Desde A"
    # Cambiar algo que no es contenido (el acceso) no choca con el editor.
    assert c.put(f"{API}/surveys/{sid}", json={"results_mode": "never", "base_content_hash": base}).status_code == 200
    # Sin huella (API, llamadores viejos) no se controla.
    assert c.put(f"{API}/surveys/{sid}", json={"title": "Sin control"}).status_code == 200


def _invitado(c, sid, slug, email="alu@escuela.com"):
    c.put(f"{API}/surveys/{sid}", json={"access_mode": "list"})
    code = c.post(f"{API}/surveys/{sid}/invitees", json={"invitees": [{"email": email}]}).json()[0]["code"]
    token = new_client().post(f"{API}/public/{slug}/access",
                              json={"email": email, "code": code}).json()["access_token"]
    return token


def test_el_borrador_se_retoma_desde_otro_dispositivo_y_se_borra_al_enviar():
    c, _me, sid, slug = _setup()
    token = _invitado(c, sid, slug)
    compu, celu = new_client(), new_client()  # dos navegadores distintos
    assert compu.put(f"{API}/public/{slug}/draft",
                     json={"answers": {"cap": "Madrid"}, "page": 0, "access_token": token}).json()["saved"]
    d = celu.get(f"{API}/public/{slug}/draft", params={"access_token": token}).json()
    assert d["enabled"] and d["draft"]["answers"] == {"cap": "Madrid"}
    assert c.get(f"{API}/surveys/{sid}/funnel").json()["in_progress"] == 1

    r = celu.post(f"{API}/public/{slug}/submit", json={"answers": {"cap": "París"}, "access_token": token})
    assert r.status_code == 201
    assert celu.get(f"{API}/public/{slug}/draft", params={"access_token": token}).json()["draft"] is None
    assert c.get(f"{API}/surveys/{sid}/funnel").json()["in_progress"] == 0


def test_en_una_encuesta_publica_anonima_no_se_guarda_nada_en_el_servidor():
    _c, _me, sid, slug = _setup()
    anon = new_client()
    assert anon.put(f"{API}/public/{slug}/draft", json={"answers": {"cap": "Madrid"}}).json() == {"enabled": False}
    assert anon.get(f"{API}/public/{slug}/draft").json() == {"enabled": False}
    assert _sql("SELECT count(*) AS n FROM survey_drafts WHERE survey_id=$1::uuid", sid)[0]["n"] == 0


def test_los_borradores_vencidos_se_limpian():
    c, _me, sid, slug = _setup()
    token = _invitado(c, sid, slug, "viejo@escuela.com")
    new_client().put(f"{API}/public/{slug}/draft", json={"answers": {"cap": "x"}, "access_token": token})
    _sql("UPDATE survey_drafts SET updated_at = now() - interval '31 days' WHERE survey_id=$1::uuid", sid)
    asyncio.run(jobs.maintenance())
    assert _sql("SELECT count(*) AS n FROM survey_drafts WHERE survey_id=$1::uuid", sid)[0]["n"] == 0
