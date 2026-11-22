"""Trazabilidad (Fase 0 del roadmap): nada se pisa y nada desaparece sin rastro.

El criterio de salida de la fase es el primer test: editar la encuesta, corregir
a mano y recorregir, y que el historial muestre los tres pasos con autor y
valores. El resto cubre cada pieza por separado.
"""

import asyncio
import hashlib

import asyncpg

from tests.conftest import TEST_DATABASE_URL, new_client, register

API = "/api/v1/survey"

SCHEMA = {
    "pages": [
        {
            "name": "p",
            "elements": [
                {"type": "radiogroup", "name": "cap", "title": "Capital de Francia",
                 "choices": ["Madrid", "París"]},
                {"type": "comment", "name": "op", "title": "Justificá"},
            ],
        }
    ]
}


def _evaluacion(correct="París"):
    return {
        "enabled": True, "passingScore": 60,
        "questions": {
            "cap": {"gradable": True, "grader": "auto", "points": 1, "correct": correct},
            "op": {"gradable": True, "grader": "llm", "points": 1, "title": "Justificá",
                   "modelAnswer": "Porque sí", "keyConcepts": ["capital"], "rubric": []},
        },
    }


def _setup(ev=None):
    c = new_client()
    email, _, _ = register(c)
    s = c.post(f"{API}/surveys", json={"title": "T", "json_schema": SCHEMA, "language": "es",
                                      "evaluation": ev or _evaluacion()}).json()
    assert c.post(f"{API}/surveys/{s['id']}/publish").status_code == 200
    return c, email, s["id"], s["slug"]


def _responder(slug, answers, headers=None):
    anon = new_client()
    r = anon.post(f"{API}/public/{slug}/submit", json={"answers": answers}, headers=headers or {})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _resp(c, sid, rid):
    return next(x for x in c.get(f"{API}/surveys/{sid}/responses").json() if x["id"] == rid)


def test_editar_corregir_a_mano_y_recorregir_queda_todo_en_el_historial():
    c, email, sid, slug = _setup()
    rid = _responder(slug, {"cap": "Madrid", "op": "la capital es esa"})
    # Al enviar: cap mal (0) + op bien (1) = 1 de 2.
    assert _resp(c, sid, rid)["score"] == 1

    # El docente le da el punto de `cap` a mano.
    r = c.post(f"{API}/surveys/{sid}/responses/{rid}/override",
               json={"awards": {"cap": 1}, "note": "Aceptada por reclamo"})
    assert r.status_code == 200
    assert r.json()["score"] == 2
    # `passed` se recalcula con el total nuevo (antes quedaba como estaba).
    assert r.json()["grade"]["passed"] is True

    # Se edita la clave de la encuesta y se recorrige: lo manual se conserva.
    c.put(f"{API}/surveys/{sid}", json={"evaluation": _evaluacion(correct="Madrid")})
    r = c.post(f"{API}/surveys/{sid}/responses/{rid}/grade")
    assert r.status_code == 200
    g = r.json()["grade"]
    assert r.json()["score"] == 2
    assert g["overridden"] is True
    assert g["graded_with_version"] == 2

    h = c.get(f"{API}/surveys/{sid}/responses/{rid}/history").json()
    assert h["answered_version"] == 1
    assert h["integrity"] is True
    revs = h["grade_revisions"]
    assert [x["source"] for x in revs] == ["submit", "manual", "regrade"]
    assert (revs[1]["score_before"], revs[1]["score_after"]) == (1, 2)
    assert revs[1]["actor_email"] == email
    assert revs[1]["note"] == "Aceptada por reclamo"
    assert revs[2]["actor_email"] == email
    assert revs[2]["graded_with_version"] == 2


def test_recorregir_descartando_lo_manual_lo_dice_en_el_historial():
    c, _, sid, slug = _setup()
    rid = _responder(slug, {"cap": "Madrid", "op": "la capital"})
    c.post(f"{API}/surveys/{sid}/responses/{rid}/override", json={"awards": {"cap": 1}})
    r = c.post(f"{API}/surveys/{sid}/responses/{rid}/grade?discard_manual=true")
    assert r.json()["score"] == 1
    assert not r.json()["grade"].get("overridden")
    revs = c.get(f"{API}/surveys/{sid}/responses/{rid}/history").json()["grade_revisions"]
    assert revs[-1]["note"] == "Se descartaron las correcciones manuales"
    assert (revs[-1]["score_before"], revs[-1]["score_after"]) == (2, 1)


def test_recorregir_todo_respeta_el_total_fijado_a_mano():
    c, _, sid, slug = _setup()
    rid = _responder(slug, {"cap": "Madrid", "op": "nada que ver"})
    c.post(f"{API}/surveys/{sid}/responses/{rid}/override", json={"total": 1.75})
    r = c.post(f"{API}/surveys/{sid}/grade-all?only_ungraded=false")
    assert r.json()["graded"] == 1
    assert _resp(c, sid, rid)["score"] == 1.75
    audit = c.get(f"{API}/surveys/{sid}/audit").json()
    assert any(e["action"] == "grades.regrade_all" for e in audit)


def test_la_misma_encuesta_es_la_misma_version_y_un_cambio_crea_otra():
    c, _, sid, slug = _setup()
    r1 = _responder(slug, {"cap": "París"})
    r2 = _responder(slug, {"cap": "París"})
    a, b = _resp(c, sid, r1), _resp(c, sid, r2)
    assert a["survey_version_id"] == b["survey_version_id"] is not None

    nuevo = {**SCHEMA, "pages": [{**SCHEMA["pages"][0], "title": "Otra"}]}
    c.put(f"{API}/surveys/{sid}", json={"json_schema": nuevo})
    r3 = _responder(slug, {"cap": "París"})
    assert _resp(c, sid, r3)["survey_version_id"] != a["survey_version_id"]

    # Volver al contenido original reutiliza la versión 1.
    c.put(f"{API}/surveys/{sid}", json={"json_schema": SCHEMA})
    r4 = _responder(slug, {"cap": "París"})
    assert _resp(c, sid, r4)["survey_version_id"] == a["survey_version_id"]


def test_metadatos_los_pone_el_servidor_y_el_cliente_no_mete_cualquier_cosa():
    c, _, sid, slug = _setup()
    anon = new_client()
    r = anon.post(f"{API}/public/{slug}/submit", json={
        "answers": {"cap": "París"},
        "meta": {"locale": "es-AR", "visitor_id": "v1", "malicioso": {"x": 1}, "referrer": "a" * 5000},
    }, headers={"user-agent": "Navegador/1.0"})
    rid = r.json()["id"]
    meta = _resp(c, sid, rid)["meta"]
    assert "malicioso" not in meta
    assert meta["locale"] == "es-AR"
    assert len(meta["referrer"]) == 512
    assert meta["server"]["user_agent"] == "Navegador/1.0"
    assert meta["server"]["received_at"]
    assert len(meta["server"]["ip_hash"]) == 32


def test_la_huella_detecta_una_respuesta_tocada_en_la_base():
    c, _, sid, slug = _setup()
    rid = _responder(slug, {"cap": "París"})
    assert _resp(c, sid, rid)["integrity_ok"] is True

    async def _tocar():
        conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        try:
            await conn.execute(
                "UPDATE survey_responses SET answers = $1 WHERE id = $2::uuid",
                '{"cap": "Madrid"}', rid,
            )
        finally:
            await conn.close()

    asyncio.run(_tocar())
    assert _resp(c, sid, rid)["integrity_ok"] is False
    assert c.get(f"{API}/surveys/{sid}/responses/{rid}/history").json()["integrity"] is False


def test_el_borrado_definitivo_deja_rastro_que_sobrevive():
    c, _, sid, slug = _setup()
    rid = _responder(slug, {"cap": "París"})
    c.post(f"{API}/surveys/{sid}/responses/bulk", json={"ids": [rid], "action": "exclude"})
    assert c.delete(f"{API}/surveys/{sid}").status_code == 204
    assert c.delete(f"{API}/surveys/{sid}/purge").status_code == 204

    async def _leer():
        conn = await asyncpg.connect(TEST_DATABASE_URL, timeout=5)
        try:
            return await conn.fetch(
                "SELECT action, detail FROM audit_events WHERE survey_id = $1::uuid ORDER BY created_at",
                sid,
            )
        finally:
            await conn.close()

    filas = asyncio.run(_leer())
    acciones = [f["action"] for f in filas]
    assert acciones[:2] == ["survey.created", "survey.published"]
    assert "response.exclude" in acciones
    assert "survey.trashed" in acciones
    assert acciones[-1] == "survey.purged"
    assert '"responses_deleted": 1' in filas[-1]["detail"]
    assert rid in filas[-1]["detail"]


def test_exportar_queda_registrado_con_la_huella_del_archivo():
    c, _, sid, slug = _setup()
    _responder(slug, {"cap": "París"})
    r = c.get(f"{API}/surveys/{sid}/export?format=csv")
    assert r.status_code == 200
    sha = hashlib.sha256(r.content).hexdigest()
    assert r.headers["x-encuestum-sha256"] == sha
    header = r.text.splitlines()[0]
    assert "survey_version" in header and "integrity_sha256" in header
    ev = next(e for e in c.get(f"{API}/surveys/{sid}/audit").json()
              if e["action"] == "responses.exported")
    assert ev["detail"]["sha256"] == sha


def test_editar_la_encuesta_registra_que_campos_cambiaron_sin_copiar_el_pin():
    c, _, sid, _slug = _setup()
    c.put(f"{API}/surveys/{sid}", json={"access_mode": "pin", "access_pin": "secreto123"})
    ev = next(e for e in c.get(f"{API}/surveys/{sid}/audit").json()
              if e["action"] == "survey.updated")
    assert "access_pin" in ev["detail"]["fields"]
    assert "secreto123" not in str(ev)


def test_un_miembro_no_ve_el_registro_de_auditoria():
    c, _, sid, _slug = _setup()
    # Sin sesión no hay acceso; el detalle de roles lo cubre test_orgs.
    assert new_client().get(f"{API}/surveys/{sid}/audit").status_code in (401, 403)


def test_historial_de_versiones_guardar_publicar_y_restaurar():
    c, email, sid, slug = _setup()  # ya publicada: versión "publicada"
    otro = {"pages": [{"name": "p", "elements": [{"type": "comment", "name": "nueva", "title": "Otra cosa"}]}]}
    r = c.put(f"{API}/surveys/{sid}", json={"json_schema": otro, "snapshot": True})
    assert r.status_code == 200
    vs = c.get(f"{API}/surveys/{sid}/versions").json()
    assert [v["label"] for v in vs][:2] == ["guardado", "publicada"]
    assert vs[0]["created_by_email"] == email and vs[0]["questions"] == 1

    # Autoguardado enseguida después: no crea otra versión (cada 15 min como mucho).
    otro2 = {"pages": [{"name": "p", "elements": [{"type": "comment", "name": "n2", "title": "Y otra"}]}]}
    c.put(f"{API}/surveys/{sid}", json={"json_schema": otro2})
    assert len(c.get(f"{API}/surveys/{sid}/versions").json()) == len(vs)

    publicada = next(v for v in vs if v["label"] == "publicada")
    r = c.post(f"{API}/surveys/{sid}/versions/{publicada['id']}/restore")
    assert r.status_code == 200
    assert r.json()["json_schema"] == SCHEMA
    vs2 = c.get(f"{API}/surveys/{sid}/versions").json()
    # Lo que había antes de restaurar quedó guardado: restaurar se puede deshacer.
    assert vs2[0]["label"] == "antes de restaurar"
    assert c.get(f"{API}/surveys/{sid}/versions/{vs2[0]['id']}").json()["json_schema"] == otro2
    assert any(e["action"] == "survey.version_restored" for e in c.get(f"{API}/surveys/{sid}/audit").json())
