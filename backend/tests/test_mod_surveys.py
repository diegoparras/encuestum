"""El selector de encuesta de `mod_encuestum` (`GET /mod/surveys?t=<JWT>`).

Es lo que alimenta el desplegable del `mod_form.php`: el servidor de Moodle
firma un token corto con su clave privada y Encuestum le contesta qué encuestas
publicadas tiene la organización de ese sitio.

Este archivo prueba las dos cosas que, si faltan, no se notan hasta que ya es
tarde:

1. **La separación de propósitos, en las DOS direcciones.** Un token de listado
   no puede lanzar y uno de lanzamiento no puede listar. Sin eso, el token que
   el `mod_form.php` de un docente manda en una URL server-to-server -- sin
   ninguna promesa de secreto -- alcanzaría para sembrar la cookie de sesión de
   un alumno.
2. **El filtro por organización.** Sin él, un Moodle conectado ve los títulos
   de las encuestas de todas las escuelas de la instalación.

El resto de la verificación del token (firma, ventana, `jti`, `alg`, `iss`) es
la misma función que la del lanzamiento y ya está cubierta en
`test_mod_launch.py`; acá se prueba una sola vez que efectivamente se aplica,
para que este endpoint no pueda quedar sin ella por accidente.
"""

import time
import uuid

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlmodel import select

from app.main import app
from app.models import MoodleSite, Survey
from tests.conftest import crear_org

WWWROOT = "https://moodle.mod-surveys.test"
WWWROOT_AJENO = "https://moodle.mod-surveys-ajeno.test"


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
    return TestClient(app, base_url="https://testserver")


@pytest_asyncio.fixture
async def sitio(db_session):
    """Un sitio registrado con dos encuestas publicadas, un borrador y una
    borrada, y OTRA organización -- con su propio Moodle y su propia encuesta
    publicada -- contra la que se prueba el aislamiento."""
    async with db_session() as session:
        for previo in (
            await session.scalars(
                select(MoodleSite).where(MoodleSite.wwwroot.in_([WWWROOT, WWWROOT_AJENO]))
            )
        ).all():
            await session.delete(previo)
        await session.commit()

        org_id = await crear_org(session, "Escuela del selector")
        org_ajena = await crear_org(session, "Escuela ajena al selector")

        publicada = Survey(
            org_id=org_id, title="Examen de Historia", status="published",
            json_schema={"pages": [{"elements": [{"name": "q1"}, {"name": "q2"}]}]},
            evaluation={"enabled": True},
        )
        otra_publicada = Survey(
            org_id=org_id, title="Encuesta de clima", status="published",
            json_schema={"pages": []},
        )
        borrador = Survey(
            org_id=org_id, title="Borrador que nadie eligió", status="draft",
            json_schema={"pages": []},
        )
        borrada = Survey(
            org_id=org_id, title="Encuesta en la papelera", status="published",
            json_schema={"pages": []},
        )
        ajena = Survey(
            org_id=org_ajena, title="Examen de la otra escuela", status="published",
            json_schema={"pages": []},
        )
        sitio = MoodleSite(org_id=org_id, wwwroot=WWWROOT, public_key=_PUB, name="Escuela")
        sitio_ajeno = MoodleSite(
            org_id=org_ajena, wwwroot=WWWROOT_AJENO, public_key=_PUB_AJENA, name="Escuela ajena"
        )
        session.add_all([publicada, otra_publicada, borrador, borrada, ajena, sitio, sitio_ajeno])
        await session.commit()

        borrada.deleted_at = borrada.updated_at
        session.add(borrada)
        await session.commit()

        return {
            "site_id": sitio.id,
            "site_id_ajeno": sitio_ajeno.id,
            "survey_id": publicada.id,
            "survey_ajena_id": ajena.id,
        }


def _claims(sitio: dict, proposito: str = "list", **over) -> dict:
    ahora = int(time.time())
    claims = {
        "iss": WWWROOT,
        "iat": ahora,
        "exp": ahora + 120,
        "jti": uuid.uuid4().hex,
        "site_id": str(sitio["site_id"]),
        "purpose": proposito,
    }
    claims.update(over)
    return claims


def _firmar(claims: dict, priv=None) -> str:
    return jwt.encode(claims, priv or _PRIV, algorithm="RS256")


def _listar(client: TestClient, token: str):
    return client.get("/mod/surveys", params={"t": token})


def _titulos(respuesta) -> set[str]:
    return {s["title"] for s in respuesta.json()["surveys"]}


# ── El camino feliz ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lista_las_encuestas_publicadas_de_la_organizacion(mod_on, sitio):
    r = _listar(_client(), _firmar(_claims(sitio)))
    assert r.status_code == 200, r.text
    assert _titulos(r) == {"Examen de Historia", "Encuesta de clima"}


@pytest.mark.asyncio
async def test_no_lista_borradores_ni_encuestas_borradas(mod_on, sitio):
    """El selector ata la actividad a la encuesta: ofrecer un borrador (que el
    alumno no puede abrir) o una de la papelera manda al docente a configurar
    una actividad que va a fallar recién delante del curso."""
    r = _listar(_client(), _firmar(_claims(sitio)))
    assert "Borrador que nadie eligió" not in _titulos(r)
    assert "Encuesta en la papelera" not in _titulos(r)


@pytest.mark.asyncio
async def test_cada_encuesta_trae_lo_que_el_selector_muestra(mod_on, sitio):
    """`questions` y `is_exam` son lo único que distingue dos títulos
    parecidos en el desplegable del docente."""
    r = _listar(_client(), _firmar(_claims(sitio)))
    porid = {s["id"]: s for s in r.json()["surveys"]}
    examen = porid[str(sitio["survey_id"])]
    assert examen["is_exam"] is True
    assert examen["questions"] == 2
    assert examen["slug"]
    assert examen["updated_at"]


# ── Aislamiento entre organizaciones ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_muestra_encuestas_de_otra_organizacion(mod_on, sitio):
    """CRÍTICO. El filtro `Survey.org_id == sitio.org_id` es lo único que
    separa a una escuela de otra en este endpoint: sin él, cualquier Moodle
    conectado enumera los títulos de todas las encuestas de la instalación --
    que ya de por sí dicen bastante (nombres de exámenes, de materias, de
    cursos) aunque no se pueda abrir ninguna.

    Verificado que discrimina: sacando la condición `Survey.org_id ==
    sitio.org_id` de la consulta, este test falla porque aparece "Examen de la
    otra escuela"."""
    r = _listar(_client(), _firmar(_claims(sitio)))
    assert r.status_code == 200, r.text
    assert "Examen de la otra escuela" not in _titulos(r)


@pytest.mark.asyncio
async def test_la_organizacion_sale_del_sitio_y_no_del_token(mod_on, sitio):
    """El `org_id` no viaja en el token, así que no hay nada que falsificar: el
    Moodle ajeno, firmando con su propia clave y su propio `site_id`, ve su
    propia encuesta y ninguna de la otra escuela. Es la contracara del test de
    arriba y lo que prueba que el filtro no se puede eludir declarando otra
    cosa."""
    claims = _claims(sitio, iss=WWWROOT_AJENO, site_id=str(sitio["site_id_ajeno"]))
    r = _listar(_client(), _firmar(claims, priv=_PRIV_AJENA))
    assert r.status_code == 200, r.text
    assert _titulos(r) == {"Examen de la otra escuela"}


# ── La separación de propósitos, en las dos direcciones ──────────────────────


@pytest.mark.asyncio
async def test_un_token_de_listado_no_sirve_para_lanzar(mod_on, sitio):
    """CRÍTICO, y la razón entera de que el `purpose` exista. El token del
    selector lo arma el servidor de Moodle para un request server-to-server: no
    tiene ninguna promesa de secreto y perfectamente puede terminar en un log.
    Si valiera como lanzamiento, quien lo lea entra a la encuesta con la sesión
    del `sub` que le pegue.

    Se le agregan `survey_id` y `sub` a mano: sin eso el token fallaría por
    faltarle un claim requerido y el test pasaría por el motivo equivocado.

    Verificado que discrimina: sacando la comparación de `purpose` de
    `verificar_token_moodle`, este lanzamiento devuelve 302 y siembra la
    cookie."""
    claims = _claims(sitio, survey_id=str(sitio["survey_id"]), sub="hmac-de-un-alumno")
    r = _client().get(
        "/mod/launch", params={"t": _firmar(claims)}, follow_redirects=False
    )
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_un_token_de_lanzamiento_no_sirve_para_listar(mod_on, sitio):
    """La otra dirección. Un token de lanzamiento interceptado (el historial
    del navegador, un `Referer`) no tiene por qué servir además para enumerar
    las encuestas de la organización.

    Verificado que discrimina: sacando la comparación de `purpose`, este
    listado devuelve 200 con las dos encuestas."""
    claims = _claims(sitio, proposito="launch", survey_id=str(sitio["survey_id"]))
    r = _listar(_client(), _firmar(claims))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_un_token_sin_purpose_no_sirve_para_nada(mod_on, sitio):
    """`purpose` está en los claims requeridos, no se infiere de la ausencia:
    un token sin propósito sería el token de antes de esta separación, y
    aceptarlo la deshace entera."""
    sin = _claims(sitio)
    sin.pop("purpose")
    assert _listar(_client(), _firmar(sin)).status_code == 401

    sin_lanzamiento = _claims(sitio, survey_id=str(sitio["survey_id"]))
    sin_lanzamiento.pop("purpose")
    r = _client().get(
        "/mod/launch", params={"t": _firmar(sin_lanzamiento)}, follow_redirects=False
    )
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_un_purpose_inventado_no_sirve(mod_on, sitio):
    r = _listar(_client(), _firmar(_claims(sitio, proposito="cualquier-cosa")))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_el_purpose_se_compara_antes_de_quemar_el_jti(mod_on, sitio):
    """El `jti` de un token rechazado por propósito no se consume: si se
    consumiera, mandar el token de listado a `/mod/launch` anularía el listado
    legítimo que venía después con ese mismo `jti`.

    Verificado que discrimina: moviendo la comparación de `purpose` después de
    `consumir_jti`, el segundo request de este test devuelve 401."""
    claims = _claims(sitio, survey_id=str(sitio["survey_id"]))
    token = _firmar(claims)

    rechazado = _client().get("/mod/launch", params={"t": token}, follow_redirects=False)
    assert rechazado.status_code == 401, rechazado.text

    aceptado = _listar(_client(), token)
    assert aceptado.status_code == 200, aceptado.text


# ── La verificación del token se aplica de verdad ────────────────────────────


@pytest.mark.asyncio
async def test_firmado_con_otra_clave_da_401(mod_on, sitio):
    """La misma función que el lanzamiento, pero hay que probar que este
    endpoint la llama: un listado que no verifique firma le regala los títulos
    de las encuestas de una organización a cualquiera que sepa un `site_id`."""
    r = _listar(_client(), _firmar(_claims(sitio), priv=_PRIV_AJENA))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_jti_repetido_da_401(mod_on, sitio):
    token = _firmar(_claims(sitio))
    assert _listar(_client(), token).status_code == 200
    assert _listar(_client(), token).status_code == 401


@pytest.mark.asyncio
async def test_ventana_mas_larga_que_120s_da_401(mod_on, sitio):
    ahora = int(time.time())
    r = _listar(_client(), _firmar(_claims(sitio, iat=ahora, exp=ahora + 3600)))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_site_id_desconocido_da_401(mod_on, sitio):
    r = _listar(_client(), _firmar(_claims(sitio, site_id=str(uuid.uuid4()))))
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_sin_token_da_401(mod_on, sitio):
    r = _client().get("/mod/surveys")
    assert r.status_code in (401, 422), r.text


@pytest.mark.asyncio
async def test_con_mod_apagado_el_selector_no_existe(sitio):
    """404, no 401: con la bandera abajo no se revela que el endpoint está ahí.
    Mismo criterio que el resto del router."""
    r = _listar(_client(), _firmar(_claims(sitio)))
    assert r.status_code == 404, r.text
