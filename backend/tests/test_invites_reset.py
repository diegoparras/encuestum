from urllib.parse import parse_qs, urlparse

from app.config import get_settings
from app.security import create_purpose_token
from tests.conftest import new_client, register


def test_password_reset_flow():
    c = new_client()
    email, old_pw, me = register(c)
    uid = me["user"]["id"]

    # forgot-password: generic message, no enumeration
    r = c.post("/api/v1/auth/forgot-password", json={"email": email})
    assert r.status_code == 200
    r2 = c.post("/api/v1/auth/forgot-password", json={"email": "nadie@example.com"})
    assert r2.status_code == 200 and r2.json()["detail"] == r.json()["detail"]

    # SMTP no está configurado en tests, así que forjamos el token (mismo secreto).
    token = create_purpose_token("reset", {"sub": uid}, get_settings().reset_ttl_hours)
    r = c.post("/api/v1/auth/reset-password", json={"token": token, "password": "nuevaClave123"})
    assert r.status_code == 200, r.text

    # la nueva anda, la vieja no
    assert new_client().post("/api/v1/auth/login", json={"email": email, "password": "nuevaClave123"}).status_code == 200
    assert new_client().post("/api/v1/auth/login", json={"email": email, "password": old_pw}).status_code == 401


def test_reset_with_bad_token():
    c = new_client()
    r = c.post("/api/v1/auth/reset-password", json={"token": "no-sirve", "password": "otraClave123"})
    assert r.status_code == 400


def test_email_verification():
    c = new_client()
    _, _, me = register(c)
    uid = me["user"]["id"]
    token = create_purpose_token("verify", {"sub": uid}, get_settings().verify_ttl_hours)
    r = c.post("/api/v1/auth/verify-email", json={"token": token})
    assert r.status_code == 200
    # idempotente
    assert c.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 200
    # token inválido
    assert c.post("/api/v1/auth/verify-email", json={"token": "x"}).status_code == 400


def _token_from_url(url: str) -> str:
    return parse_qs(urlparse(url).query)["token"][0]


def test_invitation_flow():
    owner = new_client()
    _, _, ome = register(owner)
    org = ome["orgs"][0]["id"]

    # invitar un email que todavía no tiene cuenta
    r = owner.post(f"/api/v1/orgs/{org}/invitations", json={"email": "nuevo@example.com", "role": "admin"})
    assert r.status_code == 201, r.text
    invite = r.json()
    assert invite["accept_url"] and invite["role"] == "admin"

    # aparece en la lista de pendientes
    assert len(owner.get(f"/api/v1/orgs/{org}/invitations").json()) == 1

    # la persona se registra y acepta
    invitee = new_client()
    register(invitee, email="nuevo@example.com")
    token = _token_from_url(invite["accept_url"])
    r = invitee.post("/api/v1/orgs/accept-invite", json={"token": token})
    assert r.status_code == 200, r.text
    me = r.json()
    assert org in {o["id"] for o in me["orgs"]}
    assert me["active_org_id"] == org

    # ya es miembro (admin) y la invitación quedó consumida
    members = owner.get(f"/api/v1/orgs/{org}/members").json()
    assert any(m["email"] == "nuevo@example.com" and m["role"] == "admin" for m in members)
    assert owner.get(f"/api/v1/orgs/{org}/invitations").json() == []


def test_invitation_wrong_account():
    owner = new_client()
    _, _, ome = register(owner)
    org = ome["orgs"][0]["id"]
    invite = owner.post(f"/api/v1/orgs/{org}/invitations", json={"email": "target@example.com"}).json()

    # otra persona (email distinto) no puede aceptar
    other = new_client()
    register(other, email="otra@example.com")
    token = _token_from_url(invite["accept_url"])
    assert other.post("/api/v1/orgs/accept-invite", json={"token": token}).status_code == 403


def test_invite_existing_member_conflicts():
    owner = new_client()
    o_email, _, ome = register(owner)
    org = ome["orgs"][0]["id"]
    # el owner ya es miembro
    r = owner.post(f"/api/v1/orgs/{org}/invitations", json={"email": o_email})
    assert r.status_code == 409
