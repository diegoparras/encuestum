"""AGS: pedido del token, alta del line item y publicación de la nota."""

import asyncio
import json
import uuid

import httpx
import jwt
import pytest
import pytest_asyncio
from jwt.algorithms import RSAAlgorithm

from app.lti.ags import ensure_lineitem, get_access_token, get_lineitem_max, post_score
from app.lti.keys import get_tool_key
from app.models import LtiPlatform, LtiResourceLink, Survey
from tests.conftest import crear_org

ISSUER = "https://moodle.ags"
CLIENT_ID = "cid-ags"
TOKEN_URL = f"{ISSUER}/mod/lti/token.php"
LINEITEMS = f"{ISSUER}/mod/lti/services.php/2/lineitems"
LINEITEM = f"{LINEITEMS}/7/lineitem"


def _resp(method: str, url: str, status: int, json_body):
    """Respuesta de test con su `Request` adjunto. httpx sólo arma ese vínculo
    cuando la respuesta viene de una petición real hecha por el cliente; acá
    hay que simularlo a mano para que `raise_for_status()` se comporte igual
    que en producción (si no, explota con `RuntimeError: request instance not
    set`, sin relación con el código bajo prueba)."""
    return httpx.Response(status, json=json_body, request=httpx.Request(method, url))


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
            # Ver la nota del fixture equivalente en test_lti_launch.py: el
            # CASCADE de la FK se lleva los resource links, no hace falta a mano.
            await session.delete(previa)
            await session.commit()

        org_id = await crear_org(session, "Escuela de AGS")
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php", auth_token_url=TOKEN_URL,
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        # La encuesta la crea el fixture y no cada test: el vínculo la referencia
        # por clave foránea, y bajo Postgres apuntar a una fila inexistente falla.
        survey = Survey(org_id=org_id, title="Examen", json_schema={})
        session.add(survey)
        await session.commit()
        link = LtiResourceLink(platform_id=platform.id, resource_link_id="rl-ags",
                               survey_id=survey.id, lineitems_url=LINEITEMS)
        session.add(link)
        await session.commit()
        key = await get_tool_key(session)
        return {"platform": platform, "link": link, "key": key, "survey": survey}


@pytest.mark.asyncio
async def test_el_token_se_pide_con_un_client_assertion_firmado(monkeypatch, lti_on, ags_setup):
    capturado = {}

    async def fake_post(self, url, **kw):
        capturado["url"] = url
        capturado["data"] = kw.get("data")
        return _resp("POST", url, 200, {"access_token": "tok-1", "expires_in": 3600})

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
    autorizado, etc.) tiene que propagarse como el `HTTPStatusError` típico de
    httpx -- con el status y la respuesta cruda adentro -- no como un error
    genérico ni un `KeyError` incidental de `resp.json()["access_token"]`."""

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 400, {"error": "invalid_client"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        await get_access_token(
            ags_setup["platform"], ags_setup["key"],
            ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
        )
    assert excinfo.value.response.status_code == 400


@pytest.mark.asyncio
async def test_ensure_lineitem_crea_uno_si_no_existe(monkeypatch, lti_on, ags_setup):
    llamadas = []
    enviado = {}

    async def fake_get(self, url, **kw):
        # Se pregunta primero si ya hay un line item para este resource link
        # antes de crear uno; acá la plataforma no tiene ninguno.
        assert url == LINEITEMS
        assert kw.get("params") == {"resource_link_id": ags_setup["link"].resource_link_id}
        return _resp("GET", url, 200, [])

    async def fake_post(self, url, **kw):
        llamadas.append(url)
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 201, {"id": LINEITEM, "scoreMaximum": 10.0})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
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
        raise AssertionError(f"no debería llamar a {url}")

    monkeypatch.setattr(httpx.AsyncClient, "get", boom)
    monkeypatch.setattr(httpx.AsyncClient, "post", boom)
    url = await ensure_lineitem(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                                label="Examen", score_maximum=10.0)
    assert url == LINEITEM


@pytest.mark.asyncio
async def test_ensure_lineitem_adopta_uno_existente_en_vez_de_crear_duplicado(
    monkeypatch, lti_on, ags_setup
):
    """Dos submits casi simultáneos de la primera respuesta de un launch sin
    `lineitem` claim ven ambos `link.lineitem_url is None` y podrían terminar
    creando dos line items (dos columnas en el libro, notas repartidas entre
    ambas). Antes de crear, se filtra por `resource_link_id` en el servicio de
    lineitems; si la plataforma ya tiene uno -- porque el otro submit ganó la
    carrera, o porque se creó por otra vía -- se adopta ese en vez de crear
    otro."""
    llamadas_post = []

    async def fake_get(self, url, **kw):
        assert url == LINEITEMS
        assert kw.get("params") == {"resource_link_id": ags_setup["link"].resource_link_id}
        return _resp("GET", url, 200, [{"id": LINEITEM, "scoreMaximum": 10.0}])

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        llamadas_post.append(url)
        raise AssertionError(f"no debería crear un line item nuevo: {url}")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    url = await ensure_lineitem(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                                label="Examen", score_maximum=10.0)
    assert url == LINEITEM
    assert llamadas_post == []


@pytest.mark.asyncio
async def test_post_score_manda_la_nota_en_el_formato_de_ags(monkeypatch, lti_on, ags_setup):
    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["url"] = url
        enviado["json"] = kw.get("json")
        enviado["headers"] = kw.get("headers")
        return _resp("POST", url, 200, {})

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
async def test_post_score_preserva_el_query_string_del_lineitem(monkeypatch, lti_on, ags_setup):
    """Las URLs de line item de Moodle llevan `?type_id=N` (identifica el tipo
    de herramienta). `/scores` tiene que insertarse ANTES del query, no
    después de descartarlo -- perderlo es un 403/404 en el último paso del
    flujo, el más difícil de atribuir porque todo lo anterior salió bien."""
    lineitem_con_query = f"{LINEITEM}?type_id=3"
    ags_setup["link"].lineitem_url = lineitem_con_query
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["url"] = url
        return _resp("POST", url, 200, {})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    await post_score(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                     sub="u-42", score=8.5, score_maximum=10.0)

    assert enviado["url"] == f"{LINEITEM}/scores?type_id=3"


@pytest.mark.asyncio
async def test_post_score_manda_pendingmanual_si_necesita_revision(monkeypatch, lti_on, ags_setup):
    """AGS define `PendingManual` para una nota todavía no definitiva. Una
    respuesta marcada `needs_review` tiene que publicarse así, no como
    `FullyGraded` -- si no, el docente ve la nota como cerrada en el libro de
    calificaciones del LMS cuando en realidad sigue pendiente de revisión."""
    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 200, {})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    await post_score(ags_setup["platform"], ags_setup["link"], ags_setup["key"],
                     sub="u-42", score=8.5, score_maximum=10.0, needs_review=True)

    assert enviado["json"]["gradingProgress"] == "PendingManual"


@pytest.mark.asyncio
async def test_get_lineitem_max_lee_la_escala_del_libro(monkeypatch, lti_on, ags_setup):
    async def fake_post(self, url, **kw):
        return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})

    async def fake_get(self, url, **kw):
        assert url == LINEITEM
        return _resp("GET", url, 200, {"id": LINEITEM, "scoreMaximum": 20.0, "label": "Examen"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    assert await get_lineitem_max(ags_setup["platform"], LINEITEM, ags_setup["key"]) == 20.0


@pytest.mark.asyncio
async def test_get_lineitem_max_respeta_un_scoreMaximum_en_cero(monkeypatch, lti_on, ags_setup):
    """Un line item configurado a 0 es válido (el docente lo puso así) y no es
    lo mismo que un line item sin `scoreMaximum` en la respuesta. `0 or algo`
    en Python cae en `algo` porque 0 es falsy: hay que chequear `is None`, no
    la verdad del valor."""

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {"id": LINEITEM, "scoreMaximum": 0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    assert await get_lineitem_max(ags_setup["platform"], LINEITEM, ags_setup["key"]) == 0.0


@pytest.mark.asyncio
async def test_la_nota_se_reescala_a_la_escala_del_libro(monkeypatch, lti_on, ags_setup, db_session):
    """Rúbrica sobre 10, libro sobre 20: un 8,5 tiene que llegar como 17."""
    from app.lti.ags import _deliver
    from app.models import SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 200, {})

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {"id": LINEITEM, "scoreMaximum": 20.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = ags_setup["survey"]
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)
    assert enviado["json"]["scoreGiven"] == 17.0
    assert enviado["json"]["scoreMaximum"] == 20.0


@pytest.mark.asyncio
async def test_deliver_manda_pendingmanual_si_la_respuesta_necesita_revision(
    monkeypatch, lti_on, ags_setup, db_session
):
    """`_deliver` tiene que pasarle `r.needs_review` a `post_score` -- si no,
    una respuesta que quedó pendiente de revisión se publica igual como
    `FullyGraded`."""
    from app.lti.ags import _deliver
    from app.models import SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 200, {})

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {"id": LINEITEM, "scoreMaximum": 10.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = ags_setup["survey"]
        r = SurveyResponse(survey_id=survey.id, answers={}, score=5.0, max_score=10.0,
                           needs_review=True,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)
    assert enviado["json"]["gradingProgress"] == "PendingManual"


@pytest.mark.asyncio
async def test_deliver_no_hace_nada_si_falta_el_lti_sub(monkeypatch, lti_on, ags_setup, db_session):
    """`lti_sub` es nullable: una respuesta que llegó con contexto LTI pero sin
    `sub` (launch mal formado, claim faltante) no puede terminar posteando
    `userId: ""` -- AGS la rechaza igual, pero como un warning más silencioso
    en vez de cortar acá donde se sabe la causa.

    Nota: `_deliver` traga cualquier excepción (es su contrato: nunca debe
    romper el submit del alumno), así que no alcanza con que la llamada HTTP
    *lance* para detectar que se hizo -- eso también quedaría silenciado y el
    test pasaría igual. Hay que verificar que la llamada directamente no
    ocurrió, registrándola en vez de hacerla explotar."""
    from app.lti.ags import _deliver
    from app.models import SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    llamadas = []

    async def registra(self, url, **kw):
        llamadas.append(url)
        return _resp("GET", url, 200, {})

    monkeypatch.setattr(httpx.AsyncClient, "post", registra)
    monkeypatch.setattr(httpx.AsyncClient, "get", registra)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = ags_setup["survey"]
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub=None)
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)
    assert llamadas == []  # ni un solo pedido HTTP con userId vacío


@pytest.mark.asyncio
async def test_deliver_no_hace_nada_si_la_respuesta_no_tiene_nota(monkeypatch, lti_on, ags_setup, db_session):
    """Una respuesta sin corregir (score None) no puede generar ningún pedido
    HTTP: publicar una nota inexistente sería peor que no publicar nada."""
    from app.lti.ags import _deliver
    from app.models import SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM

    async def boom(self, url, **kw):
        raise AssertionError(f"no debería llamar a {url} sin nota")

    monkeypatch.setattr(httpx.AsyncClient, "post", boom)
    monkeypatch.setattr(httpx.AsyncClient, "get", boom)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = ags_setup["survey"]
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
        survey = Survey(org_id=await crear_org(session, "Escuela suelta"),
                        title="Encuesta suelta", json_schema={})
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
    from app.models import SurveyResponse

    ags_setup["link"].lineitem_url = LINEITEM
    logueado = {}
    monkeypatch.setattr(
        ags_module.LOGGER, "warning",
        # `**kwargs` porque el fix de exc_info=True agrega justo ese keyword
        # argument a la llamada real; si el doble no lo acepta, el propio
        # test explota con un TypeError ajeno a lo que se quiere probar.
        lambda msg, *args, **kwargs: logueado.update(
            msg=msg % args if args else msg, kwargs=kwargs
        ),
    )

    async def fake_post(self, url, **kw):
        raise httpx.ConnectError("la plataforma no responde")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = ags_setup["survey"]
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await ags_module._deliver(response_id)  # no debe propagar la excepción

    assert str(response_id) in logueado.get("msg", "")
    # El único canal de diagnóstico de una falla invisible para el docente
    # tiene que llevar el traceback, no sólo el mensaje.
    assert logueado.get("kwargs", {}).get("exc_info") is True


@pytest.mark.asyncio
async def test_deliver_sobrevive_a_una_carrera_de_clave_del_tool(
    monkeypatch, lti_on, ags_setup, db_session, request
):
    """Rollback sweep del fix de la carrera de `LtiResourceLink`
    (`app/routers/lti.py::_upsert_lti_user`/`_link_from_deep_link_claims`):
    `get_tool_key` (`app/lti/keys.py`) también se recupera de una carrera de
    inserción con su propio `session.rollback()`, que expira TODO el
    identity map de la sesión -- no sólo la clave. `_deliver` carga
    `r`/`link`/`platform`/`survey` en la MISMA sesión con la que después pide
    la clave: antes de reordenar `_deliver` para pedirla primero (ver el
    comentario ahí), ese rollback los dejaba expirados, y
    `ensure_lineitem`/`get_access_token` (que leen sus atributos sin
    `await`) reventaban con `MissingGreenlet` -- silenciado por el `except
    Exception` de `_deliver` (ver
    `test_deliver_no_propaga_el_error_si_la_plataforma_esta_caida` arriba),
    así que el síntoma real era una nota que nunca se publicaba, sin ningún
    error visible para el alumno ni el docente.

    Un `LTI_KEY_ID` propio evita interferir con la clave que `ags_setup` ya
    dejó persistida para el kid por default, y garantiza que la fila de
    `LtiKey` para ESTE kid todavía no exista -- condición para que
    `get_tool_key` tome la rama de la carrera."""
    from sqlalchemy.exc import IntegrityError

    import app.db as db_module
    from app.config import get_settings
    from app.lti.ags import _deliver
    from app.lti.keys import _generate
    from app.models import LtiKey, SurveyResponse

    monkeypatch.setenv("LTI_KEY_ID", f"race-deliver-{uuid.uuid4().hex}")
    get_settings.cache_clear()
    request.addfinalizer(get_settings.cache_clear)
    settings = get_settings()

    winning_private_pem, winning_public_pem = _generate()
    real_session_maker = db_module._session_maker

    def fake_session_maker():
        # `_deliver` hace `from app.db import _session_maker` DENTRO de la
        # función, así que parchear el atributo del módulo alcanza -- cada
        # llamada relee el atributo actual, no el que había al importar.
        session = real_session_maker()
        real_commit = session.commit
        state = {"first_call": True}

        async def fake_commit():
            if state["first_call"]:
                state["first_call"] = False
                # Soltamos nuestra transacción antes de que la "otra
                # entrega" inserte y confirme -- misma técnica
                # determinística que el resto de esta suite, sin
                # concurrencia real.
                await session.rollback()
                async with real_session_maker() as other:
                    other.add(
                        LtiKey(
                            kid=settings.lti_key_id,
                            private_pem=winning_private_pem,
                            public_pem=winning_public_pem,
                        )
                    )
                    await other.commit()
                raise IntegrityError(
                    "insert", {}, Exception("UNIQUE constraint failed: lti_keys.kid")
                )
            await real_commit()

        session.commit = fake_commit
        return session

    monkeypatch.setattr(db_module, "_session_maker", fake_session_maker)

    ags_setup["link"].lineitem_url = LINEITEM
    enviado = {}

    async def fake_post(self, url, **kw):
        if url == TOKEN_URL:
            return _resp("POST", url, 200, {"access_token": "tok", "expires_in": 3600})
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 200, {})

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {"id": LINEITEM, "scoreMaximum": 20.0})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    async with db_session() as session:
        session.add(ags_setup["link"])
        survey = ags_setup["survey"]
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    await _deliver(response_id)

    # Si `MissingGreenlet` hubiera reventado adentro (y `_deliver` se lo
    # hubiera tragado, como es su contrato), `enviado["json"]` nunca se
    # habría poblado -- la nota se publica o el test lo detecta.
    assert enviado.get("json") is not None, "la nota nunca se publicó"
    assert enviado["json"]["scoreGiven"] == 17.0
    assert enviado["json"]["scoreMaximum"] == 20.0


@pytest.mark.asyncio
async def test_schedule_score_dispara_deliver_de_verdad(monkeypatch, lti_on, ags_setup, db_session):
    """El único punto donde `schedule_score` corre de verdad, de punta a
    punta: los tests de `submit()` la monkeypatchean para no repetir el envío
    completo, y los de `_deliver` lo llaman directo sin pasar por
    `schedule_score`. Acá se la deja correr tal cual -- crea la tarea
    fire-and-forget de siempre -- y se comprueba que `_deliver` es alcanzado
    con el id correcto. Como es fire-and-forget, hay que cederle el control al
    loop para que la tarea corra; nada de dormir un tiempo fijo."""
    import app.lti.ags as ags_module
    from app.models import SurveyResponse

    alcanzado = {}

    async def fake_deliver(response_id):
        alcanzado["id"] = response_id

    monkeypatch.setattr(ags_module, "_deliver", fake_deliver)

    async with db_session() as session:
        survey = ags_setup["survey"]
        r = SurveyResponse(survey_id=survey.id, answers={}, score=8.5, max_score=10.0,
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        response_id = r.id

    antes = asyncio.all_tasks()
    ags_module.schedule_score(response_id)
    nuevas = asyncio.all_tasks() - antes
    assert len(nuevas) == 1  # la tarea fire-and-forget que crea schedule_score
    await asyncio.gather(*nuevas)

    assert alcanzado.get("id") == response_id


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


# ── Important 1: grade passback en las rutas de corrección manual ────────────
#
# `schedule_score` tenía un solo trigger: `submit()`, gateado en que hubiera
# `score` al momento del envío. Un docente corrigiendo una nota de IA en
# `override_grade` (precisamente el workflow de `needs_review`), o re-corriendo
# con `grade_one`/`grade_all`, dejaba a Moodle mostrando la nota vieja para
# siempre -- ninguno de los tres avisaba al LMS.


@pytest.mark.asyncio
async def test_override_en_respuesta_lti_dispara_entrega(monkeypatch, lti_on, ags_setup):
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
    rid = r.json()["id"]
    # El submit ya disparó su propia entrega (score presente + contexto LTI):
    # se aísla lo que dispara puntualmente el override.
    llamados.clear()

    ov = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/override", json={"total": 2})
    assert ov.status_code == 200, ov.text
    assert len(llamados) == 1
    assert str(llamados[0]) == rid


@pytest.mark.asyncio
async def test_override_en_respuesta_no_lti_no_dispara_entrega(monkeypatch, lti_on):
    """Una respuesta que no vino de un lanzamiento LTI no tiene link al que
    avisar -- el override no debe intentar nada."""
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
    rid = r.json()["id"]

    ov = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/override", json={"total": 2})
    assert ov.status_code == 200, ov.text
    assert llamados == []


@pytest.mark.asyncio
async def test_grade_one_en_respuesta_lti_dispara_entrega(monkeypatch, lti_on, ags_setup, db_session):
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    from app.models import SurveyResponse

    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")

    async with db_session() as session:
        r = SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"},
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        rid = r.id

    resp = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/grade")
    assert resp.status_code == 200, resp.text
    assert llamados == [rid]


@pytest.mark.asyncio
async def test_grade_all_dispara_entrega_solo_para_las_lti(monkeypatch, lti_on, ags_setup, db_session):
    """`grade-all` corrige en lote: sólo las respuestas con `lti_link_id`
    tienen que disparar una entrega, y recién después del commit final del
    lote (no adentro del loop, donde la fila todavía no quedó persistida)."""
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    from app.models import SurveyResponse

    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")

    async with db_session() as session:
        r_lti = SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"},
                               lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        r_sin_lti = SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"})
        session.add(r_lti)
        session.add(r_sin_lti)
        await session.commit()
        rid_lti = r_lti.id

    resp = c.post(f"/api/v1/survey/surveys/{sv['id']}/grade-all")
    assert resp.status_code == 200, resp.text
    assert resp.json()["graded"] == 2

    assert llamados == [rid_lti]


# ── Minor: los tres triggers nuevos ignoraban LTI_ENABLED ───────────────────
#
# `submit()` sólo agenda una entrega si `_lti_context` encuentra contexto LTI,
# y esa función corta en seco si `LTI_ENABLED` está apagado (`app/routers/
# public.py::_lti_context`). Los tres triggers nuevos (`override_grade`,
# `grade_one`, `grade_all`) sólo chequeaban `r.lti_link_id is not None` -- una
# instancia que tuvo LTI prendido, acumuló respuestas con `lti_link_id`, y
# después lo apagó seguía mandando POSTs salientes al LMS en cada corrección
# manual. Ninguno de estos tests necesita `lti_on`: `ags_setup` inserta las
# filas de LTI a mano, y el flag corre en su default (apagado) salvo que se
# fuerce explícitamente -- que es justo lo que se prueba acá.


def _lti_apagado(monkeypatch, request):
    """Simétrico con el fixture `lti_on` de `conftest.py`: ese limpia la
    `lru_cache` de `get_settings` tanto al entrar como al salir. Acá, sin el
    `addfinalizer`, la cache quedaba limpia sólo a la entrada -- inofensivo
    hoy porque el valor cacheado coincide con el default ambiente, pero es el
    único lugar de la suite que deja una cache sucia al terminar."""
    from app.config import get_settings

    monkeypatch.delenv("LTI_ENABLED", raising=False)
    get_settings.cache_clear()
    request.addfinalizer(get_settings.cache_clear)
    assert get_settings().lti_enabled is False


@pytest.mark.asyncio
async def test_override_en_respuesta_lti_no_dispara_entrega_si_lti_esta_apagado(
    monkeypatch, ags_setup, db_session, request
):
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    from app.models import SurveyResponse

    _lti_apagado(monkeypatch, request)
    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")

    async with db_session() as session:
        r = SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"},
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        rid = r.id

    ov = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/override", json={"total": 2})
    assert ov.status_code == 200, ov.text
    assert llamados == []


@pytest.mark.asyncio
async def test_grade_one_en_respuesta_lti_no_dispara_entrega_si_lti_esta_apagado(
    monkeypatch, ags_setup, db_session, request
):
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    from app.models import SurveyResponse

    _lti_apagado(monkeypatch, request)
    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")

    async with db_session() as session:
        r = SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"},
                           lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r)
        await session.commit()
        rid = r.id

    resp = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/grade")
    assert resp.status_code == 200, resp.text
    assert llamados == []


@pytest.mark.asyncio
async def test_grade_all_no_dispara_entrega_si_lti_esta_apagado(
    monkeypatch, ags_setup, db_session, request
):
    from tests.conftest import new_client, register

    import app.lti.ags as ags_module
    from app.models import SurveyResponse

    _lti_apagado(monkeypatch, request)
    llamados = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))

    c = new_client()
    register(c)
    sv = c.post("/api/v1/survey/surveys",
                json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")

    async with db_session() as session:
        r_lti = SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"},
                               lti_link_id=ags_setup["link"].id, lti_sub="u-42")
        session.add(r_lti)
        await session.commit()

    resp = c.post(f"/api/v1/survey/surveys/{sv['id']}/grade-all")
    assert resp.status_code == 200, resp.text
    assert resp.json()["graded"] == 1

    assert llamados == []
