"""SSO por organización, roles y alcance por carpetas, comentarios, aprobación
para publicar y servidor MCP."""

import time
import urllib.parse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app import org_sso
from app.config import get_settings
from tests.conftest import new_client, register

API = "/api/v1/survey"
ISSUER = "https://idp.escuela.edu"


def _org_id(c):
    return c.get("/api/v1/auth/me").json()["orgs"][0]["id"]


# ── SSO ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def idp(monkeypatch):
    """Un proveedor OIDC simulado con una clave RSA de verdad."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True) | {"kid": "k1", "use": "sig"}
    estado = {"claims": {}, "codigos": {}}

    async def get_json(url):
        if url.endswith("/.well-known/openid-configuration"):
            return {"issuer": ISSUER, "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token", "jwks_uri": f"{ISSUER}/jwks"}
        if url == f"{ISSUER}/jwks":
            return {"keys": [jwk]}
        raise AssertionError(url)

    async def post_form(url, data):
        assert url == f"{ISSUER}/token" and data["client_secret"] == "s3cret" and data["code_verifier"]
        nonce = estado["codigos"].pop(data["code"], None)
        if nonce is None:
            return {"error": "invalid_grant"}
        ahora = int(time.time())
        claims = {"iss": ISSUER, "aud": "encuestum", "sub": "u1", "iat": ahora, "exp": ahora + 300,
                  "nonce": nonce, "email_verified": True, **estado["claims"]}
        return {"id_token": jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})}

    monkeypatch.setattr(org_sso, "_get_json", get_json)
    monkeypatch.setattr(org_sso, "_post_form", post_form)
    org_sso._cache.clear()
    return estado


def _login_sso(estado, email, **claims):
    """Recorre el flujo como un navegador: start → (IdP) → callback."""
    c = new_client()
    r = c.get("/api/v1/auth/org-sso/start", params={"email": email}, follow_redirects=False)
    assert r.status_code == 302, r.text
    destino = urllib.parse.urlparse(r.headers["location"])
    if not destino.netloc.startswith("idp."):
        return c, r.headers["location"]
    q = dict(urllib.parse.parse_qsl(destino.query))
    assert q["code_challenge_method"] == "S256" and q["login_hint"] == email
    estado["codigos"]["CODE1"] = q["nonce"]
    estado["claims"] = {"email": email, "name": "Ana Docente", **claims}
    r = c.get("/api/v1/auth/org-sso/callback", params={"code": "CODE1", "state": q["state"]}, follow_redirects=False)
    return c, r.headers["location"]


def test_sso_por_organizacion(idp):
    admin = new_client(); register(admin, email="dire@escuela.edu")
    org = _org_id(admin)
    base = {"issuer": ISSUER, "client_id": "encuestum", "client_secret": "s3cret", "domains": ["escuela.edu"]}
    assert admin.put("/api/v1/sso", json={**base, "domains": ["no es dominio"]}).status_code == 422
    cfg = admin.put("/api/v1/sso", json={**base, "default_role": "viewer"}).json()
    assert cfg["client_secret_set"] and "s3cret" not in str(cfg) and cfg["redirect_uri"].endswith("/org-sso/callback")
    assert new_client().get("/api/v1/auth/org-sso/lookup", params={"email": "x@escuela.edu"}).json()["sso"] is True
    assert new_client().get("/api/v1/auth/org-sso/lookup", params={"email": "x@otra.com"}).json() == {"sso": False}

    c, destino = _login_sso(idp, "ana@escuela.edu")
    assert destino.endswith("/surveys")
    me = c.get("/api/v1/auth/me").json()
    assert me["user"]["email"] == "ana@escuela.edu"
    roles = {o["id"]: o["role"] for o in me["orgs"]}
    assert roles == {org: "viewer"}  # alta automática, con el rol por defecto, sin espacio propio

    # Email no verificado o de otro dominio: no entra.
    _, destino = _login_sso(idp, "beto@escuela.edu", email_verified=False)
    assert "sso_error=email" in destino
    # Otra organización no puede reclamar el mismo dominio.
    otra = new_client(); register(otra)
    assert otra.put("/api/v1/sso", json=base).status_code == 409

    # Obligatorio: el dominio ya no entra con contraseña.
    admin.put("/api/v1/sso", json={**base, "enforce": True})
    r = new_client().post("/api/v1/auth/login", json={"email": "dire@escuela.edu", "password": "supersecret1"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "sso_required"
    admin.delete("/api/v1/sso")


def test_sso_rechaza_tokens_manipulados(idp, monkeypatch):
    admin = new_client(); register(admin, email="jefa@colegio.org")
    admin.put("/api/v1/sso", json={"issuer": ISSUER, "client_id": "encuestum", "client_secret": "s3cret",
                                   "domains": ["colegio.org"], "auto_provision": False})
    # Sin alta automática, alguien que no es miembro no entra.
    _, destino = _login_sso(idp, "nuevo@colegio.org")
    assert "sso_error=no_access" in destino
    # Un token firmado con otra clave no pasa.
    otra = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    original = org_sso._post_form

    async def falsificado(url, data):
        r = await original(url, data)
        claims = jwt.decode(r["id_token"], options={"verify_signature": False})
        return {"id_token": jwt.encode(claims, otra, algorithm="RS256", headers={"kid": "k1"})}

    monkeypatch.setattr(org_sso, "_post_form", falsificado)
    _, destino = _login_sso(idp, "jefa@colegio.org")
    assert "sso_error=token" in destino
    # Un state que no coincide tampoco.
    r = new_client().get("/api/v1/auth/org-sso/callback", params={"code": "x", "state": "y"}, follow_redirects=False)
    assert "sso_error=state" in r.headers["location"]
    admin.delete("/api/v1/sso")


# ── Roles y alcance ─────────────────────────────────────────────────────────


def _miembro(owner, org, rol="member"):
    c = new_client()
    email, _, _ = register(c)
    r = owner.post(f"/api/v1/orgs/{org}/members", json={"email": email, "role": rol})
    assert r.status_code in (200, 201), r.text
    uid = r.json()["user_id"]
    c.post("/api/v1/orgs/switch", json={"org_id": org})
    c.cookies.set(get_settings().org_cookie, org)
    return c, uid


def test_lector_y_alcance_por_carpetas():
    owner = new_client(); register(owner)
    org = _org_id(owner)
    ventas = owner.post(f"{API}/folders", json={"name": "Ventas"}).json()["id"]
    sub = owner.post(f"{API}/folders", json={"name": "Norte", "parent_id": ventas}).json()["id"]
    rrhh = owner.post(f"{API}/folders", json={"name": "RRHH"}).json()["id"]
    s_v = owner.post(f"{API}/surveys", json={"title": "Ventas Q1"}).json()["id"]
    s_n = owner.post(f"{API}/surveys", json={"title": "Norte"}).json()["id"]
    s_r = owner.post(f"{API}/surveys", json={"title": "Clima RRHH"}).json()["id"]
    owner.post(f"{API}/folders/move-surveys", json={"survey_ids": [s_v], "folder_id": ventas})
    owner.post(f"{API}/folders/move-surveys", json={"survey_ids": [s_n], "folder_id": sub})
    owner.post(f"{API}/folders/move-surveys", json={"survey_ids": [s_r], "folder_id": rrhh})

    m, uid = _miembro(owner, org)
    r = owner.put(f"/api/v1/orgs/{org}/members/{uid}/scope", json={"folder_ids": [ventas]})
    assert r.status_code == 200 and r.json()["folder_scope"] == [ventas]
    assert sorted(s["title"] for s in m.get(f"{API}/surveys").json()) == ["Norte", "Ventas Q1"]
    assert {f["name"] for f in m.get(f"{API}/folders").json()} == {"Ventas", "Norte"}
    assert m.get(f"{API}/surveys/{s_r}").status_code == 404
    assert m.get(f"{API}/surveys/{s_r}/responses").status_code == 404
    assert m.put(f"{API}/surveys/{s_v}", json={"folder_id": rrhh}).status_code == 403
    nueva = m.post(f"{API}/surveys", json={"title": "Mía"}).json()
    assert nueva["folder_id"] in (ventas, sub)

    lector, lid = _miembro(owner, org, "viewer")
    assert lector.get(f"{API}/surveys/{s_r}").status_code == 200  # sin alcance: ve todo
    assert lector.put(f"{API}/surveys/{s_r}", json={"title": "x"}).status_code == 403
    assert lector.post(f"{API}/surveys", json={"title": "x"}).status_code == 403
    assert lector.post(f"{API}/surveys/{s_r}/comments", json={"body": "¿La pregunta 2 no es doble?"}).status_code == 201


# ── Comentarios y aprobación ────────────────────────────────────────────────


def test_comentarios_y_aprobacion_para_publicar():
    owner = new_client(); register(owner)
    org = _org_id(owner)
    assert owner.put("/api/v1/workflow", json={"require_publish_approval": True}).json() == {"require_publish_approval": True}
    m, _ = _miembro(owner, org)
    assert m.put("/api/v1/workflow", json={"require_publish_approval": False}).status_code == 403
    sid = m.post(f"{API}/surveys", json={"title": "Satisfacción"}).json()["id"]

    c = m.post(f"{API}/surveys/{sid}/comments", json={"body": "Falta una pregunta de cierre", "question": "q1"}).json()
    assert owner.get(f"{API}/surveys/{sid}/comments").json()[0]["author"] and c["question"] == "q1"
    assert owner.post(f"{API}/surveys/{sid}/comments/{c['id']}/resolve").json()["resolved"] is True
    otro, _ = _miembro(owner, org)
    assert otro.delete(f"{API}/surveys/{sid}/comments/{c['id']}").status_code == 403

    d = m.post(f"{API}/surveys/{sid}/publish").json()
    assert d["status"] == "draft" and d["approval"]["state"] == "pending"
    assert m.put(f"{API}/surveys/{sid}", json={"status": "published"}).status_code == 403
    assert [p["id"] for p in owner.get("/api/v1/workflow/pending").json()] == [sid]
    assert m.post(f"{API}/surveys/{sid}/approval/approve", json={}).status_code == 403
    r = owner.post(f"{API}/surveys/{sid}/approval/reject", json={"note": "Sumá la pregunta de cierre"}).json()
    assert r["approval"]["state"] == "rejected" and r["approval"]["note"] == "Sumá la pregunta de cierre"
    m.post(f"{API}/surveys/{sid}/publish")
    ok = owner.post(f"{API}/surveys/{sid}/approval/approve", json={}).json()
    assert ok["status"] == "published" and ok["approval"] is None
    owner.put("/api/v1/workflow", json={"require_publish_approval": False})


# ── MCP ─────────────────────────────────────────────────────────────────────


def _rpc(c, h, method, params=None, id_=1):
    return c.post("/api/v1/mcp", headers=h, json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})


def test_servidor_mcp():
    owner = new_client(); register(owner)
    schema = {"pages": [{"name": "p", "elements": [
        {"type": "radiogroup", "name": "turno", "title": "Turno", "choices": ["Mañana", "Tarde"]}]}]}
    s = owner.post(f"{API}/surveys", json={"title": "Cursada", "json_schema": schema}).json()
    owner.post(f"{API}/surveys/{s['id']}/publish")
    for t in ("Mañana", "Tarde", "Tarde"):
        new_client().post(f"{API}/public/{s['slug']}/submit", json={"answers": {"turno": t}})
    clave = owner.post("/api/v1/api-keys", json={"name": "Claude", "scope": "read"}).json()["key"]
    h = {"Authorization": f"Bearer {clave}"}
    c = new_client()

    assert c.post("/api/v1/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code == 401
    init = _rpc(c, h, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "test", "version": "1"}}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18" and init["serverInfo"]["name"] == "encuestum"
    assert c.post("/api/v1/mcp", headers=h, json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
    nombres = [t["name"] for t in _rpc(c, h, "tools/list").json()["result"]["tools"]]
    assert nombres == ["list_surveys", "get_survey", "get_summary", "get_responses", "add_invitees"]

    import json as _json

    def tool(name, args):
        r = _rpc(c, h, "tools/call", {"name": name, "arguments": args}).json()["result"]
        return r["isError"], (_json.loads(r["content"][0]["text"]) if not r["isError"] else r["content"][0]["text"])

    err, lst = tool("list_surveys", {})
    assert not err and lst[0]["title"] == "Cursada" and lst[0]["response_count"] == 3
    err, enc = tool("get_survey", {"survey_id": s["id"]})
    assert enc["questions"] == [{"name": "turno", "type": "radiogroup", "title": "Turno", "choices": ["Mañana", "Tarde"]}]
    err, res = tool("get_summary", {"survey_id": s["id"]})
    assert {o["label"]: o["count"] for o in res["questions"][0]["options"]} == {"Mañana": 1, "Tarde": 2}
    err, rs = tool("get_responses", {"survey_id": s["id"], "limit": 2})
    assert len(rs["items"]) == 2 and rs["next_offset"] == 2
    err, msg = tool("add_invitees", {"survey_id": s["id"], "emails": ["a@b.com"]})
    assert err and "lectura" in msg
    err, msg = tool("get_survey", {"survey_id": "no-es-uuid"})
    assert err
    assert _rpc(c, h, "tools/call", {"name": "borrar_todo"}).json()["error"]["code"] == -32602
    assert _rpc(c, h, "resources/list").json()["error"]["code"] == -32601
    lote = c.post("/api/v1/mcp", headers=h, json=[{"jsonrpc": "2.0", "id": 7, "method": "ping"},
                                                   {"jsonrpc": "2.0", "method": "notifications/cancelled"}]).json()
    assert lote == [{"jsonrpc": "2.0", "id": 7, "result": {}}]


def test_reenvio_sin_conexion_no_duplica():
    owner = new_client(); register(owner)
    s = owner.post(f"{API}/surveys", json={"title": "Campo", "json_schema": {"pages": [{"name": "p", "elements": [
        {"type": "text", "name": "barrio", "title": "Barrio"}]}]}}).json()
    owner.post(f"{API}/surveys/{s['id']}/publish")
    cuerpo = {"answers": {"barrio": "Boedo"}, "meta": {"submission_id": "a1b2c3d4-0000-4000-8000-000000000001"}}
    r1 = new_client().post(f"{API}/public/{s['slug']}/submit", json=cuerpo).json()
    r2 = new_client().post(f"{API}/public/{s['slug']}/submit", json=cuerpo).json()
    assert r2["duplicate"] is True and r2["id"] == r1["id"]
    assert len(owner.get(f"{API}/surveys/{s['id']}/responses").json()) == 1


def test_demo_de_onboarding():
    c = new_client(); register(c)
    enc = c.post(f"{API}/surveys/demo").json()
    assert enc["status"] == "published" and "(demo)" in enc["title"]
    resumen = c.get(f"{API}/surveys/{enc['id']}/summary", params={"segment_by": "canal"}).json()
    assert resumen["total_responses"] == 120
    nps = next(q for q in resumen["questions"] if q["name"] == "nps")
    assert nps["significance"] is not None  # el teléfono anda peor: hay diferencia entre canales
    ex = c.post(f"{API}/surveys/demo", params={"kind": "exam"}).json()
    rs = c.get(f"{API}/surveys/{ex['id']}/responses").json()
    assert len(rs) == 40 and all(r["score"] is not None for r in rs)
    analisis = c.get(f"{API}/surveys/{ex['id']}/analytics").json()
    assert analisis
    assert c.post(f"{API}/surveys/demo", params={"kind": "otra"}).status_code == 422
