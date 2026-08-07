"""La nota de vuelta de `mod_encuestum`: del servicio web de Moodle para atrás.

Cuando una respuesta viene de una actividad del módulo nativo (no de un
`LtiResourceLink`), la nota no vuelve por AGS: vuelve por un POST al servicio
web que expone el propio plugin (`mod_encuestum_submit_grade`). El disparador es
el mismo de siempre -- `schedule_score`/`_deliver` en `app/lti/ags.py` -- porque
lo que cambia es el transporte, no el momento.

Cada protección de este archivo se verificó rompiéndola a propósito: si sacar la
protección no pone el test en rojo, el test no sirve. Está anotado en el
docstring de cada uno.
"""

import math
import time
import uuid

import httpx
import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlmodel import select

from app.models import MoodleSite, Survey, SurveyResponse
from tests.conftest import crear_org

WWWROOT = "https://moodle.mod-grades.test"
WS_URL = f"{WWWROOT}/webservice/rest/server.php"
WS_TOKEN = "token-de-servicio-de-moodle"
CMID = 4242
SUB = "hmac-opaco-del-alumno"

# Generar una RSA cuesta medio segundo, así que la única que hace falta se arma
# una sola vez para todo el archivo. Firma los lanzamientos de los dos tests de
# punta a punta; el resto no pasa por `/mod/launch`.
_PRIV = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUB = (
    _PRIV.public_key()
    .public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    .decode()
)


def _resp(status: int, json_body, url: str = WS_URL):
    """Respuesta de test con su `Request` adjunto. httpx sólo arma ese vínculo
    cuando la respuesta sale de una petición real del cliente; acá hay que
    simularlo o `raise_for_status()` revienta con `RuntimeError: request
    instance not set`, sin relación con el código bajo prueba."""
    return httpx.Response(status, json=json_body, request=httpx.Request("POST", url))


@pytest_asyncio.fixture
async def sitio(db_session):
    """Un sitio del módulo con su token de servicio, y una encuesta suya.

    La base es compartida entre tests de la misma corrida de pytest y
    `mod_sites` tiene unicidad por `wwwroot`, así que la fila previa se limpia
    antes de insertar (mismo patrón que `test_mod_launch.py`)."""
    async with db_session() as session:
        for previo in (
            await session.scalars(select(MoodleSite).where(MoodleSite.wwwroot == WWWROOT))
        ).all():
            await session.delete(previo)
        await session.commit()

        org_id = await crear_org(session, "Escuela de la nota")
        encuesta = Survey(
            org_id=org_id, title="Examen del módulo", status="published", json_schema={"pages": []}
        )
        sitio = MoodleSite(org_id=org_id, wwwroot=WWWROOT, public_key=_PUB, ws_token=WS_TOKEN)
        session.add_all([encuesta, sitio])
        await session.commit()
        return {"org_id": org_id, "survey_id": encuesta.id, "site_id": sitio.id}


async def _respuesta(db_session, sitio: dict, **over) -> uuid.UUID:
    """Una respuesta ya corregida, atribuida a la actividad del módulo."""
    campos = dict(
        survey_id=sitio["survey_id"],
        answers={},
        score=8.5,
        max_score=10.0,
        mod_site_id=sitio["site_id"],
        mod_cmid=CMID,
        mod_grademax=20.0,
        lti_sub=SUB,
    )
    campos.update(over)
    async with db_session() as session:
        r = SurveyResponse(**campos)
        session.add(r)
        await session.commit()
        return r.id


def _capturar(monkeypatch, respuesta=None):
    """Reemplaza el POST saliente y devuelve la lista de envíos capturados."""
    envios: list[dict] = []

    async def fake_post(self, url, **kw):
        envios.append({"url": url, "data": kw.get("data")})
        return respuesta if respuesta is not None else _resp(200, None)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return envios


def _sin_red(monkeypatch) -> list:
    """Cualquier request saliente es un fallo del test, no una excepción que se
    trague el `except` de `_deliver`: por eso se registra en la lista además de
    levantar."""
    intentos: list[str] = []

    async def fake_post(self, url, **kw):
        intentos.append(url)
        raise AssertionError(f"no debía salir ningún request y salió uno a {url}")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return intentos


# ── La escala ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_la_nota_se_reescala_a_la_escala_de_moodle(monkeypatch, mod_on, sitio, db_session):
    """Rúbrica sobre 10, `grade_item` de Moodle sobre 20: un 8,5 llega como 17.

    Roto a propósito: mandando `r.score` crudo, llega 8.5 y el test falla."""
    from app.lti.ags import _deliver

    envios = _capturar(monkeypatch)
    response_id = await _respuesta(db_session, sitio)

    await _deliver(response_id)

    assert len(envios) == 1
    envio = envios[0]
    assert envio["url"] == WS_URL
    datos = envio["data"]
    assert datos["wsfunction"] == "mod_encuestum_submit_grade"
    assert datos["moodlewsrestformat"] == "json"
    # El token viaja en el CUERPO, no en la query: es un bearer y en la query
    # queda en los logs de acceso de Moodle y de cualquier proxy del camino.
    assert datos["wstoken"] == WS_TOKEN
    assert "wstoken" not in envio["url"]
    assert int(datos["cmid"]) == CMID
    assert datos["sub"] == SUB
    assert float(datos["grade"]) == 17.0
    assert float(datos["max"]) == 20.0
    assert str(datos["needs_review"]) == "0"


@pytest.mark.asyncio
async def test_sin_grademax_la_escala_cae_en_100(monkeypatch, mod_on, sitio, db_session):
    """Un plugin viejo que todavía no manda `grademax` en el lanzamiento: la
    nota se publica sobre 100, que es el default de Moodle para un `grade_item`
    numérico. Lo que no puede pasar es que se mande la escala de la rúbrica
    haciéndola pasar por la de Moodle."""
    from app.lti.ags import _deliver

    envios = _capturar(monkeypatch)
    response_id = await _respuesta(db_session, sitio, mod_grademax=None)

    await _deliver(response_id)

    assert float(envios[0]["data"]["grade"]) == 85.0
    assert float(envios[0]["data"]["max"]) == 100.0


@pytest.mark.asyncio
async def test_needs_review_viaja_como_1(monkeypatch, mod_on, sitio, db_session):
    """Una respuesta marcada para revisión se publica como provisoria. Es el
    equivalente del `PendingManual` de AGS: si viajara como 0, el docente vería
    una nota definitiva que no lo es."""
    from app.lti.ags import _deliver

    envios = _capturar(monkeypatch)
    response_id = await _respuesta(db_session, sitio, needs_review=True)

    await _deliver(response_id)

    assert str(envios[0]["data"]["needs_review"]) == "1"


# ── Anonimato ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_una_actividad_anonima_no_genera_ninguna_llamada_saliente(
    monkeypatch, mod_on, sitio, db_session
):
    """Publicar una nota por alumno es, por definición, identificarlo: el
    anonimato y la nota van juntos. Una actividad anónima no guarda `sub` (lo
    filtra `/mod/launch` y lo vuelve a filtrar `submit`), así que acá no hay a
    quién calificar y no sale **ni un** request.

    Roto a propósito: sacando el guard de `lti_sub`, sale un POST con
    `sub=None` y el test falla en el `AssertionError` del doble."""
    from app.lti.ags import _deliver

    intentos = _sin_red(monkeypatch)
    response_id = await _respuesta(db_session, sitio, lti_sub=None)

    await _deliver(response_id)  # no debe propagar ni pegarle a la red

    assert intentos == []


@pytest.mark.asyncio
async def test_sin_ws_token_no_se_envia_nada(monkeypatch, mod_on, sitio, db_session):
    """Un sitio conectado sin token de servicio (el `ws_token` es opcional en el
    registro) no puede publicar notas. Sin este guard saldría un POST con
    `wstoken=None` que Moodle rechaza -- un intento fallido en vez de un
    "no se intentó", igual de silencioso pero con ruido en los logs de ellos."""
    from app.lti.ags import _deliver

    intentos = _sin_red(monkeypatch)
    async with db_session() as session:
        s = await session.get(MoodleSite, sitio["site_id"])
        s.ws_token = None
        session.add(s)
        await session.commit()

    response_id = await _respuesta(db_session, sitio)
    await _deliver(response_id)

    assert intentos == []


# ── El `wwwroot` se revalida en cada envío ───────────────────────────────────


@pytest.mark.asyncio
async def test_un_wwwroot_que_dejo_de_ser_https_no_recibe_el_token(
    monkeypatch, mod_on, sitio, db_session
):
    """`assert_public_url(..., require_https=True)` corre en CADA envío, no sólo
    al registrar: la fila pudo quedar apuntando a otro lado y este es un request
    que sale con un bearer token adentro.

    Roto a propósito: sacando la llamada a `assert_public_url`, el POST sale por
    HTTP plano con el `ws_token` en el cuerpo y el test falla."""
    from app.lti.ags import _deliver

    intentos = _sin_red(monkeypatch)
    async with db_session() as session:
        s = await session.get(MoodleSite, sitio["site_id"])
        s.wwwroot = "http://moodle.mod-grades.test"
        session.add(s)
        await session.commit()

    response_id = await _respuesta(db_session, sitio)
    await _deliver(response_id)

    assert intentos == []


# ── Los errores de Moodle ────────────────────────────────────────────────────


def _espiar_log(monkeypatch) -> dict:
    """El log de `ags.py` es el único diagnóstico que queda de una falla que
    para el docente es invisible.

    No se usa `caplog`: alembic corre `logging.config.fileConfig(...)` (con
    `disable_existing_loggers=True` por defecto) al migrar en el fixture de
    sesión, y eso deshabilita los loggers de `app.*` que ya existían. Es el
    mismo motivo por el que `test_lti_ags.py` espía el LOGGER a mano."""
    import app.lti.ags as ags_module

    logueado: dict = {}
    monkeypatch.setattr(
        ags_module.LOGGER,
        "warning",
        lambda msg, *args, **kw: logueado.update(msg=msg % args if args else msg, kwargs=kw),
    )
    return logueado


@pytest.mark.asyncio
async def test_un_500_de_moodle_no_propaga(monkeypatch, mod_on, sitio, db_session):
    """La respuesta del alumno YA está guardada: que Moodle esté caído no puede
    convertirse en un error de su submit. Lo único observable es que no lanza y
    que queda el log con el traceback.

    Roto a propósito: sacando el `except Exception` de `_deliver`, el
    `HTTPStatusError` sale por arriba y el test falla."""
    from app.lti.ags import _deliver

    _capturar(monkeypatch, respuesta=_resp(500, {"error": "moodle en llamas"}))
    logueado = _espiar_log(monkeypatch)
    response_id = await _respuesta(db_session, sitio)

    await _deliver(response_id)  # no debe propagar

    assert str(response_id) in logueado.get("msg", "")
    assert logueado.get("kwargs", {}).get("exc_info") is True


@pytest.mark.asyncio
async def test_un_200_con_exception_adentro_no_pasa_por_exito(
    monkeypatch, mod_on, sitio, db_session
):
    """El vicio de la API REST de Moodle: los errores vuelven con **HTTP 200** y
    un cuerpo `{"exception": ..., "message": ...}`. Un `raise_for_status()` los
    da por buenos y la nota nunca publicada queda como publicada.

    Roto a propósito: quitando la inspección del cuerpo, esto pasa en silencio y
    el test falla por no encontrar nada logueado."""
    from app.lti.ags import _deliver

    _capturar(
        monkeypatch,
        respuesta=_resp(
            200,
            {
                "exception": "webservice_access_exception",
                "errorcode": "accessexception",
                "message": "Control de acceso excepción",
            },
        ),
    )
    logueado = _espiar_log(monkeypatch)
    response_id = await _respuesta(db_session, sitio)

    await _deliver(response_id)

    assert str(response_id) in logueado.get("msg", ""), (
        "un 200 con `exception` en el cuerpo tiene que contarse como falla, no como éxito"
    )
    assert "accessexception" in logueado.get("msg", "")


@pytest.mark.asyncio
async def test_un_cuerpo_que_no_es_json_tampoco_pasa_por_exito(
    monkeypatch, mod_on, sitio, db_session
):
    """Un Moodle con `debugdisplay` prendido escupe HTML antes del JSON, y un
    proxy intermedio puede devolver su propia página de error con 200. Ninguno
    de los dos es una nota publicada."""
    from app.lti.ags import _deliver

    async def fake_post(self, url, **kw):
        return httpx.Response(
            200, text="<html>Fatal error</html>", request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    logueado = _espiar_log(monkeypatch)
    response_id = await _respuesta(db_session, sitio)

    await _deliver(response_id)

    assert str(response_id) in logueado.get("msg", "")


# ── El despacho ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_el_despacho_elige_el_transporte_por_el_origen(
    monkeypatch, mod_on, sitio, db_session
):
    """`_origen` es la única decisión de transporte que existe, y tiene tres
    salidas: el módulo, LTI, o nadie. Una respuesta pública (ni LTI ni módulo)
    cae en la tercera y no le pega a nadie.

    Se comprueba la decisión y no sólo su consecuencia porque los guards de
    `entregar_nota` son una segunda capa: con ellos puestos, casi cualquier
    error de despacho igual termina en "no salió ningún request", y el test
    pasaría por el motivo equivocado.

    Roto a propósito: haciendo que `_origen` devuelva `"mod"` para una respuesta
    sin origen, el test falla en el `assert` del despacho."""
    from app.lti.ags import _deliver, _origen

    intentos = _sin_red(monkeypatch)
    response_id = await _respuesta(db_session, sitio, mod_site_id=None, mod_cmid=None)

    assert await _origen(response_id) is None
    await _deliver(response_id)
    assert intentos == []

    con_modulo = await _respuesta(db_session, sitio)
    assert await _origen(con_modulo) == "mod"


@pytest.mark.asyncio
async def test_sin_cmid_no_se_envia_nada_ni_se_registra_una_falla(
    monkeypatch, mod_on, sitio, db_session
):
    """Sin `cmid` no hay actividad de Moodle a la que ponerle la nota. Es un
    lanzamiento de un plugin roto, no un caso normal.

    Se comprueba también que **no queda nada logueado**: sin el guard, el
    `int(None)` revienta más abajo, el `except` de `_deliver` se lo traga y el
    resultado observable (ningún request) es idéntico. La diferencia entre "no
    correspondía enviar" y "se intentó enviar y explotó" es justamente la que
    tiene que ver quien lea los logs.

    Roto a propósito: sacando el guard, queda un `TypeError` logueado y el test
    falla."""
    from app.lti.ags import _deliver

    intentos = _sin_red(monkeypatch)
    logueado = _espiar_log(monkeypatch)
    response_id = await _respuesta(db_session, sitio, mod_cmid=None)

    await _deliver(response_id)

    assert intentos == []
    assert logueado == {}, f"no correspondía enviar, pero quedó una falla: {logueado}"


@pytest.mark.asyncio
async def test_desconectar_el_moodle_deja_la_respuesta_en_pie_y_sin_nota(
    monkeypatch, mod_on, sitio, db_session
):
    """La FK es `ON DELETE SET NULL`: desconectar el sitio borra la fila de
    `mod_sites` y las respuestas quedan **en pie**, sin origen. Son datos del
    alumno, no del vínculo -- un CASCADE acá borraría las respuestas de un curso
    entero al desconectar un Moodle.

    Bajo Postgres el `ondelete` se aplica de verdad; en SQLite, que es donde
    corría esta suite antes, no pasaba nada y este test no probaba nada."""
    from app.lti.ags import _deliver

    intentos = _sin_red(monkeypatch)
    response_id = await _respuesta(db_session, sitio)
    async with db_session() as session:
        await session.delete(await session.get(MoodleSite, sitio["site_id"]))
        await session.commit()

    async with db_session() as session:
        r = await session.get(SurveyResponse, response_id)
        assert r is not None, "borrar el sitio no puede llevarse la respuesta del alumno"
        assert r.mod_site_id is None

    await _deliver(response_id)

    assert intentos == []


# ── El modelo: ida y vuelta por la base ──────────────────────────────────────


@pytest.mark.asyncio
async def test_el_origen_del_modulo_sobrevive_al_viaje_por_la_base(db_session, sitio):
    """Construir el modelo en memoria no prueba que la columna exista después de
    migrar: se escribe, se cierra la sesión y se relee desde otra.

    Roto a propósito: si las columnas no están en la migración, esto revienta
    con `UndefinedColumnError` en el INSERT."""
    response_id = await _respuesta(db_session, sitio)

    async with db_session() as session:
        r = await session.get(SurveyResponse, response_id)
        assert r is not None
        assert r.mod_site_id == sitio["site_id"]
        assert r.mod_cmid == CMID
        assert r.mod_grademax == 20.0
        assert r.lti_link_id is None


@pytest.mark.asyncio
async def test_una_respuesta_no_puede_tener_los_dos_origenes(db_session, sitio):
    """Una respuesta pertenece a un vínculo LTI **o** a un sitio del módulo,
    nunca a los dos: si el modelo permitiera las dos cosas, el despacho de la
    nota tendría un caso ambiguo que alguien resolvería mal (y probablemente
    publicaría la misma nota dos veces, por dos transportes distintos).

    Lo garantiza el motor, no la aplicación: un CHECK a nivel de tabla.

    Roto a propósito: sacando el `CheckConstraint` del modelo y de la 0022, el
    INSERT pasa y el test falla."""
    from sqlalchemy.exc import IntegrityError

    from app.models import LtiPlatform, LtiResourceLink

    async with db_session() as session:
        plataforma = LtiPlatform(
            issuer="https://moodle.mod-grades-lti.test",
            client_id=f"cid-{uuid.uuid4().hex[:8]}",
            deployment_ids=["1"],
            auth_login_url="https://moodle.mod-grades-lti.test/auth",
            auth_token_url="https://moodle.mod-grades-lti.test/token",
            jwks_url="https://moodle.mod-grades-lti.test/certs",
            org_id=sitio["org_id"],
        )
        session.add(plataforma)
        await session.commit()
        link = LtiResourceLink(
            platform_id=plataforma.id,
            resource_link_id=f"rl-{uuid.uuid4().hex[:8]}",
            survey_id=sitio["survey_id"],
        )
        session.add(link)
        await session.commit()

        session.add(
            SurveyResponse(
                survey_id=sitio["survey_id"],
                answers={},
                lti_link_id=link.id,
                mod_site_id=sitio["site_id"],
            )
        )
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()


# ── De punta a punta: el lanzamiento deja la respuesta lista para la nota ────


def _lanzar(client, sitio: dict, **over):
    """Un lanzamiento real: token firmado con la privada del sitio, por
    `GET /mod/launch`. La cookie queda en el cookiejar del cliente."""
    ahora = int(time.time())
    claims = {
        "iss": WWWROOT,
        "iat": ahora,
        "exp": ahora + 120,
        "jti": uuid.uuid4().hex,
        "site_id": str(sitio["site_id"]),
        "survey_id": str(sitio["survey_id"]),
        "cmid": CMID,
        "grademax": 20.0,
        "sub": SUB,
        "email": "ana@escuela.test",
        "name": "Ana Alumna",
        "anonymous": False,
    }
    claims.update(over)
    token = jwt.encode(claims, _PRIV, algorithm="RS256")
    return client.get("/mod/launch", params={"t": token}, follow_redirects=False)


@pytest.mark.asyncio
async def test_submit_guarda_de_que_actividad_del_modulo_vino_la_respuesta(
    mod_on, sitio, db_session
):
    """El hueco que esta tarea tapó: hasta acá la respuesta no guardaba NINGUNA
    referencia al sitio, al `cmid` ni a la escala, y la nota no tenía a dónde ir.

    Se prueba por el camino real y entero (Moodle firma -> `/mod/launch` ->
    cookie -> `submit`), no armando el `SurveyResponse` a mano: lo que hay que
    comprobar es que el dato sobrevive los tres saltos. En particular que
    `grademax` viaja en el token del lanzamiento -- si `/mod/launch` no lo
    copiara a la cookie, la nota se publicaría sobre 100 sin que nadie avise."""
    from fastapi.testclient import TestClient

    from app.main import app

    # La cookie del lanzamiento va `Secure`: sin HTTPS el cookiejar de httpx la
    # descarta en silencio y el submit fallaría por el motivo equivocado.
    client = TestClient(app, base_url="https://testserver")
    assert _lanzar(client, sitio).status_code == 302

    async with db_session() as session:
        slug = (await session.get(Survey, sitio["survey_id"])).slug

    r = client.post(
        f"/api/v1/survey/public/{slug}/submit",
        json={"answers": {"q1": "hola"}, "completed": True},
    )
    assert r.status_code == 201, r.text

    async with db_session() as session:
        fila = await session.get(SurveyResponse, uuid.UUID(r.json()["id"]))
        assert fila.mod_site_id == sitio["site_id"]
        assert fila.mod_cmid == CMID
        assert fila.mod_grademax == 20.0
        assert fila.lti_sub == SUB
        # Los dos orígenes son excluyentes: un lanzamiento del módulo no tiene
        # `LtiResourceLink`.
        assert fila.lti_link_id is None


@pytest.mark.asyncio
async def test_un_cmid_fuera_del_rango_de_la_columna_no_tumba_el_submit(
    mod_on, sitio, db_session
):
    """`mod_cmid` es un `Integer` (un `int4` de Postgres). Un `cmid` de 13
    dígitos pasa `int()` sin problema, entra al `SurveyResponse` y revienta en
    el INSERT: `asyncpg.exceptions.DataError: value out of int32 range`. Y como
    el `cmid` viaja en el MISMO INSERT que la respuesta del alumno, **se pierde
    la respuesta entera** -- un 500 en el submit de alguien que contestó
    perfecto. Es el modo de falla que `_sitio_del_modulo` fue agregado para
    evitar, por el mismo camino y con el mismo remedio: fuera de rango -> NULL,
    la respuesta se guarda y lo único que falta es la nota.

    Verificado que discrimina: sacando la comprobación de rango de `_entero`
    (`app/routers/public.py`), el submit falla con `DataError` y este test se
    pone en rojo antes del primer assert."""
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app, base_url="https://testserver")
    assert _lanzar(client, sitio, cmid=10**12).status_code == 302

    async with db_session() as session:
        slug = (await session.get(Survey, sitio["survey_id"])).slug

    r = client.post(
        f"/api/v1/survey/public/{slug}/submit",
        json={"answers": {"q1": "hola"}, "completed": True},
    )
    assert r.status_code == 201, r.text

    async with db_session() as session:
        fila = await session.get(SurveyResponse, uuid.UUID(r.json()["id"]))
        assert fila.mod_cmid is None
        # El origen sí se guarda: lo que se descarta es el claim que no entra en
        # la columna, no la atribución entera.
        assert fila.mod_site_id == sitio["site_id"]


@pytest.mark.asyncio
async def test_un_grademax_infinito_no_se_guarda_ni_sale_como_nota(
    monkeypatch, mod_on, sitio, db_session
):
    """`float("inf") > 0` es `True`, así que `inf` pasaba el único filtro de
    `_flotante`. Y `inf` es un valor que un token puede traer de verdad: el
    `json` de la stdlib serializa y parsea `Infinity` por defecto, y PyJWT usa
    ese `json` tal cual.

    De punta a punta, sin el arreglo: la cookie lleva `grademax: inf`, la fila
    lo guarda, `reescalar` devuelve `inf` y sale `grade=inf` en el POST al
    servicio web -- donde PHP lo castea a **0**. Nota cero, en silencio, sin un
    solo error en ningún lado. Por eso el test mira las dos puntas: la columna
    y el cuerpo que sale.

    Verificado que discrimina: sacando `math.isfinite` de `_flotante`
    (`app/routers/public.py`), la fila guarda `inf` y el POST sale con
    `grade=inf`."""
    from fastapi.testclient import TestClient

    from app.lti.ags import _deliver
    from app.main import app

    client = TestClient(app, base_url="https://testserver")
    assert _lanzar(client, sitio, grademax=float("inf")).status_code == 302

    async with db_session() as session:
        slug = (await session.get(Survey, sitio["survey_id"])).slug

    r = client.post(
        f"/api/v1/survey/public/{slug}/submit",
        json={"answers": {"q1": "hola"}, "completed": True},
    )
    assert r.status_code == 201, r.text
    response_id = uuid.UUID(r.json()["id"])

    async with db_session() as session:
        fila = await session.get(SurveyResponse, response_id)
        assert fila.mod_grademax is None, "una escala infinita no se puede guardar"
        # La encuesta del fixture no tiene evaluación, así que el submit no dejó
        # nota: se pone a mano para poder mirar la otra punta (lo que sale).
        fila.score, fila.max_score = 8.5, 10.0
        session.add(fila)
        await session.commit()

    envios = _capturar(monkeypatch)
    await _deliver(response_id)

    assert len(envios) == 1
    grade = float(envios[0]["data"]["grade"])
    assert math.isfinite(grade), f"salió una nota no finita: {grade}"
    # Sin `grademax` la escala cae en el default de Moodle (100), no en `inf`.
    assert grade == 85.0
    assert float(envios[0]["data"]["max"]) == 100.0


@pytest.mark.asyncio
async def test_una_actividad_anonima_no_guarda_ni_el_sub_ni_la_escala_de_nadie(
    mod_on, sitio, db_session
):
    """El origen (sitio y `cmid`) sí se guarda con la actividad anónima: sirve
    para el panel y no identifica a nadie. Lo que no se guarda es el `sub`, y
    es justamente eso lo que corta la publicación de la nota más adelante, sin
    ningún request saliente."""
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app, base_url="https://testserver")
    assert _lanzar(client, sitio, anonymous=True).status_code == 302

    async with db_session() as session:
        slug = (await session.get(Survey, sitio["survey_id"])).slug

    r = client.post(
        f"/api/v1/survey/public/{slug}/submit",
        json={"answers": {"q1": "hola"}, "completed": True},
    )
    assert r.status_code == 201, r.text

    async with db_session() as session:
        fila = await session.get(SurveyResponse, uuid.UUID(r.json()["id"]))
        assert fila.mod_site_id == sitio["site_id"]
        assert fila.mod_cmid == CMID
        assert fila.lti_sub is None
        assert fila.respondent_email is None


# ── La recorrección: los tres triggers manuales y el módulo ──────────────────
#
# `submit()` no es el único disparador de una nota: `override_grade`,
# `grade_one` y `grade_all` (`app/routers/evaluation.py`) publican la nota
# recorregida. Los tres quedaron hablando sólo de LTI, con dos bugs que dan el
# mismo síntoma y se tapan entre sí:
#
#   a) el gate miraba `LTI_ENABLED` en vez de `LTI_ENABLED or MOD_ENABLED`, y
#   b) el filtro de cada trigger era `r.lti_link_id is not None`, que excluye al
#      módulo POR CONSTRUCCIÓN: una respuesta del módulo tiene `lti_link_id` en
#      NULL siempre, y lo garantiza el CHECK `ck_survey_responses_un_solo_origen`.
#
# O sea que la instalación que la Fase A viene a habilitar -- sólo el módulo
# nativo, `MOD_ENABLED=1` y `LTI_ENABLED=0` -- nunca republicaba una nota
# recorregida, y sin ningún error visible para nadie.

_SCHEMA = {"pages": [{"name": "p", "elements": [
    {"type": "radiogroup", "name": "cap", "title": "Capital", "choices": ["Madrid", "Paris"]},
]}]}
_EVAL = {"enabled": True, "passingScore": 60, "questions": {
    "cap": {"gradable": True, "grader": "auto", "points": 2, "correct": "Paris"},
}}


def _espiar_schedule(monkeypatch) -> list:
    """Intercepta `schedule_score` -- el disparador único de los dos
    transportes -- para ver qué se agenda sin ejercitar la entrega."""
    import app.lti.ags as ags_module

    llamados: list = []
    monkeypatch.setattr(ags_module, "schedule_score", lambda rid: llamados.append(rid))
    return llamados


def _encuesta_evaluable(client):
    """Una encuesta publicada con evaluación: `grade_one`/`grade_all` devuelven
    400 sobre una que no lo sea."""
    sv = client.post(
        "/api/v1/survey/surveys",
        json={"title": "E", "json_schema": _SCHEMA, "evaluation": _EVAL},
    ).json()
    client.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    return sv


async def _respuesta_del_modulo(db_session, sitio: dict, survey_id: uuid.UUID) -> uuid.UUID:
    """Una respuesta atribuida a la actividad del módulo, sin corregir todavía.

    `lti_link_id` queda en NULL, que es lo que el CHECK obliga y lo que el
    filtro viejo tomaba por "no vino de ningún LMS"."""
    async with db_session() as session:
        r = SurveyResponse(
            survey_id=survey_id,
            answers={"cap": "Paris"},
            mod_site_id=sitio["site_id"],
            mod_cmid=CMID,
            mod_grademax=20.0,
            lti_sub=SUB,
        )
        session.add(r)
        await session.commit()
        return r.id


@pytest.mark.asyncio
async def test_override_en_respuesta_del_modulo_dispara_entrega(
    monkeypatch, mod_on, sitio, db_session
):
    """El override manual es EL workflow de `needs_review`: un docente
    corrigiendo una nota de IA. Con sólo el módulo prendido no llegaba nunca al
    libro de Moodle.

    Verificado que discrimina, y de las dos formas -- los dos bugs dan el mismo
    síntoma:
      - volviendo el gate a `if not get_settings().lti_enabled`, `llamados`
        queda vacío (MOD=1, LTI=0);
      - volviendo el filtro a `r.lti_link_id is not None`, también."""
    from tests.conftest import new_client, register

    llamados = _espiar_schedule(monkeypatch)
    c = new_client()
    register(c)
    sv = _encuesta_evaluable(c)
    rid = await _respuesta_del_modulo(db_session, sitio, uuid.UUID(sv["id"]))

    ov = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/override", json={"total": 2})
    assert ov.status_code == 200, ov.text
    assert llamados == [rid]


@pytest.mark.asyncio
async def test_grade_one_en_respuesta_del_modulo_dispara_entrega(
    monkeypatch, mod_on, sitio, db_session
):
    """Re-corrida individual: misma historia que el override."""
    from tests.conftest import new_client, register

    llamados = _espiar_schedule(monkeypatch)
    c = new_client()
    register(c)
    sv = _encuesta_evaluable(c)
    rid = await _respuesta_del_modulo(db_session, sitio, uuid.UUID(sv["id"]))

    resp = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/grade")
    assert resp.status_code == 200, resp.text
    assert llamados == [rid]


@pytest.mark.asyncio
async def test_grade_all_dispara_entrega_para_las_del_modulo(
    monkeypatch, mod_on, sitio, db_session
):
    """La re-corrida masiva encolaba con `if r.lti_link_id is not None`, que
    para una respuesta del módulo es `False` **siempre**. Se corrigen las dos
    (la del módulo y una pública) y sólo la del módulo tiene a dónde avisar.

    Verificado que discrimina: con el filtro viejo, `llamados` queda vacío."""
    from tests.conftest import new_client, register

    llamados = _espiar_schedule(monkeypatch)
    c = new_client()
    register(c)
    sv = _encuesta_evaluable(c)
    rid = await _respuesta_del_modulo(db_session, sitio, uuid.UUID(sv["id"]))
    async with db_session() as session:
        session.add(SurveyResponse(survey_id=uuid.UUID(sv["id"]), answers={"cap": "Paris"}))
        await session.commit()

    resp = c.post(f"/api/v1/survey/surveys/{sv['id']}/grade-all")
    assert resp.status_code == 200, resp.text
    assert resp.json()["graded"] == 2

    assert llamados == [rid]


def _todo_apagado(monkeypatch, request) -> None:
    """Ni LTI ni el módulo. Simétrico con los fixtures `lti_on`/`mod_on`: hay
    que limpiar la `lru_cache` de `get_settings` al entrar **y** al salir."""
    from app.config import get_settings

    monkeypatch.delenv("LTI_ENABLED", raising=False)
    monkeypatch.delenv("MOD_ENABLED", raising=False)
    get_settings.cache_clear()
    request.addfinalizer(get_settings.cache_clear)
    assert get_settings().lti_enabled is False
    assert get_settings().mod_enabled is False


@pytest.mark.asyncio
async def test_con_todo_apagado_una_recorreccion_del_modulo_no_agenda_nada(
    monkeypatch, sitio, db_session, request
):
    """La otra mitad del gate: ensancharlo a `lti_enabled or mod_enabled` no
    puede volverlo un `True` constante. Con las dos banderas apagadas, una
    corrección manual sobre una respuesta vieja del módulo no agenda nada.

    Verificado que discrimina: sacando el `return` temprano de `_agendar_nota`,
    este test se pone en rojo."""
    from tests.conftest import new_client, register

    _todo_apagado(monkeypatch, request)
    llamados = _espiar_schedule(monkeypatch)
    c = new_client()
    register(c)
    sv = _encuesta_evaluable(c)
    rid = await _respuesta_del_modulo(db_session, sitio, uuid.UUID(sv["id"]))

    ov = c.post(f"/api/v1/survey/surveys/{sv['id']}/responses/{rid}/override", json={"total": 2})
    assert ov.status_code == 200, ov.text
    assert llamados == []


# ── `MOD_ENABLED=0` corta la publicación saliente ────────────────────────────


@pytest.mark.asyncio
async def test_con_mod_enabled_apagado_no_sale_ningun_post_con_el_ws_token(
    monkeypatch, sitio, db_session, request
):
    """CRÍTICO como interruptor de emergencia. `MOD_ENABLED=0` apagaba el router
    (`/mod/register`, `/mod/launch`) pero **no** la publicación de notas: las
    filas no se borran al bajar la bandera -- una respuesta guarda su
    `mod_site_id` para siempre -- así que cualquier recorrección seguía sacando
    un POST real al `wwwroot` con el `ws_token` del sitio en el cuerpo. Que es
    justo la credencial por la que alguien apagaría el módulo de apuro.

    El repositorio ya había decidido que esto importa: el docstring del gate de
    LTI dice, con todas las letras, que "LTI apagado tiene que significar que
    nada de este módulo le habla al LMS, no sólo que no se generen links
    nuevos". El módulo no había heredado la regla.

    Se comprueba la decisión de `_origen` y no sólo su consecuencia: los guards
    de `entregar_nota` son una segunda capa y casi cualquier error de despacho
    termina igual en "no salió ningún request", lo que haría pasar el test por
    el motivo equivocado.

    Verificado que discrimina: sacando el gate de `_origen` (`app/lti/ags.py`),
    `_origen` devuelve `"mod"` e `intentos` queda con la URL del POST -- el
    mismo request que la revisión capturó con el token adentro."""
    from app.lti.ags import _deliver, _origen

    _todo_apagado(monkeypatch, request)
    intentos = _sin_red(monkeypatch)
    response_id = await _respuesta(db_session, sitio)

    assert await _origen(response_id) is None
    await _deliver(response_id)
    assert intentos == [], "con MOD_ENABLED=0 no puede salir ni un request al LMS"
