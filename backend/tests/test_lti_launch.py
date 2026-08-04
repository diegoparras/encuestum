"""Flujo de lanzamiento: login init, launch, y acceso a la encuesta sin PIN."""

import time
import uuid
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.lti.state import LTI_STATE_COOKIE, LTI_STATE_PURPOSE, STATE_TTL_S
from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, LtiResourceLink, Survey
from app.security import create_purpose_token

ISSUER = "https://moodle.test"
CLIENT_ID = "cid-1"

# Las cookies del flujo LTI van `Secure`, así que el TestClient tiene que
# hablar HTTPS o el cookiejar de httpx las descarta silenciosamente (ver
# finding 1 del review de Task 4).
def _client() -> TestClient:
    return TestClient(app, base_url="https://testserver")


@pytest.fixture
def platform_pem():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


@pytest_asyncio.fixture
async def registered(platform_pem, monkeypatch, db_session):
    """Deja en la base una plataforma, una encuesta con PIN y su resource link."""
    public = serialization.load_pem_private_key(platform_pem.encode(), password=None).public_key()

    async def fake_jwks(url, kid=None):
        import json

        from jwt.algorithms import RSAAlgorithm

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "pk"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake_jwks)

    async with db_session() as session:
        from sqlmodel import select as _select

        # La base es compartida entre tests dentro de la misma sesión de
        # pytest: si un test anterior ya dejó una plataforma con este mismo
        # (issuer, client_id), hay que limpiarla antes de volver a insertar
        # o la unique constraint la rechaza.
        previa = (
            await session.scalars(
                _select(LtiPlatform).where(
                    LtiPlatform.issuer == ISSUER, LtiPlatform.client_id == CLIENT_ID
                )
            )
        ).first()
        if previa is not None:
            viejos_links = (
                await session.scalars(
                    _select(LtiResourceLink).where(LtiResourceLink.platform_id == previa.id)
                )
            ).all()
            for viejo in viejos_links:
                await session.delete(viejo)
            await session.delete(previa)
            await session.commit()

        org_id = uuid.uuid4()
        survey = Survey(org_id=org_id, title="Examen", status="published", access_mode="pin",
                        access_pin="1234", json_schema={"pages": []})
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER}/mod/lti/token.php",
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        link = LtiResourceLink(platform_id=platform.id, resource_link_id="rl-1",
                               context_id="course-9", survey_id=survey.id)
        session.add(link)
        await session.commit()
        return {"platform": platform, "survey": survey, "link": link, "pem": platform_pem}


def _id_token(pem, nonce, **over):
    now = int(time.time())
    claims = {
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "u-42", "exp": now + 300, "iat": now,
        "nonce": nonce, "email": "alumno@escuela.test", "name": "Ana Alumna",
        CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: "1",
        CLAIM["TARGET_LINK_URI"]: "https://encuestum.test/lti/launch",
        CLAIM["RESOURCE_LINK"]: {"id": "rl-1"},
        CLAIM["CONTEXT"]: {"id": "course-9", "title": "Historia"},
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    }
    claims.update(over)
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "pk"})


@pytest.mark.asyncio
async def test_login_redirige_al_authorize_de_la_plataforma(lti_on, registered):
    client = _client()
    r = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["response_type"] == ["id_token"]
    assert q["response_mode"] == ["form_post"]
    assert q["scope"] == ["openid"]
    assert q["client_id"] == [CLIENT_ID]
    assert q["login_hint"] == ["42"]
    assert q["state"] and q["nonce"]
    assert "enc_lti_state" in r.cookies


@pytest.mark.asyncio
async def test_launch_valido_redirige_a_la_encuesta_y_siembra_la_cookie(lti_on, registered):
    client = _client()
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post(
        "/lti/launch",
        data={"id_token": token, "state": q["state"][0]},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"] == f"/s/{registered['survey'].slug}"
    assert "enc_lti" in r.cookies


@pytest.mark.asyncio
async def test_launch_con_state_ajeno_es_rechazado(lti_on, registered):
    client = _client()
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post("/lti/launch", data={"id_token": token, "state": "otro-state"},
                    follow_redirects=False)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_la_cookie_lti_saltea_el_pin_de_la_encuesta(lti_on, registered):
    client = _client()
    slug = registered["survey"].slug

    # Sin cookie LTI, la encuesta con PIN no entrega su contenido: viene gated.
    sin = _client().get(f"/api/v1/survey/public/{slug}")
    assert sin.json()["gated"] is True

    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)

    # Con la cookie puesta, la encuesta ya no viene gated.
    con = client.get(f"/api/v1/survey/public/{slug}")
    assert con.json()["gated"] is False

    # Con la cookie puesta, se puede enviar sin access_token.
    r = client.post(f"/api/v1/survey/public/{slug}/submit",
                    json={"answers": {"q1": "hola"}, "completed": True})
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_cookie_de_login_lleva_secure_pese_a_cookie_secure_apagado(lti_on, registered):
    """Las cookies LTI viajan en un iframe cross-site: SameSite=None exige
    Secure sí o sí, sin importar ENCUESTUM_COOKIE_SECURE (que en el entorno de
    tests está apagado — ver conftest.py)."""
    from app.config import get_settings

    assert get_settings().cookie_secure is False  # documenta la condición que este test guarda

    client = _client()
    r = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    set_cookie = r.headers.get("set-cookie", "").lower()
    assert "secure" in set_cookie
    assert "samesite=none" in set_cookie


@pytest.mark.asyncio
async def test_borrado_de_cookie_de_state_lleva_samesite_none_y_secure(lti_on, registered):
    """`/lti/launch` responde dentro de un form-POST cross-site: si el borrado
    de enc_lti_state no lleva los mismos atributos con los que se la escribió
    (SameSite=None; Secure), el navegador ignora el Set-Cookie y la cookie de
    state sobrevive, dejando el par (state, nonce) reutilizable durante toda
    la ventana de STATE_TTL_S."""
    client = _client()
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post(
        "/lti/launch",
        data={"id_token": token, "state": q["state"][0]},
        follow_redirects=False,
    )
    borrado = [c for c in r.headers.get_list("set-cookie") if c.startswith(f"{LTI_STATE_COOKIE}=")]
    assert borrado, "la respuesta de /lti/launch debe borrar la cookie de state"
    header = borrado[0].lower()
    assert "samesite=none" in header
    assert "secure" in header


@pytest.mark.asyncio
async def test_launch_sin_cookie_de_state_es_rechazado(lti_on, registered, monkeypatch):
    """Sin pasar por /lti/login no hay cookie enc_lti_state: el contrato es
    que ese `None` degradado nunca llegue a validate_launch, sino que se
    rechace acá con 400 *antes* de intentar validar el id_token.

    Un 400 solo no alcanza para probar eso: un nonce rechazado dentro de
    validate_launch también da 400, y con el `except (KeyError, TypeError,
    ValueError)` alrededor del parseo del UUID, hasta borrar el guard entero
    del estado seguiría dando 400 (por el KeyError de `stored["platform_id"]`
    sobre un `stored` None-ish). Por eso monkeypatcheamos validate_launch para
    que falle el test si se llega a invocar: así se distingue "rechazado
    antes de validar" de "rechazado durante la validación"."""
    from app.routers import lti as lti_router

    async def _no_deberia_llamarse(*args, **kwargs):
        pytest.fail("validate_launch no debería llamarse sin cookie de state.")

    monkeypatch.setattr(lti_router, "validate_launch", _no_deberia_llamarse)

    client = _client()
    token = _id_token(registered["pem"], nonce="cualquier-nonce")
    r = client.post(
        "/lti/launch",
        data={"id_token": token, "state": "algun-state"},
        follow_redirects=False,
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_cookie_lti_de_una_encuesta_no_sirve_para_otra(lti_on, registered, db_session):
    """El slug guardado en la cookie LTI es lo único que impide reusarla en
    otra encuesta: hay que probarlo."""
    client = _client()
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)

    # Otra encuesta con PIN, sin ningún resource link LTI que la ate.
    from app.models import Survey

    async with db_session() as session:
        otra = Survey(org_id=registered["survey"].org_id, title="Otra", status="published",
                      access_mode="pin", access_pin="9999", json_schema={"pages": []})
        session.add(otra)
        await session.commit()
        await session.refresh(otra)
        otro_slug = otra.slug

    # La cookie LTI de la encuesta A no debe saltear el PIN de la encuesta B.
    gated = client.get(f"/api/v1/survey/public/{otro_slug}").json()["gated"]
    assert gated is True

    r = client.post(f"/api/v1/survey/public/{otro_slug}/submit",
                    json={"answers": {"q1": "hola"}, "completed": True})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_login_ignora_target_link_uri_ajeno(lti_on, registered):
    """`target_link_uri` lo manda el llamador; si no coincide con nuestra
    propia URL de /lti/launch, no hay que echoarlo tal cual a la plataforma —
    la validación del redirect_uri no puede delegarse por completo a Moodle.

    El valor esperado sale de `public_base_url` (el mismo que usa el resto de
    la app para armar links absolutos), no del host con el que habló el
    TestClient — ver `test_login_usa_public_base_url_no_el_host_del_request`
    para el caso que de verdad prueba esa distinción."""
    from app.config import get_settings

    client = _client()
    r = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://evil.example/steal"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["redirect_uri"] == [f"{get_settings().public_base_url}/lti/launch"]


@pytest.fixture
def public_url_pinned(monkeypatch):
    """Fija ENCUESTUM_PUBLIC_URL a un origen https distinguible (y distinto del
    host con el que habla el TestClient) y limpia el cache de get_settings,
    siguiendo el mismo patrón que el fixture `lti_on`."""
    from app.config import get_settings

    url = "https://canonico.encuestum.example"
    monkeypatch.setenv("ENCUESTUM_PUBLIC_URL", url)
    get_settings.cache_clear()
    yield url
    monkeypatch.delenv("ENCUESTUM_PUBLIC_URL", raising=False)
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_login_usa_public_base_url_no_el_host_del_request(
    lti_on, registered, public_url_pinned
):
    """`redirect_uri` tiene que salir de `ENCUESTUM_PUBLIC_URL` (el origen
    https público configurado), no de `request.url_for`: en el despliegue
    documentado TLS termina en el proxy, nginx habla http hacia adentro del
    contenedor y `X-Forwarded-Proto` llega en `http` (es el scheme de la
    conexión a nginx, no la del cliente original) — así que `request.url_for`
    calcularía `http://...`. Moodle rechazaría ese redirect_uri por no
    coincidir con el registrado, y aunque no lo hiciera, un form-POST a una
    URL http no adjuntaría la cookie `Secure` de state.

    Lo probamos con un host de request bien distinto del configurado, para
    asegurarnos de que el host de la request no se cuela por ningún lado."""
    client = TestClient(app, base_url="https://otro-host-cualquiera.test")
    r = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["redirect_uri"] == [f"{public_url_pinned}/lti/launch"]


@pytest.mark.asyncio
async def test_launch_con_platform_id_invalido_en_cookie_da_400(lti_on, registered):
    """Un `platform_id` corrupto en el estado guardado (cookie manipulada o
    dato viejo) debe dar el mismo 400 que cualquier otro estado inválido, no
    un 500."""
    client = _client()
    cookie = create_purpose_token(
        LTI_STATE_PURPOSE,
        {"state": "s1", "nonce": "n1", "platform_id": "no-es-un-uuid"},
        ttl_minutes=STATE_TTL_S / 60,
    )
    client.cookies.set(LTI_STATE_COOKIE, cookie)
    r = client.post(
        "/lti/launch",
        data={"id_token": "irrelevante-no-debería-ni-mirarse", "state": "s1"},
        follow_redirects=False,
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_launch_con_encuesta_de_otra_org_es_rechazado(lti_on, registered, db_session):
    """Defensa en profundidad: si el resource link apunta a una encuesta de
    otra organización que la de la plataforma lanzadora (un dato mal cargado,
    no algo alcanzable por el flujo normal), el lanzamiento debe tratarse
    igual que "esta actividad no tiene encuesta asignada", no colar acceso
    cross-tenant."""
    async with db_session() as session:
        platform = await session.get(LtiPlatform, registered["platform"].id)
        platform.org_id = uuid.uuid4()
        session.add(platform)
        await session.commit()

    client = _client()
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    r = client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                    follow_redirects=False)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_la_respuesta_queda_atribuida_al_alumno(lti_on, registered, db_session):
    from sqlmodel import select

    from app.models import SurveyResponse

    client = _client()
    slug = registered["survey"].slug
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)
    client.post(f"/api/v1/survey/public/{slug}/submit",
                json={"answers": {"q1": "hola"}, "completed": True})

    async with db_session() as session:
        r = (await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == registered["survey"].id)
        )).first()
        assert r.lti_sub == "u-42"
        assert r.lti_link_id == registered["link"].id
        assert r.respondent_email == "alumno@escuela.test"


# ── Important 4: resolución determinística de plataforma sin client_id ──────
#
# `_platform_for` tomaba `.first()` de una consulta sin ORDER BY cuando el
# login no traía `client_id` para desambiguar. Moodle sí lo manda -- así que
# es latente en el flujo normal -- pero es el mecanismo que agrava el
# squatting de issuer (ítem deferred, no se resuelve acá): una fila squatting
# podía ganar la selección tan fácil como cualquier otra.


@pytest.mark.asyncio
async def test_platform_for_es_deterministico_sin_client_id(lti_on, db_session, monkeypatch):
    """Con dos filas para el mismo issuer y sin `client_id` para desambiguar,
    la selección tiene que ser siempre la misma fila (la más vieja) -- y
    avisar por log, porque la ambigüedad en sí no se resuelve acá."""
    from datetime import datetime, timedelta, timezone

    from sqlmodel import select as _select

    from app.routers import lti as lti_router
    from app.routers.lti import _platform_for

    issuer = "https://moodle.ambiguo"

    async with db_session() as session:
        previas = (
            await session.scalars(_select(LtiPlatform).where(LtiPlatform.issuer == issuer))
        ).all()
        for p in previas:
            await session.delete(p)
        await session.commit()

        vieja = LtiPlatform(
            issuer=issuer, client_id="cid-ambiguo-a", deployment_ids=["1"],
            auth_login_url=f"{issuer}/a1", auth_token_url=f"{issuer}/t1",
            jwks_url=f"{issuer}/j1",
            created_at=datetime.now(timezone.utc) - timedelta(minutes=10),
        )
        nueva = LtiPlatform(
            issuer=issuer, client_id="cid-ambiguo-b", deployment_ids=["1"],
            auth_login_url=f"{issuer}/a2", auth_token_url=f"{issuer}/t2",
            jwks_url=f"{issuer}/j2",
            created_at=datetime.now(timezone.utc),
        )
        session.add(vieja)
        session.add(nueva)
        await session.commit()
        vieja_id = vieja.id

    logueado = {}
    monkeypatch.setattr(
        lti_router.LOGGER, "warning",
        lambda msg, *args, **kwargs: logueado.update(msg=msg % args if args else msg),
    )

    async with db_session() as session:
        elegida = await _platform_for(session, issuer, None)
    async with db_session() as session:
        elegida_otra_vez = await _platform_for(session, issuer, None)

    # Determinístico: la misma fila (la más vieja) las dos veces.
    assert elegida.id == vieja_id
    assert elegida_otra_vez.id == vieja_id
    # Y avisa por log -- sin esto, la ambigüedad queda invisible para un
    # admin mirando por qué un lanzamiento fue a la org equivocada.
    assert issuer in logueado.get("msg", "")


@pytest.mark.asyncio
async def test_platform_for_no_avisa_cuando_client_id_desambigua(
    lti_on, registered, db_session, monkeypatch
):
    """Con `client_id` (lo normal: Moodle lo manda en el login initiation), la
    consulta ya filtra a una sola fila -- no hay ambigüedad que loguear."""
    from app.routers import lti as lti_router
    from app.routers.lti import _platform_for

    logueado = []
    monkeypatch.setattr(lti_router.LOGGER, "warning", lambda *a, **kw: logueado.append(a))

    async with db_session() as session:
        elegida = await _platform_for(session, ISSUER, CLIENT_ID)

    assert elegida.id == registered["platform"].id
    assert logueado == []


# ── Minor: alta de LtiUser sobrevive a una carrera de inserción ─────────────
#
# `LtiUser` se creaba sin manejo de `IntegrityError`, a diferencia de las
# otras dos carreras de inserción de esta rama (`get_tool_key` en
# `app/lti/keys.py`, y la creación de `LtiResourceLink` en el hallazgo
# crítico). Dos tabs del mismo alumno lanzando casi a la vez -> 500.


@pytest.mark.asyncio
async def test_upsert_lti_user_sobrevive_a_una_carrera_de_insercion(
    lti_on, registered, db_session, monkeypatch
):
    """Mismo patrón de prueba que
    `test_get_tool_key_sobrevive_a_una_carrera_de_insercion`
    (`test_lti_jwks.py`): se simula el resultado de la carrera de forma
    determinística, sin concurrencia real."""
    from sqlalchemy.exc import IntegrityError
    from sqlmodel import select

    from app.models import LtiUser
    from app.routers.lti import _upsert_lti_user

    platform = registered["platform"]
    claims = {
        "sub": "u-race",
        "email": "de-este-lanzamiento@escuela.test",
        "name": "Este Lanzamiento",
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    }

    async with db_session() as session:
        real_commit = session.commit
        state = {"first_call": True}

        async def fake_commit():
            if state["first_call"]:
                state["first_call"] = False
                # Soltamos nuestra transacción antes de que la "otra tab"
                # inserte y confirme -- misma técnica que el test de
                # get_tool_key, sin necesidad de concurrencia real.
                await session.rollback()
                async with db_session() as other:
                    other.add(
                        LtiUser(
                            platform_id=platform.id, sub="u-race",
                            email="de-la-otra-tab@escuela.test", name="Otra Tab", roles=[],
                        )
                    )
                    await other.commit()
                raise IntegrityError(
                    "insert", {},
                    Exception("UNIQUE constraint failed: lti_users.platform_id, lti_users.sub"),
                )
            await real_commit()

        monkeypatch.setattr(session, "commit", fake_commit)
        user = await _upsert_lti_user(session, platform, claims)

    # La fila que "ganó" la carrera (la de la otra tab), pero actualizada con
    # los datos de ESTE lanzamiento tras releerla -- no se pierden.
    assert user.email == "de-este-lanzamiento@escuela.test"

    async with db_session() as session:
        filas = (
            await session.scalars(
                select(LtiUser).where(LtiUser.platform_id == platform.id, LtiUser.sub == "u-race")
            )
        ).all()
        # Una sola fila -- no dos usuarios en circulación para el mismo sub.
        assert len(filas) == 1
        assert filas[0].email == "de-este-lanzamiento@escuela.test"
