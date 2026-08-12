"""El tope de intentos cuando la encuesta se lanza desde Moodle.

Las dos funcionalidades estaban bien probadas por separado —`test_attempts.py`
prueba el tope, `test_mod_launch.py`/`test_lti_launch.py` prueban la identidad
del LMS— y justamente por eso nadie vio que juntas no funcionaban: un examen
lanzado desde Moodle casi nunca pregunta el correo (para eso está la
integración), así que no quedaba ninguna señal con la que reconocer al alumno y
el tope no se aplicaba **nunca**. Y donde sí llegaba la marca del navegador —la
sala de computadoras— frenaba a la persona equivocada.

Cada test de este archivo se verificó rompiendo el arreglo a propósito; qué hay
que romper para ponerlo en rojo está anotado en cada docstring. Un test que
pasa igual con el arreglo sacado no prueba nada.

La cookie del lanzamiento se arma acá con `create_purpose_token` en vez de
pasar por `/mod/launch`: es exactamente el contenido que siembra
`routers/modapi.py` (ver `test_mod_launch.py`, que sí prueba ese canje), y
armarla a mano es lo que permite cambiar de alumno sin cambiar de navegador,
que es el escenario del medio.
"""

import uuid

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app.lti.state import LTI_COOKIE, LTI_PURPOSE
from app.main import app
from app.models import LtiPlatform, LtiResourceLink, MoodleSite, Survey
from app.security import create_purpose_token
from tests.conftest import crear_org

# Un examen de Moodle típico: NO pregunta el correo, porque la identidad la da
# el LMS. Es la forma que hacía que el tope no se aplicara nunca.
SCHEMA = {"pages": [{"elements": [{"type": "text", "name": "q1", "title": "Respuesta"}]}]}


def _client() -> TestClient:
    """La cookie del lanzamiento va `Secure`: sin HTTPS el cookiejar la
    descarta y los tests fallarían por el motivo equivocado."""
    return TestClient(app, base_url="https://testserver")


@pytest_asyncio.fixture
async def aula(db_session):
    """Una organización con DOS Moodles conectados por el módulo nativo y otros
    dos por LTI, y un examen de un solo intento enlazado desde los cuatro.

    Los dos de cada tipo no son decoración: son el caso del `sub` repetido entre
    plataformas, que es lo que obliga a acotar la cuenta por origen."""
    async with db_session() as session:
        org_id = await crear_org(session, "Escuela con dos Moodles")
        examen = Survey(
            org_id=org_id, title="Examen de una sola oportunidad", status="published",
            # Con PIN a propósito: si la cookie del lanzamiento no sirviera, el
            # envío daría 403 y ningún test de acá podría pasar de casualidad.
            access_mode="pin", access_pin="1234",
            json_schema=SCHEMA, max_attempts=1,
        )
        session.add(examen)

        sitios = [
            MoodleSite(
                org_id=org_id, name=f"Moodle {n}", public_key="-----no se usa acá-----",
                wwwroot=f"https://moodle-{n}-{uuid.uuid4().hex[:8]}.test",
            )
            for n in (1, 2)
        ]
        plataformas = [
            LtiPlatform(
                org_id=org_id, issuer=f"https://lti-{n}-{uuid.uuid4().hex[:8]}.test",
                client_id="cliente", deployment_ids=["1"],
                auth_login_url="https://x.test/auth", auth_token_url="https://x.test/token",
                jwks_url="https://x.test/jwks",
            )
            for n in (1, 2)
        ]
        session.add_all(sitios + plataformas)
        await session.commit()

        vinculos = [
            LtiResourceLink(
                platform_id=p.id, resource_link_id=f"rl-{uuid.uuid4().hex[:8]}",
                survey_id=examen.id, anonymous=False,
            )
            for p in plataformas
        ]
        session.add_all(vinculos)
        await session.commit()

        return {
            "slug": examen.slug,
            "survey_id": examen.id,
            "sitios": [s.id for s in sitios],
            "vinculos": [v.id for v in vinculos],
        }


def _cookie_mod(aula, *, sub, sitio=0, anonima=False) -> str:
    """La cookie que siembra `/mod/launch`. En una actividad anónima Moodle
    manda el `sub` igual pero el lanzamiento lo filtra: se replica tal cual."""
    datos = {
        "slug": aula["slug"],
        "anonymous": anonima,
        "mod_site_id": str(aula["sitios"][sitio]),
        "cmid": 42,
    }
    if not anonima:
        datos["sub"] = sub
        datos["email"] = f"{sub}@escuela.test"
        datos["name"] = "Alumno"
    return create_purpose_token(LTI_PURPOSE, datos, ttl_minutes=60)


def _cookie_lti(aula, *, sub, vinculo=0) -> str:
    """La cookie que siembra `/lti/launch`. Acá el `sub` viaja SIEMPRE: el
    anonimato lo resuelve `submit` releyendo `link.anonymous` de la base."""
    return create_purpose_token(
        LTI_PURPOSE,
        {
            "slug": aula["slug"],
            "link_id": str(aula["vinculos"][vinculo]),
            "sub": sub,
            "email": f"{sub}@escuela.test",
            "name": "Alumno",
        },
        ttl_minutes=60,
    )


def _responder(aula, cookie, *, visitor=None, texto="hola"):
    cuerpo = {"answers": {"q1": texto}, "completed": True}
    if visitor:
        cuerpo["meta"] = {"visitor_id": visitor}
    return _client().post(
        f"/api/v1/survey/public/{aula['slug']}/submit",
        json=cuerpo,
        headers={"Cookie": f"{LTI_COOKIE}={cookie}"},
    )


# ── El tope se aplica de una vez ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_el_alumno_del_modulo_nativo_gasta_su_unico_intento(mod_on, aula):
    """El agujero original: "Intentos máx. = 1" en un examen de Moodle y el
    alumno podía responder todas las veces que quisiera.

    Verificado que discrimina: sin la condición por `lti_sub` en
    `attempts.usados` (o pasándole `lms=None` desde `submit`) no queda ninguna
    condición, `usados` devuelve 0 y el segundo envío vuelve a dar 201."""
    cookie = _cookie_mod(aula, sub="hmac-de-ana")

    assert _responder(aula, cookie).status_code == 201

    r = _responder(aula, cookie, texto="segunda vuelta")
    assert r.status_code == 409, r.text
    assert "Ya respondiste" in r.json()["detail"]


@pytest.mark.asyncio
async def test_el_alumno_de_lti_gasta_su_unico_intento(lti_on, aula):
    """El mismo caso por el otro camino a Moodle. No es un duplicado: el `sub`
    de LTI se acota por plataforma con una subconsulta sobre
    `lti_resource_links`, y el del módulo nativo por `mod_site_id` — son dos
    ramas distintas de `_del_mismo_alumno_del_lms`.

    Verificado que discrimina: si la subconsulta de plataforma se arma mal (por
    ejemplo comparando `LtiResourceLink.id` con el `platform_id`) no matchea
    nada y el segundo envío da 201."""
    cookie = _cookie_lti(aula, sub="5")

    assert _responder(aula, cookie).status_code == 201
    assert _responder(aula, cookie, texto="otra vez").status_code == 409


# ── ...pero a la persona correcta ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dos_alumnos_en_la_misma_computadora_no_se_pisan(mod_on, aula):
    """La sala de computadoras: mismo navegador, dos alumnos. Antes, el segundo
    recibía "Ya respondiste esta encuesta" por el intento del primero.

    Es el test que prueba que la identidad del LMS **manda** sobre la del
    navegador, no que se suma a ella.

    Verificado que discrimina: alcanza con que `usados` vuelva a mirar
    `visitor_id` cuando hay LMS (cambiar `if lms is None and visitor_id` por
    `if visitor_id`) para que el envío de Beto dé 409."""
    maquina = "la-compartida-del-laboratorio"

    ana = _responder(aula, _cookie_mod(aula, sub="hmac-de-ana"), visitor=maquina)
    assert ana.status_code == 201, ana.text

    beto = _responder(aula, _cookie_mod(aula, sub="hmac-de-beto"), visitor=maquina, texto="soy beto")
    assert beto.status_code == 201, beto.text

    # Y el tope sigue existiendo: quien vuelve a sentarse es Ana, no una tercera.
    otra_de_ana = _responder(aula, _cookie_mod(aula, sub="hmac-de-ana"), visitor=maquina)
    assert otra_de_ana.status_code == 409, otra_de_ana.text


@pytest.mark.asyncio
async def test_el_mismo_sub_en_dos_moodles_son_dos_personas(mod_on, aula):
    """El alcance del `sub`: es único por plataforma, no en el mundo. Por LTI,
    Moodle manda como `sub` el id del usuario, así que el "5" del Moodle de
    primaria y el "5" del de secundaria colisionan de entrada — y la misma
    encuesta puede estar enlazada desde los dos, con lo que filtrar por
    `survey_id` no alcanza.

    Verificado que discrimina: sacando el filtro por origen de
    `_del_mismo_alumno_del_lms` (contar sólo por `lti_sub`), el alumno del
    segundo Moodle recibe 409 por el intento de un desconocido."""
    assert _responder(aula, _cookie_mod(aula, sub="5", sitio=0)).status_code == 201

    otro = _responder(aula, _cookie_mod(aula, sub="5", sitio=1), texto="otro Moodle")
    assert otro.status_code == 201, otro.text


@pytest.mark.asyncio
async def test_el_mismo_sub_en_dos_plataformas_lti_son_dos_personas(lti_on, aula):
    """Igual que el anterior, por el camino LTI: acá el alcance sale de la
    plataforma del vínculo, no del sitio.

    Verificado que discrimina: sin la rama de `platform_id` en
    `_del_mismo_alumno_del_lms`, el segundo alumno recibe 409."""
    assert _responder(aula, _cookie_lti(aula, sub="5", vinculo=0)).status_code == 201

    otro = _responder(aula, _cookie_lti(aula, sub="5", vinculo=1), texto="otra plataforma")
    assert otro.status_code == 201, otro.text


# ── Sin identidad no hay tope, y es a propósito ──────────────────────────────


@pytest.mark.asyncio
async def test_la_actividad_anonima_no_aplica_el_tope(mod_on, aula):
    """Con la actividad marcada como anónima no se guarda `lti_sub`, así que no
    hay con qué contar por persona. Contar por la marca del navegador sería
    peor que no contar: frenaría al compañero de máquina y no frenaría a nadie
    que abra otra ventana. El razonamiento está escrito en el docstring de
    `app/attempts.py` para que el próximo que lo lea no lo "arregle".

    Verificado que discrimina: si `usados` volviera a mirar `visitor_id` cuando
    hay LMS, el segundo envío daría 409 — que es exactamente el falso positivo
    que se quiere evitar."""
    maquina = "la-compartida-del-laboratorio"
    anonima = _cookie_mod(aula, sub="hmac-de-ana", anonima=True)

    assert _responder(aula, anonima, visitor=maquina).status_code == 201

    segunda = _responder(aula, anonima, visitor=maquina, texto="de nuevo")
    assert segunda.status_code == 201, segunda.text


@pytest.mark.asyncio
async def test_marcar_el_vinculo_como_anonimo_apaga_el_tope(lti_on, aula, db_session):
    """La mitad que no se prueba sola, y el único test que puede probarla.

    Por LTI el `sub` viaja en la cookie SIEMPRE —el anonimato se relee de la
    base en cada envío—, así que `submit` tiene la identidad a mano y la
    descarta a propósito. Con el vínculo anónimo desde el principio eso no se
    puede ver: las filas anónimas guardan `lti_sub` en NULL, así que contar por
    el `sub` no matchea nada igual y el test pasaría por el motivo equivocado
    (verificado: así estaba escrito primero, y el mutante sobrevivía).

    Lo que sí lo distingue es el docente que marca la actividad como anónima
    **después** de que el alumno ya respondió identificado: ahí quedan filas
    con `lti_sub` cargado que el tope encontraría. No usarlas es lo coherente
    con la otra mitad del contrato del anonimato (`link.anonymous` releído de
    la base, en `submit` y en `_deliver` de `app/lti/ags.py`): a partir de que
    la actividad es anónima, Encuestum no vuelve a usar la identidad del alumno
    para nada — ni para publicar la nota ni para contarle intentos.

    Verificado que discrimina: pasando `lti.get("sub")` a `usados` sin mirar
    `anonimo`, el segundo envío da 409."""
    cookie = _cookie_lti(aula, sub="5")
    assert _responder(aula, cookie).status_code == 201
    # Su único intento está gastado: identificado, no puede responder de nuevo.
    assert _responder(aula, cookie, texto="identificado").status_code == 409

    async with db_session() as session:
        vinculo = await session.get(LtiResourceLink, aula["vinculos"][0])
        vinculo.anonymous = True
        session.add(vinculo)
        await session.commit()

    segunda = _responder(aula, cookie, texto="ya sin identidad")
    assert segunda.status_code == 201, segunda.text
