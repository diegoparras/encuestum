from tests.conftest import new_client, register


def test_set_subdomain_and_public_branding():
    c = new_client(); _, _, me = register(c)
    org = me["orgs"][0]["id"]
    name = me["orgs"][0]["name"]

    r = c.post(f"/api/v1/orgs/{org}/subdomain", json={"subdomain": "Acme"})
    assert r.status_code == 200 and r.json()["subdomain"] == "acme"

    # me exposes subdomain + base_domain
    me2 = c.get("/api/v1/auth/me").json()
    assert me2["orgs"][0]["subdomain"] == "acme"
    assert me2["base_domain"] == "encuestum.example"

    # public branding (no auth)
    anon = new_client()
    b = anon.get("/api/v1/orgs/branding/acme")
    assert b.status_code == 200 and b.json()["name"] == name
    assert anon.get("/api/v1/orgs/branding/nope").status_code == 404


def test_subdomain_validation_reserved_and_unique():
    a = new_client(); _, _, ma = register(a)
    orgA = ma["orgs"][0]["id"]
    assert a.post(f"/api/v1/orgs/{orgA}/subdomain", json={"subdomain": "api"}).status_code == 422
    assert a.post(f"/api/v1/orgs/{orgA}/subdomain", json={"subdomain": "a b"}).status_code == 422
    assert a.post(f"/api/v1/orgs/{orgA}/subdomain", json={"subdomain": "-bad"}).status_code == 422
    assert a.post(f"/api/v1/orgs/{orgA}/subdomain", json={"subdomain": "miorg"}).status_code == 200

    b = new_client(); _, _, mb = register(b)
    orgB = mb["orgs"][0]["id"]
    assert b.post(f"/api/v1/orgs/{orgB}/subdomain", json={"subdomain": "miorg"}).status_code == 409

    # clearing works
    assert a.post(f"/api/v1/orgs/{orgA}/subdomain", json={"subdomain": None}).status_code == 200
    assert a.get("/api/v1/auth/me").json()["orgs"][0]["subdomain"] is None


def test_subdomain_requires_admin():
    owner = new_client(); _, _, mo = register(owner)
    org = mo["orgs"][0]["id"]
    outsider = new_client(); register(outsider)
    assert outsider.post(f"/api/v1/orgs/{org}/subdomain", json={"subdomain": "x"}).status_code == 404
