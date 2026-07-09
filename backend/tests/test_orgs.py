from tests.conftest import new_client, register


def test_create_and_switch_org():
    c = new_client()
    _, _, me = register(c)
    default_org = me["orgs"][0]["id"]

    r = c.post("/api/v1/orgs", json={"name": "Segunda org"})
    assert r.status_code == 201, r.text
    second = r.json()["id"]

    me2 = c.get("/api/v1/auth/me").json()
    assert {o["id"] for o in me2["orgs"]} == {default_org, second}

    r = c.post("/api/v1/orgs/switch", json={"org_id": default_org})
    assert r.status_code == 200
    assert r.json()["active_org_id"] == default_org


def test_add_member_and_role_guard():
    owner = new_client()
    _, _, ome = register(owner)
    org = ome["orgs"][0]["id"]

    member_client = new_client()
    member_email, _, _ = register(member_client)

    # owner adds the member
    r = owner.post(f"/api/v1/orgs/{org}/members", json={"email": member_email, "role": "member"})
    assert r.status_code == 201, r.text

    # member cannot add others (needs admin+)
    third = new_client()
    third_email, _, _ = register(third)
    r = member_client.post(f"/api/v1/orgs/{org}/members", json={"email": third_email, "role": "member"})
    assert r.status_code == 403

    # non-existent email -> 404
    r = owner.post(f"/api/v1/orgs/{org}/members", json={"email": "nobody@example.com", "role": "member"})
    assert r.status_code == 404


def test_cannot_remove_last_owner():
    owner = new_client()
    _, _, ome = register(owner)
    org = ome["orgs"][0]["id"]
    me = owner.get("/api/v1/auth/me").json()
    uid = me["user"]["id"]
    r = owner.request("DELETE", f"/api/v1/orgs/{org}/members/{uid}")
    assert r.status_code == 400


def test_add_member_unknown_email_is_404():
    owner = new_client()
    _, _, ome = register(owner)
    org = ome["orgs"][0]["id"]
    r = owner.post(f"/api/v1/orgs/{org}/members", json={"email": "ghost@example.com"})
    assert r.status_code == 404
