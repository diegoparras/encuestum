"""Panel de conexión con Moodle: modelo, endpoints y aislamiento entre orgs."""

import uuid

import pytest
from sqlmodel import select

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
