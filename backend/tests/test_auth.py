from tests.conftest import new_client, register


def test_register_login_me_logout():
    c = new_client()
    email, password, me = register(c, name="Ada")
    assert me["user"]["email"] == email
    assert len(me["orgs"]) == 1
    assert me["orgs"][0]["role"] == "owner"

    # /me works while the session cookie is set
    r = c.get("/api/v1/auth/me")
    assert r.status_code == 200

    # logout clears the session
    assert c.post("/api/v1/auth/logout").status_code == 204
    assert c.get("/api/v1/auth/me").status_code == 401

    # login again from a fresh client
    c2 = new_client()
    r = c2.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200
    assert c2.get("/api/v1/auth/me").status_code == 200


def test_login_wrong_password():
    c = new_client()
    email, _, _ = register(c)
    r = new_client().post("/api/v1/auth/login", json={"email": email, "password": "wrongwrong"})
    assert r.status_code == 401


def test_duplicate_email_rejected():
    c = new_client()
    email, _, _ = register(c)
    r = new_client().post("/api/v1/auth/register", json={"email": email, "password": "anotherpass1"})
    assert r.status_code == 409


def test_short_password_rejected():
    r = new_client().post("/api/v1/auth/register", json={"email": "x@example.com", "password": "short"})
    assert r.status_code == 422


def test_me_requires_auth():
    assert new_client().get("/api/v1/auth/me").status_code == 401
