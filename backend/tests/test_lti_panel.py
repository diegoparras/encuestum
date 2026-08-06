"""Panel de conexión con Moodle: modelo, endpoints y aislamiento entre orgs."""

import time
import uuid
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from sqlmodel import select

from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, LtiResourceLink, Survey
from tests.conftest import crear_org


@pytest.mark.asyncio
async def test_el_vinculo_guarda_titulo_de_curso_y_anonimato(db_session):
    # No persiste nada -- sólo confirma que el modelo en memoria acepta los
    # campos nuevos. El viaje completo por la base está en el test de
    # roundtrip más abajo.
    async with db_session():
        link = LtiResourceLink(
            platform_id=uuid.uuid4(),
            resource_link_id="rl-1",
            context_id="27",
            context_title="Historia 3°B",
            survey_id=uuid.uuid4(),
            anonymous=True,
        )
        assert link.context_title == "Historia 3°B"
        assert link.anonymous is True


@pytest.mark.asyncio
async def test_anonimato_es_falso_por_defecto(db_session):
    async with db_session():
        link = LtiResourceLink(
            platform_id=uuid.uuid4(),
            resource_link_id="rl-2",
            survey_id=uuid.uuid4(),
        )
        assert link.anonymous is False
        assert link.context_title is None


@pytest.mark.asyncio
async def test_el_vinculo_persiste_titulo_y_anonimato_en_la_base(db_session):
    """Los dos tests de arriba sólo prueban que el modelo en memoria acepta
    los campos -- no que las columnas existan de verdad en la base tras la
    migración 0020. Este test hace el viaje completo: INSERT, expira la
    identity map, y vuelve a leer desde la base."""
    async with db_session() as session:
        platform = LtiPlatform(
            issuer="https://moodle.panel-roundtrip",
            client_id="cid-panel-roundtrip",
            deployment_ids=["1"],
            auth_login_url="https://moodle.panel-roundtrip/mod/lti/auth.php",
            auth_token_url="https://moodle.panel-roundtrip/mod/lti/token.php",
            jwks_url="https://moodle.panel-roundtrip/mod/lti/certs.php",
        )
        survey = Survey(
            org_id=await crear_org(session, "Roundtrip"), title="Encuesta roundtrip",
            status="published", json_schema={"pages": []},
        )
        session.add(platform)
        session.add(survey)
        await session.commit()

        link = LtiResourceLink(
            platform_id=platform.id,
            resource_link_id="rl-roundtrip",
            context_title="Historia 3°B",
            survey_id=survey.id,
            anonymous=True,
        )
        session.add(link)
        await session.commit()
        session.expunge_all()

        got = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == platform.id,
                    LtiResourceLink.resource_link_id == "rl-roundtrip",
                )
            )
        ).first()
        assert got is not None
        assert got.context_title == "Historia 3°B"
        assert got.anonymous is True


@pytest.mark.asyncio
async def test_anonimato_default_de_la_base_es_falso(db_session):
    """El `server_default` de la migración importa para filas insertadas sin
    pasar por el ORM (o por un `INSERT` que no mande la columna) -- acá se
    verifica insertando vía el modelo sin fijar `anonymous` y confirmando el
    valor que vuelve de la base, no sólo el default de Python."""
    async with db_session() as session:
        platform = LtiPlatform(
            issuer="https://moodle.panel-default",
            client_id="cid-panel-default",
            deployment_ids=["1"],
            auth_login_url="https://moodle.panel-default/mod/lti/auth.php",
            auth_token_url="https://moodle.panel-default/mod/lti/token.php",
            jwks_url="https://moodle.panel-default/mod/lti/certs.php",
        )
        survey = Survey(
            org_id=await crear_org(session, "Default"), title="Encuesta default",
            status="published", json_schema={"pages": []},
        )
        session.add(platform)
        session.add(survey)
        await session.commit()

        link = LtiResourceLink(
            platform_id=platform.id,
            resource_link_id="rl-default",
            survey_id=survey.id,
        )
        session.add(link)
        await session.commit()
        session.expunge_all()

        got = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == platform.id,
                    LtiResourceLink.resource_link_id == "rl-default",
                )
            )
        ).first()
        assert got is not None
        assert got.anonymous is False
        assert got.context_title is None


@pytest.mark.asyncio
async def test_deliver_no_publica_nota_si_el_vinculo_es_anonimo(monkeypatch, lti_on, db_session):
    """Un vínculo anónimo no debe generar NINGUNA llamada saliente al LMS."""
    import httpx

    from app.lti.ags import _deliver
    from app.models import LtiPlatform, Survey, SurveyResponse

    llamadas = []

    async def registrar(self, url, **kw):
        llamadas.append(url)
        return httpx.Response(200, json={}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", registrar)
    monkeypatch.setattr(httpx.AsyncClient, "get", registrar)

    async with db_session() as session:
        plataforma = LtiPlatform(
            issuer="https://moodle.anon", client_id="cid", deployment_ids=["1"],
            auth_login_url="https://moodle.anon/a", auth_token_url="https://moodle.anon/t",
            jwks_url="https://moodle.anon/j", org_id=await crear_org(session, "Anon"),
        )
        session.add(plataforma)
        await session.commit()
        encuesta = Survey(org_id=plataforma.org_id, title="Clima", json_schema={})
        session.add(encuesta)
        await session.commit()
        link = LtiResourceLink(
            platform_id=plataforma.id, resource_link_id="rl-anon",
            survey_id=encuesta.id, lineitem_url="https://moodle.anon/li", anonymous=True,
        )
        session.add(link)
        await session.commit()
        r = SurveyResponse(
            survey_id=encuesta.id, answers={}, score=8.0, max_score=10.0,
            lti_link_id=link.id, lti_sub="u-1",
        )
        session.add(r)
        await session.commit()
        rid = r.id

    await _deliver(rid)
    assert llamadas == [], f"un vínculo anónimo no debe llamar al LMS, llamó a {llamadas}"


@pytest.mark.asyncio
async def test_el_listado_solo_muestra_plataformas_de_la_organizacion(lti_on, db_session):
    """El aislamiento entre organizaciones es la propiedad crítica de este panel."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.models import LtiPlatform

    cliente = TestClient(app, base_url="https://testserver")
    cliente.post("/api/v1/auth/register", json={
        "email": "duenio@escuela-panel.example.com", "password": "Clave#2026segura",
        "name": "Dueño", "org_name": "Escuela A"})
    mia = cliente.get("/api/v1/auth/me").json()["orgs"][0]["id"]

    async with db_session() as session:
        for org, issuer in ((uuid.UUID(mia), "https://moodle.mio"),
                            (await crear_org(session, "Escuela ajena"),
                             "https://moodle.ajeno")):
            session.add(LtiPlatform(
                issuer=issuer, client_id=f"cid-{issuer[-4:]}", deployment_ids=["1"],
                auth_login_url=f"{issuer}/a", auth_token_url=f"{issuer}/t",
                jwks_url=f"{issuer}/j", org_id=org))
        await session.commit()

    r = cliente.get("/api/v1/lti/platforms")
    assert r.status_code == 200
    issuers = [p["issuer"] for p in r.json()]
    assert "https://moodle.mio" in issuers
    assert "https://moodle.ajeno" not in issuers, "fuga entre organizaciones"


@pytest.mark.asyncio
async def test_desconectar_no_borra_las_respuestas(lti_on, db_session):
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.main import app
    from app.models import LtiPlatform, Survey, SurveyResponse

    cliente = TestClient(app, base_url="https://testserver")
    cliente.post("/api/v1/auth/register", json={
        "email": "otro@escuela-panel.example.com", "password": "Clave#2026segura",
        "name": "Otro", "org_name": "Escuela B"})
    org = uuid.UUID(cliente.get("/api/v1/auth/me").json()["orgs"][0]["id"])

    async with db_session() as session:
        p = LtiPlatform(issuer="https://moodle.borrar", client_id="cid-b",
                        deployment_ids=["1"], auth_login_url="https://moodle.borrar/a",
                        auth_token_url="https://moodle.borrar/t",
                        jwks_url="https://moodle.borrar/j", org_id=org)
        session.add(p)
        s = Survey(org_id=org, title="Con respuestas", json_schema={})
        session.add(s)
        await session.commit()
        link = LtiResourceLink(platform_id=p.id, resource_link_id="rl-b", survey_id=s.id)
        session.add(link)
        await session.commit()
        session.add(SurveyResponse(survey_id=s.id, answers={"q": "a"},
                                   lti_link_id=link.id, lti_sub="u-9"))
        await session.commit()
        pid, sid = str(p.id), s.id

    assert cliente.delete(f"/api/v1/lti/platforms/{pid}").status_code == 204

    async with db_session() as session:
        quedan = (await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == sid))).all()
        assert len(quedan) == 1, "desconectar no debe borrar respuestas"
        assert quedan[0].lti_link_id is None, "el vínculo debe quedar en nulo"


@pytest.mark.asyncio
async def test_no_se_puede_desconectar_una_plataforma_ajena(lti_on, db_session):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.models import LtiPlatform

    cliente = TestClient(app, base_url="https://testserver")
    cliente.post("/api/v1/auth/register", json={
        "email": "tercero@escuela-panel.example.com", "password": "Clave#2026segura",
        "name": "Tercero", "org_name": "Escuela C"})

    async with db_session() as session:
        ajena = LtiPlatform(issuer="https://moodle.otro", client_id="cid-c",
                            deployment_ids=["1"], auth_login_url="https://moodle.otro/a",
                            auth_token_url="https://moodle.otro/t",
                            jwks_url="https://moodle.otro/j",
                            org_id=await crear_org(session, "Escuela ajena D"))
        session.add(ajena)
        await session.commit()
        pid = str(ajena.id)

    assert cliente.delete(f"/api/v1/lti/platforms/{pid}").status_code == 404


@pytest.mark.asyncio
async def test_no_se_pueden_ver_los_vinculos_de_una_plataforma_ajena(lti_on, db_session):
    """El listado filtra por organización; el detalle tiene que filtrar igual.

    Sin este test, cambiar `_plataforma_de_la_org` por un `session.get` en
    `list_platform_links` deja la suite en verde mientras el endpoint sirve
    títulos de encuestas, nombres de curso e identificadores de actividad de
    otra organización a cualquiera que adivine un UUID."""
    from fastapi.testclient import TestClient

    from app.main import app

    cliente = TestClient(app, base_url="https://testserver")
    cliente.post("/api/v1/auth/register", json={
        "email": "cuarto@escuela-panel.example.com", "password": "Clave#2026segura",
        "name": "Cuarto", "org_name": "Escuela E"})

    async with db_session() as session:
        ajena = LtiPlatform(issuer="https://moodle.espia", client_id="cid-e",
                            deployment_ids=["1"], auth_login_url="https://moodle.espia/a",
                            auth_token_url="https://moodle.espia/t",
                            jwks_url="https://moodle.espia/j",
                            org_id=await crear_org(session, "Escuela ajena E"))
        session.add(ajena)
        await session.commit()
        pid = str(ajena.id)

    r = cliente.get(f"/api/v1/lti/platforms/{pid}/links")
    assert r.status_code == 404, "una plataforma ajena no debe existir para esta org"


@pytest.mark.asyncio
async def test_los_contadores_incluyen_los_vinculos_sin_respuestas(lti_on, db_session):
    """Los conteos salen de consultas agrupadas, y un `GROUP BY` descarta la
    fila que no tiene nada que contar. Un vínculo sin respuestas tiene que
    aparecer igual, con cero y sin fecha -- no faltar de la lista ni traer
    claves ausentes."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.models import LtiUser, SurveyResponse

    cliente = TestClient(app, base_url="https://testserver")
    cliente.post("/api/v1/auth/register", json={
        "email": "quinto@escuela-panel.example.com", "password": "Clave#2026segura",
        "name": "Quinto", "org_name": "Escuela F"})
    org = uuid.UUID(cliente.get("/api/v1/auth/me").json()["orgs"][0]["id"])

    async with db_session() as session:
        p = LtiPlatform(issuer="https://moodle.conteo", client_id="cid-f",
                        deployment_ids=["1"], auth_login_url="https://moodle.conteo/a",
                        auth_token_url="https://moodle.conteo/t",
                        jwks_url="https://moodle.conteo/j", org_id=org)
        session.add(p)
        s = Survey(org_id=org, title="Encuesta contada", json_schema={})
        session.add(s)
        await session.commit()
        con = LtiResourceLink(platform_id=p.id, resource_link_id="rl-con",
                              survey_id=s.id, context_title="Historia 3°B")
        sin = LtiResourceLink(platform_id=p.id, resource_link_id="rl-sin", survey_id=s.id)
        session.add(con)
        session.add(sin)
        # Un LtiUser para comprobar que desconectar también borra la identidad
        # cacheada del alumno en el LMS, no sólo los vínculos.
        session.add(LtiUser(platform_id=p.id, sub="u-conteo",
                            email="alumno@escuela-panel.example.com"))
        await session.commit()
        for _ in range(2):
            session.add(SurveyResponse(survey_id=s.id, answers={"q": "a"},
                                       lti_link_id=con.id, lti_sub="u-conteo"))
        await session.commit()
        pid = str(p.id)

    lista = cliente.get("/api/v1/lti/platforms").json()
    fila = next(x for x in lista if x["issuer"] == "https://moodle.conteo")
    assert fila["activities"] == 2, "los dos vínculos cuentan, tengan respuestas o no"
    assert fila["responses"] == 2

    detalle = cliente.get(f"/api/v1/lti/platforms/{pid}/links").json()
    por_rl = {d["resource_link_id"]: d for d in detalle}
    assert set(por_rl) == {"rl-con", "rl-sin"}, "el vínculo sin respuestas no debe faltar"
    assert por_rl["rl-con"]["responses"] == 2
    assert por_rl["rl-con"]["last_response_at"] is not None
    assert por_rl["rl-con"]["context_title"] == "Historia 3°B"
    assert por_rl["rl-sin"]["responses"] == 0
    assert por_rl["rl-sin"]["last_response_at"] is None

    assert cliente.delete(f"/api/v1/lti/platforms/{pid}").status_code == 204

    async with db_session() as session:
        usuarios = (await session.scalars(
            select(LtiUser).where(LtiUser.platform_id == uuid.UUID(pid)))).all()
        assert usuarios == [], "desconectar debe borrar la identidad cacheada del LMS"


def test_config_expone_si_lti_esta_activo(lti_on):
    from fastapi.testclient import TestClient

    from app.main import app

    d = TestClient(app, base_url="https://testserver").get("/api/v1/auth/config").json()
    assert d["lti_enabled"] is True


# ── La actividad que quedó sin encuesta ──────────────────────────────────────
#
# El plugin pone "Encuestum" en el selector de actividades de Moodle. Un docente
# lo elige, Moodle lo lleva al formulario, y si guarda SIN tocar "Seleccionar
# contenido" la actividad queda sin encuesta: no hay `custom.survey_id` en el
# lanzamiento y no hay `LtiResourceLink`. Hasta acá eso era un 404 para todos.
# Ahora el docente ve el selector; el alumno sigue viendo el 404 -- y esa
# bifurcación es la propiedad crítica de este bloque: el vínculo se crea de
# NUESTRO lado, así que si un alumno llegara al selector, la encuesta que
# eligiera quedaría atada a la actividad de todo el curso, sin ningún error
# visible para nadie.

ISSUER_SIN = "https://moodle.sin-encuesta"
CLIENT_ID_SIN = "cid-sin-encuesta"
NS_CONTEXTO = "http://purl.imsglobal.org/vocab/lis/v2/membership"


def _cliente() -> TestClient:
    """Las cookies del flujo LTI van `Secure`: el TestClient tiene que hablar
    HTTPS o el cookiejar de httpx las descarta en silencio (mismo patrón que
    test_lti_launch.py y test_lti_deeplink.py)."""
    return TestClient(app, base_url="https://testserver")


@pytest_asyncio.fixture
async def sin_encuesta(monkeypatch, db_session):
    """Plataforma registrada y encuesta publicada, pero SIN vínculo: la
    actividad que el docente guardó sin pasar por "Seleccionar contenido"."""
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public = serialization.load_pem_private_key(pem.encode(), password=None).public_key()

    async def fake_jwks(url, kid=None):
        import json

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "pk"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake_jwks)

    async with db_session() as session:
        # La base es compartida entre tests dentro de la misma corrida de
        # pytest (mismo patrón que test_lti_deeplink.py).
        previa = (
            await session.scalars(
                select(LtiPlatform).where(
                    LtiPlatform.issuer == ISSUER_SIN, LtiPlatform.client_id == CLIENT_ID_SIN
                )
            )
        ).first()
        if previa is not None:
            await session.delete(previa)
            await session.commit()

        org_id = await crear_org(session, "Escuela sin encuesta asignada")
        survey = Survey(org_id=org_id, title="Encuesta del selector", status="published",
                        json_schema={"pages": []})
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER_SIN, client_id=CLIENT_ID_SIN, deployment_ids=["1"],
            auth_login_url=f"{ISSUER_SIN}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER_SIN}/mod/lti/token.php",
            jwks_url=f"{ISSUER_SIN}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        return {"pem": pem, "platform": platform, "survey": survey, "org_id": org_id}


def _id_token_sin_custom(pem, nonce, resource_link_id, roles):
    """Un `LtiResourceLinkRequest` normal, SIN el claim `custom`: es lo que
    manda Moodle cuando la actividad nunca pasó por deep linking."""
    now = int(time.time())
    return jwt.encode(
        {
            "iss": ISSUER_SIN, "aud": CLIENT_ID_SIN, "sub": f"u-{uuid.uuid4().hex[:8]}",
            "exp": now + 300, "iat": now, "nonce": nonce,
            "email": "persona@escuela.test", "name": "Quien Entra",
            CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
            CLAIM["VERSION"]: "1.3.0",
            CLAIM["DEPLOYMENT_ID"]: "1",
            CLAIM["TARGET_LINK_URI"]: "https://encuestum.test/lti/launch",
            CLAIM["RESOURCE_LINK"]: {"id": resource_link_id},
            CLAIM["CONTEXT"]: {"id": "course-sin", "title": "Historia 3°B"},
            CLAIM["ROLES"]: roles,
        },
        pem,
        algorithm="RS256",
        headers={"kid": "pk"},
    )


def _lanzar(client, setup, resource_link_id, roles):
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER_SIN, "client_id": CLIENT_ID_SIN, "login_hint": "1",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token_sin_custom(setup["pem"], q["nonce"][0], resource_link_id, roles)
    return client.post(
        "/lti/launch",
        data={"id_token": token, "state": q["state"][0]},
        follow_redirects=False,
    )


def _token_de_vinculo(respuesta) -> str:
    """El `link=` del redirect al selector."""
    return parse_qs(urlparse(respuesta.headers["location"]).query)["link"][0]


@pytest.fixture
def registered_sin_link(sin_encuesta):
    """Lanza la actividad sin encuesta con los roles pedidos y devuelve
    `(status, location-o-cuerpo)`."""
    def _lanzamiento(rol: str | None = None, roles: list | None = None):
        if roles is None:
            roles = [f"{NS_CONTEXTO}#{rol}"]
        rl = f"rl-{uuid.uuid4().hex[:8]}"
        r = _lanzar(_cliente(), sin_encuesta, rl, roles)
        return r.status_code, (r.headers.get("location") if r.status_code == 302 else r.text)

    return _lanzamiento


@pytest.mark.asyncio
async def test_un_docente_sin_encuesta_asignada_ve_el_selector(lti_on, registered_sin_link):
    """Sin esto, un docente que guarda la actividad sin usar 'Seleccionar
    contenido' deja a sus alumnos con un 404 y sin forma de arreglarlo desde
    adentro de la actividad."""
    code, loc = registered_sin_link(rol="Instructor")
    assert code == 302, loc
    assert "/lti-select?" in loc
    assert "link=" in loc


@pytest.mark.asyncio
async def test_un_alumno_sin_encuesta_asignada_ve_el_404(lti_on, registered_sin_link):
    """A un alumno el selector no le sirve: no puede arreglar nada y elegiría
    cualquier cosa -- y esa elección quedaría hecha para todo el curso."""
    code, _ = registered_sin_link(rol="Learner")
    assert code == 404


@pytest.mark.asyncio
async def test_un_subrol_instructor_de_learner_no_abre_el_selector(
    lti_on, registered_sin_link
):
    """`.../membership/Learner#Instructor` es un rol de LTI perfectamente
    válido y significa "alumno", no "docente": en un sub-rol el rol principal
    es lo que va ANTES del `#` y el sufijo es apenas la especialización.

    Un chequeo por `endswith("#Instructor")` -- que es lo primero que uno
    escribe -- da este caso por docente y le abre el selector a un alumno.
    Este test es el que discrimina entre "mirar cómo termina la cadena" y
    "parsear el rol"."""
    code, _ = registered_sin_link(roles=[f"{NS_CONTEXTO}/Learner#Instructor"])
    assert code == 404


@pytest.mark.asyncio
async def test_un_ayudante_de_catedra_si_abre_el_selector(lti_on, registered_sin_link):
    """La contracara del test de arriba: `membership/Instructor#TeachingAssistant`
    sí es un sub-rol de Instructor y tiene que abrir el selector -- si el
    parseo del rol se hiciera al revés (mirando el sufijo), este caso quedaría
    afuera."""
    code, loc = registered_sin_link(roles=[f"{NS_CONTEXTO}/Instructor#TeachingAssistant"])
    assert code == 302, loc
    assert "/lti-select?" in loc


@pytest.mark.asyncio
async def test_un_lanzamiento_sin_roles_ve_el_404(lti_on, registered_sin_link):
    """Ante la duda, el 404: una lista de roles vacía no habilita nada."""
    code, _ = registered_sin_link(roles=[])
    assert code == 404


@pytest.mark.asyncio
async def test_roles_basura_no_abren_el_selector(lti_on, registered_sin_link):
    """Entradas que no son strings, o URIs de otro vocabulario que terminan
    igual, no pueden colarse como docente."""
    code, _ = registered_sin_link(
        roles=[123, None, "https://ejemplo.test/roles#Instructor", "Learner"]
    )
    assert code == 404


@pytest.mark.asyncio
async def test_un_admin_del_sitio_ve_el_selector(lti_on, registered_sin_link):
    """Moodle manda `system/person#Administrator` para el admin del sitio, que
    no está inscripto en el curso pero sí puede editar la actividad."""
    code, loc = registered_sin_link(
        roles=["http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator"]
    )
    assert code == 302, loc


@pytest.mark.asyncio
async def test_el_borrado_de_la_cookie_de_state_en_el_selector_lleva_samesite_none(
    lti_on, sin_encuesta
):
    """La rama nueva también termina un form-POST cross-site: si el borrado de
    `enc_lti_state` no lleva los mismos atributos con los que se escribió la
    cookie, el navegador lo ignora y el par (state, nonce) queda reusable
    durante toda la ventana de STATE_TTL_S (mismo contrato que las otras dos
    salidas de `launch`)."""
    from app.lti.state import LTI_STATE_COOKIE

    r = _lanzar(_cliente(), sin_encuesta, f"rl-{uuid.uuid4().hex[:8]}",
                [f"{NS_CONTEXTO}#Instructor"])
    assert r.status_code == 302
    borrado = [c for c in r.headers.get_list("set-cookie") if c.startswith(f"{LTI_STATE_COOKIE}=")]
    assert borrado, "la respuesta del selector debe borrar la cookie de state"
    header = borrado[0].lower()
    assert "samesite=none" in header
    assert "secure" in header


@pytest.mark.asyncio
async def test_el_selector_del_docente_lista_solo_las_encuestas_de_su_organizacion(
    lti_on, sin_encuesta, db_session
):
    """El token de vínculo tiene que servir para listar (si no, el docente
    llega a un selector vacío) y el listado tiene que seguir acotado a
    `Survey.org_id == platform.org_id`."""
    async with db_session() as session:
        ajena = Survey(org_id=await crear_org(session, "Ajena del selector de vínculo"),
                       title="Encuesta Ajena Al Vínculo", status="published",
                       json_schema={"pages": []})
        session.add(ajena)
        await session.commit()

    cliente = _cliente()
    r = _lanzar(cliente, sin_encuesta, f"rl-{uuid.uuid4().hex[:8]}",
                [f"{NS_CONTEXTO}#Instructor"])
    listado = cliente.get(f"/lti/select/surveys?link={_token_de_vinculo(r)}")
    assert listado.status_code == 200, listado.text
    titulos = [s["title"] for s in listado.json()["surveys"]]
    assert "Encuesta del selector" in titulos
    assert "Encuesta Ajena Al Vínculo" not in titulos, "fuga entre organizaciones"


@pytest.mark.asyncio
async def test_vincular_deja_entrar_al_alumno_en_el_siguiente_lanzamiento(
    lti_on, sin_encuesta, db_session
):
    """El recorrido completo: el docente entra, elige, y el alumno que entra
    después a la MISMA actividad ya no ve el 404."""
    rl = f"rl-{uuid.uuid4().hex[:8]}"
    docente = _cliente()
    r = _lanzar(docente, sin_encuesta, rl, [f"{NS_CONTEXTO}#Instructor"])
    assert r.status_code == 302, r.text

    elegida = docente.post("/lti/select/link", json={
        "link": _token_de_vinculo(r),
        "survey_id": str(sin_encuesta["survey"].id),
        "anonymous": True,
    })
    assert elegida.status_code == 200, elegida.text
    assert elegida.json()["redirect"] == f"/s/{sin_encuesta['survey'].slug}"

    async with db_session() as session:
        link = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == sin_encuesta["platform"].id,
                    LtiResourceLink.resource_link_id == rl,
                )
            )
        ).first()
        assert link is not None
        assert link.survey_id == sin_encuesta["survey"].id
        assert link.anonymous is True
        # El contexto del lanzamiento viaja en el token y queda persistido:
        # sin esto el panel muestra el vínculo sin curso.
        assert link.context_id == "course-sin"
        assert link.context_title == "Historia 3°B"

    alumno = _cliente()
    r2 = _lanzar(alumno, sin_encuesta, rl, [f"{NS_CONTEXTO}#Learner"])
    assert r2.status_code == 302, r2.text
    assert r2.headers["location"] == f"/s/{sin_encuesta['survey'].slug}"


@pytest.mark.asyncio
async def test_no_se_puede_vincular_una_encuesta_de_otra_organizacion(
    lti_on, sin_encuesta, db_session
):
    async with db_session() as session:
        ajena = Survey(org_id=await crear_org(session, "Ajena del vínculo"),
                       title="Ajena", status="published", json_schema={"pages": []})
        session.add(ajena)
        await session.commit()
        ajena_id = ajena.id

    cliente = _cliente()
    r = _lanzar(cliente, sin_encuesta, f"rl-{uuid.uuid4().hex[:8]}",
                [f"{NS_CONTEXTO}#Instructor"])
    res = cliente.post("/lti/select/link", json={
        "link": _token_de_vinculo(r), "survey_id": str(ajena_id),
    })
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_un_token_de_deep_linking_no_sirve_para_vincular(lti_on, sin_encuesta):
    """Los propósitos separados son justamente para esto: con un token de deep
    linking no se puede crear un vínculo de este lado."""
    from app.lti.deeplink import DL_PURPOSE
    from app.lti.state import STATE_TTL_S
    from app.security import create_purpose_token

    dl = create_purpose_token(
        DL_PURPOSE,
        {
            "platform_id": str(sin_encuesta["platform"].id),
            "deployment_id": "1",
            "resource_link_id": "rl-robado",
            "settings": {"deep_link_return_url": f"{ISSUER_SIN}/return"},
        },
        ttl_minutes=STATE_TTL_S / 60,
    )
    res = _cliente().post("/lti/select/link", json={
        "link": dl, "survey_id": str(sin_encuesta["survey"].id),
    })
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_un_token_de_vinculo_no_sirve_para_firmar_un_content_item(
    lti_on, sin_encuesta
):
    """Y al revés: con un token de vínculo no se le firma nada a la
    plataforma."""
    cliente = _cliente()
    r = _lanzar(cliente, sin_encuesta, f"rl-{uuid.uuid4().hex[:8]}",
                [f"{NS_CONTEXTO}#Instructor"])
    token = _token_de_vinculo(r)

    assert cliente.get(f"/lti/select/surveys?dl={token}").status_code == 400
    ret = cliente.post("/lti/select/return", json={
        "dl": token, "survey_id": str(sin_encuesta["survey"].id),
    })
    assert ret.status_code == 400


@pytest.mark.asyncio
async def test_vincular_dos_veces_a_la_vez_deja_una_sola_fila(
    lti_on, sin_encuesta, db_session
):
    """Dos docentes eligiendo a la vez sobre la misma actividad: gana el
    primero y el segundo sigue con ese vínculo, sin 500 y sin fila duplicada.

    El `session.rollback()` de la recuperación expira TODA la identity map de
    la sesión, así que este test también cubre que la respuesta no vuelva a
    tocar `survey`/`platform` después (eso sería un `MissingGreenlet`)."""
    async with db_session() as session:
        otra = Survey(org_id=sin_encuesta["org_id"], title="La que gana la carrera",
                      status="published", json_schema={"pages": []})
        session.add(otra)
        await session.commit()
        otra_id, otra_slug = otra.id, otra.slug

    rl = f"rl-{uuid.uuid4().hex[:8]}"
    cliente = _cliente()
    r = _lanzar(cliente, sin_encuesta, rl, [f"{NS_CONTEXTO}#Instructor"])
    token = _token_de_vinculo(r)

    # El "primer docente" ya dejó su fila; el segundo llega con el mismo
    # resource_link_id y choca contra `uq_lti_link`.
    async with db_session() as session:
        session.add(LtiResourceLink(
            platform_id=sin_encuesta["platform"].id, resource_link_id=rl,
            survey_id=otra_id,
        ))
        await session.commit()

    res = cliente.post("/lti/select/link", json={
        "link": token, "survey_id": str(sin_encuesta["survey"].id),
    })
    assert res.status_code == 200, res.text
    # Se sigue con el vínculo que ganó, no con el que este pedido eligió.
    assert res.json()["redirect"] == f"/s/{otra_slug}"

    async with db_session() as session:
        filas = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == sin_encuesta["platform"].id,
                    LtiResourceLink.resource_link_id == rl,
                )
            )
        ).all()
        assert len(filas) == 1
        assert filas[0].survey_id == otra_id
