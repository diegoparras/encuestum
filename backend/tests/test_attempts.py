"""Intentos por persona: el campo "Intentos máx." de la interfaz existía desde
hacía rato y no lo aplicaba nadie. Acá se prueba que ahora sí, y por cuál de las
señales se reconoce a la persona en cada modo de acceso."""

from tests.conftest import new_client, register

SCHEMA = {
    "pages": [
        {
            "elements": [
                {"type": "text", "name": "nom", "title": "Nombre y apellido"},
                {"type": "text", "name": "mail", "title": "Mail"},
            ]
        }
    ]
}


def _publicada(c, **extra):
    sv = c.post("/api/v1/survey/surveys", json={"title": "Intentos", "json_schema": SCHEMA}).json()
    if extra:
        assert c.put(f"/api/v1/survey/surveys/{sv['id']}", json=extra).status_code == 200
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    return sv


def _enviar(c, slug, *, nom="Ana", mail="ana@example.com", visitor=None):
    body = {"answers": {"nom": nom, "mail": mail}}
    if visitor:
        body["meta"] = {"visitor_id": visitor}
    return c.post(f"/api/v1/survey/public/{slug}/submit", json=body)


def test_sin_limite_se_puede_responder_varias_veces():
    c = new_client()
    register(c)
    sv = _publicada(c)  # sin max_attempts
    anon = new_client()
    for _ in range(3):
        assert _enviar(anon, sv["slug"], visitor="visitante-a").status_code == 201


def test_un_intento_por_navegador():
    c = new_client()
    register(c)
    sv = _publicada(c, max_attempts=1)
    anon = new_client()
    assert _enviar(anon, sv["slug"], visitor="visitante-a").status_code == 201

    r = _enviar(anon, sv["slug"], mail="otro@example.com", visitor="visitante-a")
    assert r.status_code == 409
    assert "Ya respondiste" in r.json()["detail"]

    # Otro navegador (y otro correo) es otra persona: entra.
    assert _enviar(anon, sv["slug"], mail="beto@example.com", visitor="visitante-b").status_code == 201


def test_tambien_frena_por_el_correo_respondido():
    """Cambiar de navegador no alcanza si la encuesta pregunta el mail."""
    c = new_client()
    register(c)
    sv = _publicada(c, max_attempts=1)
    anon = new_client()
    assert _enviar(anon, sv["slug"], mail="ana@example.com", visitor="nav-1").status_code == 201
    r = _enviar(anon, sv["slug"], mail="ANA@example.com", visitor="nav-2")  # otro navegador
    assert r.status_code == 409  # mismo correo (y no distingue mayúsculas)


def test_dos_intentos():
    c = new_client()
    register(c)
    sv = _publicada(c, max_attempts=2)
    anon = new_client()
    assert _enviar(anon, sv["slug"], visitor="v").status_code == 201
    assert _enviar(anon, sv["slug"], visitor="v").status_code == 201
    r = _enviar(anon, sv["slug"], visitor="v")
    assert r.status_code == 409
    assert "2 intentos" in r.json()["detail"]


def test_excluir_una_respuesta_devuelve_el_intento():
    """Así se le da otra oportunidad a alguien sin borrarle nada."""
    c = new_client()
    register(c)
    sv = _publicada(c, max_attempts=1)
    anon = new_client()
    assert _enviar(anon, sv["slug"], visitor="v").status_code == 201
    assert _enviar(anon, sv["slug"], visitor="v").status_code == 409

    ids = [r["id"] for r in c.get(f"/api/v1/survey/surveys/{sv['id']}/responses").json()]
    c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/bulk", json={"ids": ids, "action": "exclude"})

    assert _enviar(anon, sv["slug"], visitor="v").status_code == 201


def test_el_limite_es_por_persona_no_por_encuesta():
    c = new_client()
    register(c)
    sv = _publicada(c, max_attempts=1)
    anon = new_client()
    for i in range(4):
        r = _enviar(anon, sv["slug"], nom=f"P{i}", mail=f"p{i}@example.com", visitor=f"nav-{i}")
        assert r.status_code == 201, r.text
    assert c.get(f"/api/v1/survey/surveys/{sv['id']}/summary").json()["total_responses"] == 4


def test_lista_de_invitados_cuenta_por_codigo():
    """Con lista, el límite es infalible: lo da el código que emitió el servidor."""
    c = new_client()
    register(c)
    sv = _publicada(c, max_attempts=1, access_mode="list")
    sid = sv["id"]
    r = c.post(
        f"/api/v1/survey/surveys/{sid}/invitees",
        json={"invitees": [{"email": "alu@example.com"}]},
    )
    assert r.status_code in (200, 201), r.text
    inv = c.get(f"/api/v1/survey/surveys/{sid}/invitees").json()[0]

    anon = new_client()
    acc = anon.post(
        f"/api/v1/survey/public/{sv['slug']}/access",
        json={"email": "alu@example.com", "code": inv["code"]},
    )
    assert acc.status_code == 200, acc.text
    token = acc.json()["access_token"]

    def enviar(visitor):
        return anon.post(
            f"/api/v1/survey/public/{sv['slug']}/submit",
            json={"answers": {"nom": "Alu"}, "access_token": token, "meta": {"visitor_id": visitor}},
        )

    assert enviar("nav-1").status_code == 201
    # Cambiar de navegador no sirve: el código es el mismo.
    assert enviar("nav-2").status_code == 409
