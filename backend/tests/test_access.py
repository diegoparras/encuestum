from tests.conftest import new_client, register

SCHEMA = {"pages": [{"name": "p1", "elements": [{"type": "text", "name": "q1", "title": "Nombre"}]}]}


def _published_survey(c):
    s = c.post("/api/v1/survey/surveys", json={"title": "T", "json_schema": SCHEMA, "language": "es"}).json()
    c.post(f"/api/v1/survey/surveys/{s['id']}/publish")
    return s["id"], s["slug"]


def test_public_mode_unchanged():
    c = new_client(); register(c)
    sid, slug = _published_survey(c)
    pub = new_client().get(f"/api/v1/survey/public/{slug}").json()
    assert pub["gated"] is False and pub["access_mode"] == "public"
    assert pub["json_schema"]["pages"]  # schema shipped
    assert new_client().post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "Ana"}}).status_code == 201


def test_pin_mode_gates_and_grants():
    c = new_client(); register(c)
    sid, slug = _published_survey(c)
    c.put(f"/api/v1/survey/surveys/{sid}", json={"access_mode": "pin", "access_pin": "1234"})

    anon = new_client()
    pub = anon.get(f"/api/v1/survey/public/{slug}").json()
    assert pub["gated"] is True and pub["access_mode"] == "pin"
    assert pub["json_schema"] == {}  # schema withheld

    assert anon.post(f"/api/v1/survey/public/{slug}/access", json={"pin": "0000"}).status_code == 403
    ok = anon.post(f"/api/v1/survey/public/{slug}/access", json={"pin": "1234"})
    assert ok.status_code == 200
    token = ok.json()["access_token"]
    assert ok.json()["survey"]["json_schema"]["pages"]  # full survey returned

    # submit requires the token
    assert anon.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "Ana"}}).status_code == 403
    assert anon.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "Ana"}, "access_token": token}).status_code == 201


def test_list_mode_codes_and_result_release():
    c = new_client(); register(c)
    sid, slug = _published_survey(c)
    c.put(f"/api/v1/survey/surveys/{sid}", json={"access_mode": "list", "results_mode": "on_release"})

    created = c.post(f"/api/v1/survey/surveys/{sid}/invitees",
                     json={"invitees": [{"email": "Alu@Escuela.com", "name": "Alu"}]}).json()
    assert len(created) == 1
    code = created[0]["code"]
    assert created[0]["email"] == "alu@escuela.com"

    anon = new_client()
    assert anon.post(f"/api/v1/survey/public/{slug}/access", json={"email": "alu@escuela.com", "code": "WRONG"}).status_code == 403
    ok = anon.post(f"/api/v1/survey/public/{slug}/access", json={"email": "alu@escuela.com", "code": code})
    assert ok.status_code == 200
    token = ok.json()["access_token"]

    sub = anon.post(f"/api/v1/survey/public/{slug}/submit",
                    json={"answers": {"q1": "Ana"}, "access_token": token})
    assert sub.status_code == 201
    # on_release + no grade config → recorded; response carries respondent identity
    resp = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()[0]
    assert resp["answers"]["q1"] == "Ana"

    # duplicate invitee is skipped
    dup = c.post(f"/api/v1/survey/surveys/{sid}/invitees", json={"invitees": [{"email": "alu@escuela.com"}]}).json()
    assert dup == []


def test_release_results_toggle():
    c = new_client(); register(c)
    sid, slug = _published_survey(c)
    d = c.post(f"/api/v1/survey/surveys/{sid}/release-results").json()
    assert d["results_released"] is True
    d2 = c.post(f"/api/v1/survey/surveys/{sid}/release-results?released=false").json()
    assert d2["results_released"] is False
