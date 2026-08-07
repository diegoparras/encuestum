"""Higiene de resultados: excluir, marcar de prueba, borrado múltiple y registro.

Lo que se prueba de verdad acá es que una respuesta fuera de los resultados
desaparezca de TODAS las vistas a la vez (resumen, planilla, estadísticas,
exportación, cupo) — el bug clásico es que cada endpoint arme su propio filtro
y una vista quede desincronizada.
"""

from tests.conftest import new_client, register

SCHEMA = {
    "pages": [
        {
            "elements": [
                {"type": "text", "name": "nom", "title": "Nombre y apellido"},
                {
                    "type": "radiogroup",
                    "name": "color",
                    "title": "Color",
                    "choices": ["Rojo", "Azul"],
                },
            ]
        }
    ]
}


def _publicada(c, **extra):
    """Crea y publica. `extra` va por PUT: el alta no acepta esos campos."""
    sv = c.post("/api/v1/survey/surveys", json={"title": "Higiene", "json_schema": SCHEMA}).json()
    if extra:
        r = c.put(f"/api/v1/survey/surveys/{sv['id']}", json=extra)
        assert r.status_code == 200, r.text
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    return sv


def _responder(c, slug, nom, color="Rojo"):
    r = c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"nom": nom, "color": color}})
    assert r.status_code == 201, r.text


def _ids(c, sid):
    return [r["id"] for r in c.get(f"/api/v1/survey/surveys/{sid}/responses").json()]


def test_excluir_saca_la_respuesta_de_todas_las_vistas():
    c = new_client()
    register(c)
    sv = _publicada(c)
    # El dueño tiene sesión: sus envíos se marcan como prueba, así que se
    # responde desde un cliente ANÓNIMO para simular gente real.
    anon = new_client()
    for nombre in ["Ana", "Beto", "Caro"]:
        _responder(anon, sv["slug"], nombre)

    sid = sv["id"]
    assert c.get(f"/api/v1/survey/surveys/{sid}/summary").json()["total_responses"] == 3

    # Se elige por contenido, no por posición: el listado viene en orden inverso.
    todas0 = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()
    victima = next(x["id"] for x in todas0 if x["answers"]["nom"] == "Ana")
    r = c.post(f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": [victima], "action": "exclude"})
    assert r.status_code == 200 and r.json()["affected"] == 1

    # Resumen, listado del panel y exportación: todos coinciden en 2.
    assert c.get(f"/api/v1/survey/surveys/{sid}/summary").json()["total_responses"] == 2
    listado = c.get("/api/v1/survey/surveys").json()
    assert next(x for x in listado if x["id"] == sid)["response_count"] == 2
    csv = c.get(f"/api/v1/survey/surveys/{sid}/export?format=csv").text
    assert "Ana" not in csv and "Beto" in csv

    # Pero sigue existiendo y se puede volver a incluir.
    todas = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()
    assert len(todas) == 3
    assert next(x for x in todas if x["id"] == victima)["excluded"] is True

    c.post(f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": [victima], "action": "include"})
    assert c.get(f"/api/v1/survey/surveys/{sid}/summary").json()["total_responses"] == 3


def test_marcar_como_prueba_la_saca_de_los_resultados():
    """El marcado es MANUAL a propósito.

    Marcarla sola cuando responde alguien del equipo parece cómodo, pero un
    miembro de la organización puede ser un respondiente real (el caso típico:
    una encuesta interna al propio equipo), y ocultarle la respuesta en silencio
    sería peor que el problema que resuelve.
    """
    c = new_client()
    register(c)
    sv = _publicada(c)
    anon = new_client()
    _responder(anon, sv["slug"], "Prueba mía")
    _responder(anon, sv["slug"], "Persona real")

    sid = sv["id"]
    assert c.get(f"/api/v1/survey/surveys/{sid}/summary").json()["total_responses"] == 2

    todas = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()
    assert all(x["is_test"] is False for x in todas)  # nada se marca solo

    prueba = next(x["id"] for x in todas if x["answers"]["nom"] == "Prueba mía")
    c.post(f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": [prueba], "action": "test"})

    assert c.get(f"/api/v1/survey/surveys/{sid}/summary").json()["total_responses"] == 1
    marcada = next(
        x for x in c.get(f"/api/v1/survey/surveys/{sid}/responses").json() if x["id"] == prueba
    )
    assert marcada["is_test"] is True

    # Y se puede desmarcar.
    c.post(f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": [prueba], "action": "untest"})
    assert c.get(f"/api/v1/survey/surveys/{sid}/summary").json()["total_responses"] == 2


def test_lo_excluido_no_consume_cupo():
    c = new_client()
    register(c)
    sv = _publicada(c, max_responses=1)
    anon = new_client()
    _responder(anon, sv["slug"], "Ana")

    # Cupo lleno: la segunda no entra.
    r = anon.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"nom": "Beto"}})
    assert r.status_code == 403

    # Al excluir la primera se libera el lugar.
    c.post(
        f"/api/v1/survey/surveys/{sv['id']}/responses/bulk",
        json={"ids": _ids(c, sv["id"]), "action": "exclude"},
    )
    _responder(anon, sv["slug"], "Beto")


def test_borrado_multiple_solo_para_admin_y_queda_registrado():
    dueno = new_client()
    _, _, me = register(dueno)
    sv = _publicada(dueno)
    anon = new_client()
    for n in ["Ana", "Beto"]:
        _responder(anon, sv["slug"], n)
    sid = sv["id"]
    ids = _ids(dueno, sid)

    # Un miembro sin rango admin no puede borrar.
    otro = new_client()
    _, _, m2 = register(otro)
    org = me["active_org_id"]
    inv = dueno.post(
        f"/api/v1/orgs/{org}/invitations", json={"email": m2["user"]["email"], "role": "member"}
    ).json()
    token = inv["accept_url"].split("token=")[1]
    otro.post("/api/v1/orgs/accept-invite", json={"token": token})
    assert otro.post(
        f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": ids, "action": "delete"}
    ).status_code == 403
    # …pero sí puede excluir (es reversible).
    assert otro.post(
        f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": ids[:1], "action": "exclude"}
    ).status_code == 200

    # El owner borra las dos de una.
    r = dueno.post(f"/api/v1/survey/surveys/{sid}/responses/bulk", json={"ids": ids, "action": "delete"})
    assert r.json()["affected"] == 2
    assert c_len(dueno, sid) == 0

    # Y queda el rastro de quién borró qué.
    reg = dueno.get(f"/api/v1/survey/surveys/{sid}/deletions").json()
    assert len(reg) == 2
    assert all(d["deleted_by_email"] for d in reg)
    assert {d["respondent"] for d in reg} == {"Ana", "Beto"}


def c_len(c, sid) -> int:
    return len(c.get(f"/api/v1/survey/surveys/{sid}/responses").json())


def test_el_registro_de_borrados_es_solo_para_admin():
    c = new_client()
    register(c)
    sv = _publicada(c)
    # Otra organización no ve nada de esta encuesta.
    ajeno = new_client()
    register(ajeno)
    assert ajeno.get(f"/api/v1/survey/surveys/{sv['id']}/deletions").status_code == 404
