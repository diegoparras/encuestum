"""AGS: pedido del token, alta del line item y publicación de la nota."""

import json
import uuid

import httpx
import jwt
import pytest
import pytest_asyncio
from jwt.algorithms import RSAAlgorithm

from app.lti.ags import ensure_lineitem, get_access_token, get_lineitem_max, post_score
from app.lti.keys import get_tool_key
from app.models import LtiPlatform, LtiResourceLink

ISSUER = "https://moodle.ags"
CLIENT_ID = "cid-ags"
TOKEN_URL = f"{ISSUER}/mod/lti/token.php"
LINEITEMS = f"{ISSUER}/mod/lti/services.php/2/lineitems"
LINEITEM = f"{LINEITEMS}/7/lineitem"


@pytest_asyncio.fixture
async def ags_setup(db_session):
    async with db_session() as session:
        # La base es compartida entre tests dentro de la misma sesión de
        # pytest: si un test anterior ya dejó una plataforma con este mismo
        # (issuer, client_id), hay que limpiarla antes de volver a insertar
        # o la unique constraint la rechaza (mismo patrón que test_lti_launch.py).
        from sqlmodel import select as _select

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

        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php", auth_token_url=TOKEN_URL,
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=uuid.uuid4(),
        )
        session.add(platform)
        await session.commit()
        link = LtiResourceLink(platform_id=platform.id, resource_link_id="rl-ags",
                               survey_id=uuid.uuid4(), lineitems_url=LINEITEMS)
        session.add(link)
        await session.commit()
        key = await get_tool_key(session)
        return {"platform": platform, "link": link, "key": key}


@pytest.mark.asyncio
async def test_el_token_se_pide_con_un_client_assertion_firmado(monkeypatch, lti_on, ags_setup):
    capturado = {}

    async def fake_post(self, url, **kw):
        capturado["url"] = url
        capturado["data"] = kw.get("data")
        return httpx.Response(200, json={"access_token": "tok-1", "expires_in": 3600})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    token = await get_access_token(
        ags_setup["platform"], ags_setup["key"],
        ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
    )
    assert token == "tok-1"
    assert capturado["url"] == TOKEN_URL
    assert capturado["data"]["grant_type"] == "client_credentials"
    assert capturado["data"]["client_assertion_type"] == (
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    )

    # El client_assertion está firmado por el tool y apunta a la plataforma.
    from app.lti.keys import public_jwk

    public_key = RSAAlgorithm.from_jwk(json.dumps(public_jwk(ags_setup["key"])))
    claims = jwt.decode(capturado["data"]["client_assertion"], public_key,
                        algorithms=["RS256"], audience=TOKEN_URL)
    assert claims["iss"] == CLIENT_ID
    assert claims["sub"] == CLIENT_ID


@pytest.mark.asyncio
async def test_get_access_token_propaga_error_si_la_plataforma_rechaza(monkeypatch, lti_on, ags_setup):
    """Un 400/401 del token endpoint (client_assertion inválido, scope no
    autorizado, etc.) tiene que propagarse como error, no devolver un token
    vacío o silenciarse: es lo único que distingue esto de un `resp.json()`
    que casualmente no tiene `access_token`."""

    async def fake_post(self, url, **kw):
        return httpx.Response(400, json={"error": "invalid_client"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with pytest.raises(Exception):
        await get_access_token(
            ags_setup["platform"], ags_setup["key"],
            ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
        )


@pytest.mark.asyncio
async def test_ensure_lineitem_crea_uno_si_no_existe(monkeypatch, lti_on, ags_setup):
    llamadas = []
    enviado = {}

    async def fake_post(self, url, **kw):
        llamadas.append(url)
        if url == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return httpx.Response(201, json={"id": LINEITEM, "scoreMaximum": 10.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    url = await ensure_lineitem(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                                label="Examen", score_maximum=10.0)
    assert url == LINEITEM
    assert LINEITEMS in llamadas
    # El cuerpo mandado tiene que llevar la escala pedida, no una inventada.
    assert enviado["json"]["scoreMaximum"] == 10.0
    assert enviado["json"]["label"] == "Examen"
    assert enviado["json"]["resourceLinkId"] == ags_setup["link"].resource_link_id


@pytest.mark.asyncio
async def test_ensure_lineitem_no_recrea_si_ya_hay_uno(monkeypatch, lti_on, ags_setup):
    ags_setup["link"].lineitem_url = LINEITEM

    async def boom(self, url, **kw):
        raise AssertionError(f"no debería postear a {url}")

    monkeypatch.setattr(httpx.AsyncClient, "post", boom)
    url = await ensure_lineitem(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                                label="Examen", score_maximum=10.0)
    assert url == LINEITEM


@pytest.mark.asyncio
async def test_post_score_manda_la_nota_en_el_formato_de_ags(monkeypatch, lti_on, ags_setup):
    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        enviado["url"] = url
        enviado["json"] = kw.get("json")
        enviado["headers"] = kw.get("headers")
        return httpx.Response(200, json={})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    await post_score(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                     sub="u-42", score=8.5, score_maximum=10.0, comment="Buen trabajo")

    assert enviado["url"] == f"{LINEITEM}/scores"
    assert enviado["headers"]["Content-Type"] == "application/vnd.ims.lis.v1.score+json"
    body = enviado["json"]
    assert body["userId"] == "u-42"
    assert body["scoreGiven"] == 8.5
    assert body["scoreMaximum"] == 10.0
    assert body["activityProgress"] == "Completed"
    assert body["gradingProgress"] == "FullyGraded"
    assert body["comment"] == "Buen trabajo"
    assert body["timestamp"].endswith("Z") or "+" in body["timestamp"]


@pytest.mark.asyncio
async def test_get_lineitem_max_lee_la_escala_del_libro(monkeypatch, lti_on, ags_setup):
    async def fake_post(self, url, **kw):
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})

    async def fake_get(self, url, **kw):
        assert url == LINEITEM
        return httpx.Response(200, json={"id": LINEITEM, "scoreMaximum": 20.0, "label": "Examen"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    assert await get_lineitem_max(ags_setup["platform"], LINEITEM, ags_setup["key"]) == 20.0


@pytest.mark.asyncio
async def test_la_nota_se_reescala_a_la_escala_del_libro(monkeypatch, lti_on, ags_setup, db_session):
    """Rúbrica sobre 10, libro sobre 20: un 8,5 tiene que llegar como 17."""
    from app.lti.ags import _deliver
    from app.models import Survey, SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return httpx.Response(200, json={})

    async def fake_get(self, url, **kw):
        return httpx.Response(200, json={"id": LINEITEM, "scoreMaximum": 20.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = Survey(id=ags_setup["link"].survey_id, org_id=uuid.uuid4(),
                        title="Examen", json_schema={})
        session.add(survey)
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)
    assert enviado["json"]["scoreGiven"] == 17.0
    assert enviado["json"]["scoreMaximum"] == 20.0


@pytest.mark.asyncio
async def test_deliver_no_hace_nada_si_la_respuesta_no_tiene_nota(monkeypatch, lti_on, ags_setup, db_session):
    """Una respuesta sin corregir (score None) no puede generar ningún pedido
    HTTP: publicar una nota inexistente sería peor que no publicar nada."""
    from app.lti.ags import _deliver
    from app.models import Survey, SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM

    async def boom(self, url, **kw):
        raise AssertionError(f"no debería llamar a {url} sin nota")

    monkeypatch.setattr(httpx.AsyncClient, "post", boom)
    monkeypatch.setattr(httpx.AsyncClient, "get", boom)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = Survey(id=ags_setup["link"].survey_id, org_id=uuid.uuid4(),
                        title="Examen", json_schema={})
        session.add(survey)
        r = SurveyResponse(survey_id=survey.id, answers={}, score=None, max_score=None,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)  # no debe lanzar ni pegarle a la red


@pytest.mark.asyncio
async def test_deliver_no_hace_nada_si_la_respuesta_no_vino_de_lti(db_session):
    """Una respuesta anónima (sin lti_link_id) tampoco debe intentar
    publicar nota: no hay ninguna actividad de LMS a la que atribuirla."""
    from app.lti.ags import _deliver
    from app.models import Survey, SurveyResponse

    async with db_session() as session:
        survey = Survey(org_id=uuid.uuid4(), title="Encuesta suelta", json_schema={})
        session.add(survey)
        await session.commit()
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.0, max_score=10.0)
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)  # no debe lanzar (y sin lti_link_id, ni siquiera pega HTTP)


@pytest.mark.asyncio
async def test_deliver_no_propaga_el_error_si_la_plataforma_esta_caida(
    monkeypatch, lti_on, ags_setup, db_session
):
    """El estudiante ya envió su respuesta; que Moodle esté caído, lento o mal
    configurado no puede convertirse en un error de la request de submit.
    `_deliver` corre en background, así que lo único observable acá es que no
    lance y que quede un log de la falla.

    No usamos `caplog`: alembic corre `logging.config.fileConfig(...)` (con su
    `disable_existing_loggers=True` por defecto) al aplicar las migraciones en
    el fixture de sesión, y eso deshabilita cualquier logger de `app.*` que ya
    existiera para ese momento -- entre ellos, el de este módulo, importado al
    coleccionar este archivo de test. Nada que ver con el código de `ags.py`:
    es un efecto de cómo pytest importa los módulos antes de correr los
    fixtures. Se verifica el log llamando directamente al `LOGGER` del módulo."""
    import app.lti.ags as ags_module
    from app.models import Survey, SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    logueado = {}
    monkeypatch.setattr(
        ags_module.LOGGER, "warning",
        lambda msg, *args: logueado.update(msg=msg % args if args else msg),
    )

    async def fake_post(self, url, **kw):
        raise httpx.ConnectError("la plataforma no responde")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = Survey(id=ags_setup["link"].survey_id, org_id=uuid.uuid4(),
                        title="Examen", json_schema={})
        session.add(survey)
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await ags_module._deliver(response_id)  # no debe propagar la excepción

    assert str(response_id) in logueado.get("msg", "")


# ── El enganche en submit(): sólo agenda la nota si hay contexto LTI y score ──
# Se monkeypatchea `_lti_context` para no repetir el flujo completo de
# login/launch (ya cubierto en test_lti_launch.py) — acá sólo importa que
# `submit()` decida bien cuándo llamar a `schedule_score`.

_SCHEMA = {"pages": [{"name": "p", "elements": [
    {"type": "radiogroup", "name": "cap", "title": "Capital", "choices": ["Madrid", "Paris"]},
]}]}
_EVAL = {"enabled": True, "passingScore": 60, "questions": {
    "cap": {"gradable": True, "grader": "auto", "points": 2, "correct": "Paris"},
}}


@pytest.mark.asyncio
async def test_submit_agenda_la_nota_lti_cuando_hay_score(monkeypatch, lti_on, ags_setup):
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    import app.routers.public as public_router

    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))
    monkeypatch.setattr(
        public_router, "_lti_context",
        lambda request, s: {"link_id": str(ags_setup["link"].id), "sub": "u-42", "email": None, "slug": s.slug},
    )

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    r = c.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"cap": "Paris"}})
    assert r.status_code == 201
    assert r.json()["status"] == "graded"
    assert len(llamados) == 1


@pytest.mark.asyncio
async def test_submit_no_agenda_nota_lti_sin_contexto_lti(monkeypatch, lti_on):
    """Una respuesta que no vino de un lanzamiento LTI (aunque la encuesta
    tenga evaluación con IA habilitada) no debe programar ningún envío."""
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module

    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    r = c.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"cap": "Paris"}})
    assert r.status_code == 201
    assert r.json()["status"] == "graded"
    assert llamados == []


@pytest.mark.asyncio
async def test_submit_no_agenda_nota_lti_sin_evaluacion(monkeypatch, lti_on, ags_setup):
    """Contexto LTI presente, pero la encuesta no tiene evaluación: sin nota
    (`r.score is None`) no hay nada que publicar en el libro."""
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    import app.routers.public as public_router

    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))
    monkeypatch.setattr(
        public_router, "_lti_context",
        lambda request, s: {"link_id": str(ags_setup["link"].id), "sub": "u-42", "email": None, "slug": s.slug},
    )

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": _SCHEMA}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    r = c.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"cap": "Paris"}})
    assert r.status_code == 201
    assert llamados == []
