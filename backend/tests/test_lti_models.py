"""Modelos LTI: que existan, que se persistan y que la respuesta se pueda atribuir."""

import uuid

import pytest
from sqlmodel import select

# app.db no expone un `async_session` público; el sessionmaker interno es
# `_session_maker`. Lo importamos con el alias que usa el resto de este test.
from app.db import _session_maker as async_session
from app.models import LtiPlatform, SurveyResponse


@pytest.mark.asyncio
async def test_lti_platform_roundtrip():
    async with async_session() as session:
        p = LtiPlatform(
            issuer="https://moodle.localhost",
            client_id="abc123",
            deployment_ids=["1"],
            auth_login_url="https://moodle.localhost/mod/lti/auth.php",
            auth_token_url="https://moodle.localhost/mod/lti/token.php",
            jwks_url="https://moodle.localhost/mod/lti/certs.php",
            org_id=None,
        )
        session.add(p)
        await session.commit()

        got = (
            await session.scalars(
                select(LtiPlatform).where(LtiPlatform.issuer == "https://moodle.localhost")
            )
        ).first()
        assert got is not None
        assert got.client_id == "abc123"
        assert got.deployment_ids == ["1"]


@pytest.mark.asyncio
async def test_response_carries_lti_attribution():
    # La respuesta guarda a qué resource link y a qué sub de Moodle pertenece.
    # (No requiere sesión: sólo verifica que el modelo acepte y exponga los campos.)
    r = SurveyResponse(
        survey_id=uuid.uuid4(),
        answers={},
        lti_link_id=uuid.uuid4(),
        lti_sub="moodle-user-42",
    )
    assert r.lti_sub == "moodle-user-42"
    assert r.lti_link_id is not None
