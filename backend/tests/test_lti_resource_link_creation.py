"""El seam deep-link -> launch: creación de `LtiResourceLink` en el primer
lanzamiento de una actividad configurada por deep linking.

Hasta este fix, nada en el código de producción creaba esa fila -- sólo los
fixtures de test la insertaban a mano (ver `registered` en
`test_lti_launch.py`), lo que dejaba a `_resource_link_redirect` sin nada que
encontrar: deep link -> el alumno hace clic en la actividad -> 404, siempre.
Este archivo prueba el seam de punta a punta, sin insertar la fila a mano."""

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

from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, LtiResourceLink, Survey

ISSUER = "https://moodle.reslink"
CLIENT_ID = "cid-reslink"


def _client() -> TestClient:
    return TestClient(app, base_url="https://testserver")


@pytest_asyncio.fixture
async def setup(monkeypatch, db_session):
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
        from sqlmodel import select as _select

        # La base es compartida entre tests dentro de la misma sesión de
        # pytest (mismo patrón que test_lti_launch.py).
        previa = (
            await session.scalars(
                _select(LtiPlatform).where(
                    LtiPlatform.issuer == ISSUER, LtiPlatform.client_id == CLIENT_ID
                )
            )
        ).first()
        if previa is not None:
            viejos = (
                await session.scalars(
                    _select(LtiResourceLink).where(LtiResourceLink.platform_id == previa.id)
                )
            ).all()
            for v in viejos:
                await session.delete(v)
            await session.delete(previa)
            await session.commit()

        org_id = uuid.uuid4()
        survey = Survey(
            org_id=org_id, title="Quiz deep-linkeado", status="published",
            json_schema={"pages": []},
        )
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER}/mod/lti/token.php",
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        return {"pem": pem, "platform": platform, "survey": survey, "org_id": org_id}


def _id_token(pem, nonce, resource_link_id, survey_id, context_id="course-77", **over):
    now = int(time.time())
    claims = {
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "student-1", "exp": now + 300, "iat": now,
        "nonce": nonce, "email": "alumno@escuela.test", "name": "Ana Alumna",
        CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: "1",
        CLAIM["TARGET_LINK_URI"]: "https://encuestum.test/lti/launch",
        CLAIM["RESOURCE_LINK"]: {"id": resource_link_id},
        CLAIM["CONTEXT"]: {"id": context_id, "title": "Historia"},
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
        # Lo que `deeplink.py` deja en el content item y Moodle echoa de vuelta
        # en cada lanzamiento de la actividad ya guardada.
        CLAIM["CUSTOM"]: {"survey_id": str(survey_id), "survey_slug": "irrelevante"},
    }
    claims.update(over)
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "pk"})


def _login_y_launch(client, setup, resource_link_id, survey_id, **over):
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "1",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(setup["pem"], q["nonce"][0], resource_link_id, survey_id, **over)
    return client.post(
        "/lti/launch",
        data={"id_token": token, "state": q["state"][0]},
        follow_redirects=False,
    )


@pytest.mark.asyncio
async def test_primer_lanzamiento_crea_el_resource_link_desde_el_custom_claim(
    lti_on, setup, db_session
):
    """El hallazgo crítico del review: deep link -> launch, sin insertar la
    fila a mano. Tiene que quedar creada con la encuesta, la org (vía
    platform) y el context_id correctos."""
    from sqlmodel import select

    rl_id = f"rl-{uuid.uuid4().hex[:8]}"
    client = _client()
    r = _login_y_launch(client, setup, rl_id, setup["survey"].id)

    assert r.status_code == 302, r.text
    assert r.headers["location"] == f"/s/{setup['survey'].slug}"

    async with db_session() as session:
        link = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == setup["platform"].id,
                    LtiResourceLink.resource_link_id == rl_id,
                )
            )
        ).first()
        assert link is not None
        assert link.survey_id == setup["survey"].id
        assert link.context_id == "course-77"


@pytest.mark.asyncio
async def test_lanzamiento_repetido_reusa_el_link_ya_creado(lti_on, setup, db_session):
    """Segundo lanzamiento de la misma actividad: no se crea una segunda fila
    ni se pierde la primera."""
    from sqlmodel import select

    rl_id = f"rl-{uuid.uuid4().hex[:8]}"
    client = _client()
    _login_y_launch(client, setup, rl_id, setup["survey"].id)
    r2 = _login_y_launch(client, setup, rl_id, setup["survey"].id)
    assert r2.status_code == 302

    async with db_session() as session:
        filas = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == setup["platform"].id,
                    LtiResourceLink.resource_link_id == rl_id,
                )
            )
        ).all()
        assert len(filas) == 1


@pytest.mark.asyncio
async def test_custom_survey_id_de_otra_org_no_crea_link_ni_revela_la_encuesta(
    lti_on, setup, db_session
):
    """Defensa en profundidad: un `custom.survey_id` que nombra una encuesta
    de OTRA organización no puede crear el link -- ni para decir "no es
    tuya": mismo 404 que "actividad no configurada", para no revelar que esa
    encuesta existe en otro tenant."""
    from sqlmodel import select

    async with db_session() as session:
        ajena = Survey(
            org_id=uuid.uuid4(), title="Ajena", status="published",
            json_schema={"pages": []},
        )
        session.add(ajena)
        await session.commit()
        ajena_id = ajena.id

    rl_id = f"rl-{uuid.uuid4().hex[:8]}"
    client = _client()
    r = _login_y_launch(client, setup, rl_id, ajena_id)
    assert r.status_code == 404

    async with db_session() as session:
        link = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == setup["platform"].id,
                    LtiResourceLink.resource_link_id == rl_id,
                )
            )
        ).first()
        assert link is None


@pytest.mark.asyncio
async def test_platform_con_org_id_nulo_no_saltea_el_chequeo_de_tenant(
    lti_on, setup, db_session
):
    """Minor del review: la versión vieja de este chequeo era
    `platform.org_id is not None and survey.org_id != platform.org_id` -- una
    plataforma con `org_id` NULL saltaba el chequeo entero y podía autoatarse
    a cualquier encuesta de la instancia vía `custom.survey_id`, aunque fuera
    de otra organización. No alcanzable hoy por las vías normales de alta
    (ambas fijan `org_id`), pero la comparación tiene que ser estricta -- la
    misma que ya usa `select_return` -- no una que dependa de que `org_id` no
    sea NULL."""
    from sqlmodel import select

    from app.models import LtiPlatform

    async with db_session() as session:
        huerfana = LtiPlatform(
            issuer="https://moodle.sin-org", client_id="cid-sin-org",
            deployment_ids=["1"],
            auth_login_url="https://moodle.sin-org/mod/lti/auth.php",
            auth_token_url="https://moodle.sin-org/mod/lti/token.php",
            jwks_url="https://moodle.sin-org/mod/lti/certs.php",
            org_id=None,
        )
        session.add(huerfana)
        await session.commit()
        platform = await session.get(LtiPlatform, huerfana.id)

        rl_id = f"rl-{uuid.uuid4().hex[:8]}"
        claims = {
            CLAIM["CUSTOM"]: {"survey_id": str(setup["survey"].id)},
            CLAIM["CONTEXT"]: {"id": "course-sin-org"},
        }

        from app.routers.lti import _link_from_deep_link_claims

        link = await _link_from_deep_link_claims(claims, platform, rl_id, session)
        assert link is None

        filas = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == platform.id,
                    LtiResourceLink.resource_link_id == rl_id,
                )
            )
        ).all()
        assert filas == []


@pytest.mark.asyncio
async def test_custom_sin_survey_id_da_el_404_de_siempre(lti_on, setup):
    """Sin `custom.survey_id` parseable, sigue siendo el 404 de "actividad no
    configurada" -- p. ej. una actividad de Moodle armada a mano apuntando a
    la URL de launch, sin pasar nunca por deep linking."""
    rl_id = f"rl-{uuid.uuid4().hex[:8]}"
    client = _client()
    r = _login_y_launch(client, setup, rl_id, setup["survey"].id, **{CLAIM["CUSTOM"]: {}})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_creacion_del_link_sobrevive_a_una_carrera_de_insercion(
    lti_on, setup, db_session, monkeypatch
):
    """Dos alumnos entrando casi a la vez a una actividad recién configurada
    ven ambos "no hay fila" y arman su propia -- mismo patrón de carrera que
    `get_tool_key` (`app/lti/keys.py`), probado igual que
    `test_get_tool_key_sobrevive_a_una_carrera_de_insercion` en
    `test_lti_jwks.py`: se simula el resultado de la carrera de forma
    determinística, sin concurrencia real."""
    from sqlalchemy.exc import IntegrityError
    from sqlmodel import select

    from app.routers.lti import _link_from_deep_link_claims

    rl_id = f"rl-{uuid.uuid4().hex[:8]}"
    claims = {
        CLAIM["CUSTOM"]: {"survey_id": str(setup["survey"].id)},
        CLAIM["CONTEXT"]: {"id": "course-race"},
    }

    async with db_session() as session:
        # `setup["platform"]` viene de la sesión (ya cerrada) del fixture --
        # queda detached, y un objeto detached con estado ya cargado sobrevive
        # a un rollback sin problema. Eso NO es lo que pasa en el request real:
        # ahí `platform` se carga con `session.get` dentro de la MISMA sesión
        # que después hace el commit/rollback de la carrera (ver `launch()` en
        # `app/routers/lti.py`). Para que este test pueda detectar el bug
        # (`MissingGreenlet` tras el rollback), hay que reproducir esa misma
        # forma: releer `platform` a través de `session`.
        platform = await session.get(LtiPlatform, setup["platform"].id)
        # Capturado ANTES del rollback simulado más abajo -- mismo motivo que
        # en `test_upsert_lti_user_sobrevive_a_una_carrera_de_insercion`
        # (`test_lti_launch.py`): el armazón del test no debe tocar
        # `platform.id` después del rollback, o el `MissingGreenlet` saldría
        # de acá y no de la recuperación real en `_link_from_deep_link_claims`.
        platform_id = platform.id
        real_commit = session.commit
        state = {"first_call": True}

        async def fake_commit():
            if state["first_call"]:
                state["first_call"] = False
                await session.rollback()
                async with db_session() as other:
                    other.add(
                        LtiResourceLink(
                            platform_id=platform_id,
                            resource_link_id=rl_id,
                            survey_id=setup["survey"].id,
                            context_id="course-race-winner",
                        )
                    )
                    await other.commit()
                raise IntegrityError(
                    "insert", {}, Exception("UNIQUE constraint failed: lti_resource_links")
                )
            await real_commit()

        monkeypatch.setattr(session, "commit", fake_commit)
        link = await _link_from_deep_link_claims(claims, platform, rl_id, session)

    # La fila que "perdimos" la carrera es la que ganó -- no una segunda.
    assert link is not None
    assert link.context_id == "course-race-winner"

    async with db_session() as session:
        filas = (
            await session.scalars(
                select(LtiResourceLink).where(
                    LtiResourceLink.platform_id == setup["platform"].id,
                    LtiResourceLink.resource_link_id == rl_id,
                )
            )
        ).all()
        assert len(filas) == 1
