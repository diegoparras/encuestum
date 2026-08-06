"""Panel de conexión con Moodle: modelo, endpoints y aislamiento entre orgs."""

import uuid

import pytest
from sqlmodel import select

from app.models import LtiPlatform, LtiResourceLink, Survey


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
            org_id=uuid.uuid4(), title="Encuesta roundtrip", status="published",
            json_schema={"pages": []},
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
            org_id=uuid.uuid4(), title="Encuesta default", status="published",
            json_schema={"pages": []},
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
            jwks_url="https://moodle.anon/j", org_id=uuid.uuid4(),
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
