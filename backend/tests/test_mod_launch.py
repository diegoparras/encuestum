"""Lanzamiento firmado de `mod_encuestum` (`GET /mod/launch?t=<JWT>`).

Moodle firma un token corto con **su clave privada RSA** y Encuestum lo canjea
por la cookie de sesión que ya usa LTI. Todo lo que separa a un alumno de
cualquier otro -- y a una escuela de otra -- son las cinco validaciones de este
archivo, así que cada una tiene su test y cada test se verificó rompiendo la
validación a propósito (está anotado en el docstring de cada uno: si sacar una
protección no pone ningún test en rojo, ese test no sirve).

La cookie es la MISMA que la de LTI (`enc_lti`, `LTI_PURPOSE`): `_lti_context`
de `routers/public.py` ya sabe leerla y saltear el PIN con ella. Por eso los
dos últimos tests del archivo llegan hasta `submit` -- lo que importa no es que
`/mod/launch` devuelva 302, sino que el alumno pueda responder y que la
respuesta quede atribuida (o no, si la actividad es anónima) como corresponde.
"""

import base64
import hashlib
import hmac
import json
import time
import uuid

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlmodel import select

from app.lti.state import LTI_COOKIE, LTI_PURPOSE
from app.main import app
from app.models import MoodleSite, Survey, SurveyResponse
from app.security import read_purpose_token
from tests.conftest import crear_org

WWWROOT = "https://moodle.mod-launch.test"
WWWROOT_AJENO = "https://moodle.mod-launch-ajeno.test"


# ── Claves de prueba ─────────────────────────────────────────────────────────
#
# Generar RSA cuesta medio segundo por clave, así que las dos que hacen falta se
# arman una sola vez: la del sitio registrado y la de "cualquier otro" (el
# atacante que firma con una clave que Encuestum no conoce).


def _par() -> tuple[rsa.RSAPrivateKey, str]:
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return priv, pub


_PRIV, _PUB = _par()
_PRIV_AJENA, _PUB_AJENA = _par()


def _client() -> TestClient:
    """La cookie del lanzamiento va `Secure`, así que el TestClient tiene que
    hablar HTTPS o el cookiejar de httpx la descarta en silencio y los tests
    que la usan fallarían por el motivo equivocado."""
    return TestClient(app, base_url="https://testserver")


@pytest_asyncio.fixture
async def sitio(db_session):
    """Un sitio Moodle registrado, su encuesta (con PIN) y la encuesta de OTRA
    organización, que es contra la que se prueba el acceso cruzado."""
    async with db_session() as session:
        for previo in (
            await session.scalars(
                select(MoodleSite).where(MoodleSite.wwwroot.in_([WWWROOT, WWWROOT_AJENO]))
            )
        ).all():
            await session.delete(previo)
        await session.commit()

        org_id = await crear_org(session, "Escuela del módulo")
        org_ajena = await crear_org(session, "Escuela ajena al módulo")
        encuesta = Survey(
            org_id=org_id, title="Examen del módulo", status="published",
            access_mode="pin", access_pin="1234", json_schema={"pages": []},
        )
        ajena = Survey(
            org_id=org_ajena, title="Examen de la otra escuela", status="published",
            access_mode="pin", access_pin="1234", json_schema={"pages": []},
        )
        sitio = MoodleSite(org_id=org_id, wwwroot=WWWROOT, public_key=_PUB, name="Escuela")
        session.add_all([encuesta, ajena, sitio])
        await session.commit()
        return {
            "site_id": sitio.id,
            "org_id": org_id,
            "survey_id": encuesta.id,
            "slug": encuesta.slug,
            "survey_ajena_id": ajena.id,
            "slug_ajena": ajena.slug,
        }


class _Sin:
    """Marcador para sacar un claim del token: `exp: null` y "sin exp" entran
    por caminos distintos de PyJWT, así que hay que poder probar el segundo."""


_SIN = _Sin()


def _claims(sitio: dict, **over) -> dict:
    ahora = int(time.time())
    claims = {
        "iss": WWWROOT,
        "iat": ahora,
        "exp": ahora + 120,
        "jti": uuid.uuid4().hex,
        "site_id": str(sitio["site_id"]),
        "survey_id": str(sitio["survey_id"]),
        "cmid": 42,
        "course_id": 7,
        "context_title": "Historia",
        # El `sub` es un HMAC que calcula Moodle con un secreto suyo: no es el
        # id del usuario y Encuestum nunca lo reproduce.
        "sub": "hmac-opaco-del-alumno",
        "name": "Ana Alumna",
        "email": "ana@escuela.test",
        "roles": ["student"],
        "anonymous": False,
    }
    claims.update(over)
    return {k: v for k, v in claims.items() if v is not _SIN}


def _firmar(claims: dict, priv=None) -> str:
    return jwt.encode(claims, priv or _PRIV, algorithm="RS256")


def _b64(dato) -> str:
    crudo = dato if isinstance(dato, bytes) else json.dumps(dato).encode()
    return base64.urlsafe_b64encode(crudo).rstrip(b"=").decode()


def _firmar_hs256(claims: dict, secreto: str) -> str:
    """Un token HS256 armado a mano. `jwt.encode` se niega a firmar HMAC con
    una clave con forma de PEM, así que la herramienta que rechaza el ataque no
    puede usarse para montarlo -- y un atacante no usaría PyJWT de todas
    formas."""
    partes = f"{_b64({'alg': 'HS256', 'typ': 'JWT'})}.{_b64(claims)}"
    firma = hmac.new(secreto.encode(), partes.encode(), hashlib.sha256).digest()
    return f"{partes}.{_b64(firma)}"


def _lanzar(client: TestClient, token: str):
    return client.get("/mod/launch", params={"t": token}, follow_redirects=False)


def _cookie_del_lanzamiento(respuesta) -> dict:
    """Los datos que quedaron dentro de la cookie `enc_lti` que sembró el
    lanzamiento."""
    datos = read_purpose_token(LTI_PURPOSE, respuesta.cookies.get(LTI_COOKIE) or "")
    assert datos is not None, "el lanzamiento no sembró la cookie"
    return datos


# ── El camino feliz ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lanzamiento_valido_redirige_a_la_encuesta_y_siembra_la_cookie(mod_on, sitio):
    client = _client()
    r = _lanzar(client, _firmar(_claims(sitio)))

    assert r.status_code == 302, r.text
    assert r.headers["location"] == f"/s/{sitio['slug']}"

    # La cookie viaja dentro del iframe de Moodle: sin `Secure; SameSite=None`
    # el navegador la descarta y el alumno cae en la pantalla del PIN.
    cabecera = "".join(r.headers.get_list("set-cookie")).lower()
    assert "samesite=none" in cabecera
    assert "secure" in cabecera

    datos = _cookie_del_lanzamiento(r)
    assert datos["slug"] == sitio["slug"]
    assert datos["sub"] == "hmac-opaco-del-alumno"
    assert datos["email"] == "ana@escuela.test"


@pytest.mark.asyncio
async def test_el_iss_se_compara_en_forma_canonica(mod_on, sitio):
    """El `wwwroot` se guarda canónico (`_normalizar_wwwroot` de la Tarea 1),
    pero el `iss` llega como lo escribió Moodle. Sin normalizarlo antes de
    comparar, un `wwwroot` con barra final -- o en mayúsculas -- no matchea
    nunca y el síntoma aparece lejísimos de la causa.

    Verificado que discrimina: comparando `claims["iss"] != site.wwwroot` a
    secas, este test da 401."""
    r = _lanzar(_client(), _firmar(_claims(sitio, iss=f"{WWWROOT.upper().replace('HTTPS', 'https')}/")))
    assert r.status_code == 302, r.text


# ── Validación 1: la firma tiene que ser la de ESE sitio ─────────────────────


@pytest.mark.asyncio
async def test_firmado_con_otra_clave_da_401(mod_on, sitio):
    """CRÍTICO. Si la firma no se verifica contra la clave pública de ese
    `site_id`, cualquiera que sepa un `site_id` y un `survey_id` lanza como
    cualquier alumno de cualquier curso.

    Verificado que discrimina: sacando la verificación de firma (decodificar
    con `verify_signature: False`), este test devuelve 302."""
    r = _lanzar(_client(), _firmar(_claims(sitio), priv=_PRIV_AJENA))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_token_manoseado_da_401(mod_on, sitio):
    token = _firmar(_claims(sitio))
    cabecera, cuerpo, firma = token.split(".")
    # Se le cambia un carácter a la firma: el resto del token queda intacto.
    firma_rota = ("A" if firma[0] != "A" else "B") + firma[1:]
    r = _lanzar(_client(), f"{cabecera}.{cuerpo}.{firma_rota}")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_site_id_desconocido_da_401(mod_on, sitio):
    """Sin sitio no hay clave con qué verificar. 401 y no 404: quién tiene un
    Moodle conectado no es información que corresponda filtrar."""
    r = _lanzar(_client(), _firmar(_claims(sitio, site_id=str(uuid.uuid4()))))
    assert r.status_code == 401, r.text


# ── Validación 5: el algoritmo es exactamente RS256 ──────────────────────────


@pytest.mark.asyncio
async def test_confusion_de_algoritmo_hs256_da_401(mod_on, sitio):
    """CRÍTICO. La confusión de algoritmo clásica: si `jwt.decode` aceptara
    HS256, el atacante firma un token con la clave **pública** (que es pública:
    la manda Moodle y no es secreta) usada como secreto HMAC, y valida
    perfecto. Por eso `algorithms=["RS256"]` va explícito y NUNCA se lee del
    header del token.

    El token va armado a mano: `jwt.encode` se niega a firmar HS256 con un PEM
    (PyJWT 2.x). Un atacante no usaría PyJWT, así que el test tampoco."""
    r = _lanzar(_client(), _firmar_hs256(_claims(sitio), _PUB))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_alg_none_da_401(mod_on, sitio):
    """La otra mitad de la misma familia: un token sin firma."""
    cabecera = _b64({"alg": "none", "typ": "JWT"})
    r = _lanzar(_client(), f"{cabecera}.{_b64(_claims(sitio))}.")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_el_algoritmo_no_sale_del_token(mod_on, sitio, monkeypatch):
    """CRÍTICO, y el único test de este archivo que mira para adentro. Motivo:
    los dos de arriba **no discriminan solos**. Con `algorithms=["RS256",
    "HS256"]` siguen dando 401, porque PyJWT 2.x tiene su propia barrera --
    `prepare_key` de HMAC rechaza cualquier clave con forma de PEM
    (`InvalidKeyError`), y `alg: none` con clave no vacía también. O sea que
    hoy, por casualidad de la versión, romper NUESTRA validación no pone nada
    en rojo: exactamente el caso que el encargo pide no dejar pasar.

    Así que acá se afirma el invariante directamente: la lista de algoritmos
    que recibe `jwt.decode` es constante y es `["RS256"]`. Si alguien la
    ensancha, o la arma leyendo el header del token, este test se cae -- que es
    lo que la fila de la tabla realmente exige."""
    from app.mod import launch as mod_launch

    vistos: list = []
    original = jwt.decode

    def espia(token, key=None, **kw):
        # `site_id_declarado` también decodifica, pero sin firma ni algoritmos:
        # sólo interesa la llamada que verifica.
        if "algorithms" in kw:
            vistos.append(kw["algorithms"])
        return original(token, key, **kw)

    monkeypatch.setattr(mod_launch.jwt, "decode", espia)
    assert _lanzar(_client(), _firmar(_claims(sitio))).status_code == 302

    assert vistos == [["RS256"]], f"jwt.decode recibió {vistos}"


# ── Validación 2: exp presente y a lo sumo iat + 120 ─────────────────────────


@pytest.mark.asyncio
async def test_token_vencido_da_401(mod_on, sitio):
    ahora = int(time.time())
    r = _lanzar(_client(), _firmar(_claims(sitio, iat=ahora - 300, exp=ahora - 60)))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_token_sin_exp_da_401(mod_on, sitio):
    """Sin `exp`, PyJWT no tiene nada que chequear y el token sirve para
    siempre. Se exige explícitamente con `options={"require": [...]}`.

    Verificado que discrimina: sacando `exp` de la lista de requeridos, este
    test devuelve 302."""
    r = _lanzar(_client(), _firmar(_claims(sitio, exp=_SIN)))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_ventana_mas_larga_que_120s_da_401(mod_on, sitio):
    """CRÍTICO y el que más fácil se implementa mal: un token que vence dentro
    de una hora *no está vencido*, así que PyJWT lo acepta sin chistar. Quien
    vea la URL de lanzamiento una vez (historial, logs del proxy, un
    `Referer`) la puede volver a usar durante toda esa ventana. El límite
    `exp <= iat + 120` es un chequeo aparte, a mano.

    Verificado que discrimina: sacando la comparación contra `MAX_VIDA_S`,
    este test devuelve 302."""
    ahora = int(time.time())
    r = _lanzar(_client(), _firmar(_claims(sitio, iat=ahora, exp=ahora + 3600)))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_sin_iat_da_401(mod_on, sitio):
    """Sin `iat` no hay contra qué medir la ventana de 120 s: un token sin
    `iat` y con `exp` lejano pasaría el chequeo de arriba por no tener con qué
    compararse."""
    r = _lanzar(_client(), _firmar(_claims(sitio, iat=_SIN)))
    assert r.status_code == 401, r.text


# ── Validación 3: el jti es de un solo uso ───────────────────────────────────


@pytest.mark.asyncio
async def test_jti_repetido_da_401(mod_on, sitio):
    """CRÍTICO. Sin consumo del `jti`, el mismo token vale todas las veces que
    se quiera mientras dure el `exp`: quien vea la URL una vez repite el
    lanzamiento y entra como ese alumno.

    Verificado que discrimina: sacando `consumir_jti`, el segundo lanzamiento
    devuelve 302."""
    client = _client()
    token = _firmar(_claims(sitio))

    primero = _lanzar(client, token)
    assert primero.status_code == 302, primero.text

    segundo = _lanzar(_client(), token)
    assert segundo.status_code == 401, segundo.text


@pytest.mark.asyncio
async def test_token_sin_jti_da_401(mod_on, sitio):
    """Sin `jti` no hay nada que consumir, así que un token sin ese claim sería
    replayable justamente por faltarle la defensa. Se exige, no se tolera."""
    r = _lanzar(_client(), _firmar(_claims(sitio, jti=_SIN)))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_el_jti_solo_se_consume_si_la_firma_era_valida(mod_on, sitio):
    """Un token con firma inválida no debe quemar el `jti`: si se consumiera
    antes de verificar, cualquiera podría anular el lanzamiento legítimo de un
    alumno mandando primero un token falso con el mismo `jti` (denegación de
    servicio, y además engorda un caché en memoria sin autenticación de por
    medio)."""
    claims = _claims(sitio)
    falso = _lanzar(_client(), _firmar(claims, priv=_PRIV_AJENA))
    assert falso.status_code == 401, falso.text

    bueno = _lanzar(_client(), _firmar(claims))
    assert bueno.status_code == 302, bueno.text


# ── Validación 4: la encuesta es de la organización del sitio ────────────────


@pytest.mark.asyncio
async def test_encuesta_de_otra_organizacion_da_404(mod_on, sitio):
    """CRÍTICO. Es el mismo chequeo cross-tenant que ya hace
    `_resource_link_redirect` para LTI. Sin él, un Moodle conectado lanza
    encuestas de cualquier otra escuela con sólo poner otro `survey_id` en un
    token que él mismo firma -- y la firma es válida, porque la firmó él.

    Verificado que discrimina: sacando la comparación `survey.org_id !=
    site.org_id`, este test devuelve 302 y la cookie queda sembrada para el
    slug de la otra escuela."""
    r = _lanzar(_client(), _firmar(_claims(sitio, survey_id=str(sitio["survey_ajena_id"]))))
    assert r.status_code == 404, r.text
    assert LTI_COOKIE not in r.cookies


@pytest.mark.asyncio
async def test_encuesta_inexistente_da_404(mod_on, sitio):
    r = _lanzar(_client(), _firmar(_claims(sitio, survey_id=str(uuid.uuid4()))))
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_survey_id_que_no_es_uuid_da_400(mod_on, sitio):
    r = _lanzar(_client(), _firmar(_claims(sitio, survey_id="no-soy-un-uuid")))
    assert r.status_code == 400, r.text


# ── La cookie sirve de verdad: entra sin PIN y la respuesta queda atribuida ──


@pytest.mark.asyncio
async def test_la_cookie_del_lanzamiento_saltea_el_pin_y_permite_responder(mod_on, sitio):
    """Lo que importa no es el 302: es que el alumno pueda responder. La cookie
    es la misma de LTI a propósito, para que `_lti_context` de `public.py` la
    lea sin aprender una segunda.

    Ojo: este test corre con LTI **apagado** (no usa `lti_on`), que es el caso
    real de una instalación que sólo tiene el módulo nativo. Verificado que
    discrimina: con el `if not lti_enabled: return None` original de
    `_lti_context`, la encuesta sigue viniendo `gated` y el submit da 403."""
    slug = sitio["slug"]
    sin_cookie = _client().get(f"/api/v1/survey/public/{slug}")
    assert sin_cookie.json()["gated"] is True

    client = _client()
    assert _lanzar(client, _firmar(_claims(sitio))).status_code == 302

    con_cookie = client.get(f"/api/v1/survey/public/{slug}")
    assert con_cookie.json()["gated"] is False

    r = client.post(
        f"/api/v1/survey/public/{slug}/submit",
        json={"answers": {"q1": "hola"}, "completed": True},
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_la_respuesta_queda_atribuida_al_sub_de_moodle(mod_on, sitio, db_session):
    """`lti_link_id` queda en NULL -- un lanzamiento del módulo no tiene fila de
    vínculo LTI --, pero la identidad sí se guarda. Si `submit` leyera
    `lti["link_id"]` a secas (como hacía antes de esta tarea), esto reventaría
    con un 500 por KeyError."""
    client = _client()
    assert _lanzar(client, _firmar(_claims(sitio))).status_code == 302

    r = client.post(
        f"/api/v1/survey/public/{sitio['slug']}/submit",
        json={"answers": {"q1": "atribuida"}, "completed": True},
    )
    assert r.status_code == 201, r.text

    async with db_session() as session:
        fila = (
            await session.scalars(
                select(SurveyResponse).where(SurveyResponse.id == uuid.UUID(r.json()["id"]))
            )
        ).one()
        assert fila.lti_link_id is None
        assert fila.lti_sub == "hmac-opaco-del-alumno"
        assert fila.respondent_email == "ana@escuela.test"


@pytest.mark.asyncio
async def test_actividad_anonima_no_guarda_identidad(mod_on, sitio, db_session):
    """Con `anonymous`, Moodle no manda ni nombre ni email; el `sub` sí lo
    manda igual (lo necesita para la nota, y para eso alcanza con que no se
    guarde). La cookie no debe llevar identidad y la respuesta tampoco.

    Verificado que discrimina: dejando pasar `sub`/`email` al token de la
    cookie, el `lti_sub` de la fila queda cargado y este test falla."""
    client = _client()
    r = _lanzar(client, _firmar(_claims(sitio, anonymous=True, name=_SIN, email=_SIN)))
    assert r.status_code == 302, r.text

    datos = _cookie_del_lanzamiento(r)
    assert datos.get("sub") is None
    assert datos.get("email") is None
    assert datos.get("name") is None

    envio = client.post(
        f"/api/v1/survey/public/{sitio['slug']}/submit",
        json={"answers": {"q1": "anónima"}, "completed": True},
    )
    assert envio.status_code == 201, envio.text

    async with db_session() as session:
        fila = (
            await session.scalars(
                select(SurveyResponse).where(SurveyResponse.id == uuid.UUID(envio.json()["id"]))
            )
        ).one()
        assert fila.lti_sub is None
        assert fila.respondent_email is None


@pytest.mark.asyncio
async def test_submit_respeta_anonymous_aunque_la_cookie_traiga_identidad(mod_on, sitio, db_session):
    """La segunda mitad del anonimato, y la que no se prueba sola.

    `/mod/launch` ya filtra `sub`/`email` cuando la actividad es anónima, así
    que en el camino normal `submit` no tiene nada que descartar -- o sea que
    sacarle el `anonimo` a `submit` no rompe ningún otro test de este archivo.
    Este arma la cookie a mano con las dos cosas a la vez (`anonymous: true` y
    la identidad puesta) para que la única defensa en juego sea la de `submit`:
    es el estado en el que quedaría una cookie emitida por una versión anterior
    del lanzamiento, todavía viva durante ACCESS_TTL_S.

    Verificado que discrimina: reemplazando `anonimo = bool(lti.get(
    "anonymous"))` por `False` en `submit`, la fila queda con el sub y el email
    guardados."""
    from app.security import create_purpose_token

    vieja = create_purpose_token(
        LTI_PURPOSE,
        {
            "slug": sitio["slug"], "anonymous": True,
            "sub": "hmac-que-no-debería-guardarse", "email": "ana@escuela.test",
            "mod_site_id": str(sitio["site_id"]), "cmid": 42,
        },
        ttl_minutes=60,
    )
    envio = _client().post(
        f"/api/v1/survey/public/{sitio['slug']}/submit",
        json={"answers": {"q1": "cookie vieja"}, "completed": True},
        headers={"Cookie": f"{LTI_COOKIE}={vieja}"},
    )
    assert envio.status_code == 201, envio.text

    async with db_session() as session:
        fila = (
            await session.scalars(
                select(SurveyResponse).where(SurveyResponse.id == uuid.UUID(envio.json()["id"]))
            )
        ).one()
        assert fila.lti_sub is None
        assert fila.respondent_email is None


@pytest.mark.asyncio
async def test_anonima_ignora_la_identidad_aunque_moodle_la_mande(mod_on, sitio):
    """Defensa en profundidad: si un plugin viejo (o mal configurado) manda
    `anonymous: true` **y** nombre y email, gana el flag. Guardar la identidad
    porque "vino igual" convierte una actividad anónima en una identificada sin
    que nadie se entere."""
    r = _lanzar(_client(), _firmar(_claims(sitio, anonymous=True)))
    assert r.status_code == 302, r.text
    datos = _cookie_del_lanzamiento(r)
    assert datos.get("sub") is None
    assert datos.get("email") is None


# ── Superficie ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sin_token_da_401(mod_on, sitio):
    r = _client().get("/mod/launch", follow_redirects=False)
    assert r.status_code in (401, 422), r.text


@pytest.mark.asyncio
async def test_token_que_no_es_un_jwt_da_401(mod_on, sitio):
    r = _lanzar(_client(), "esto-no-es-un-jwt")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_con_mod_apagado_el_lanzamiento_no_existe(sitio):
    """404, no 401: con la bandera abajo no se revela que el endpoint está ahí.
    Mismo criterio que el resto del router."""
    r = _lanzar(_client(), _firmar(_claims(sitio)))
    assert r.status_code == 404, r.text
