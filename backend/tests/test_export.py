from tests.conftest import new_client, register

SCHEMA = {"pages": [{"name": "p", "elements": [
    {"type": "radiogroup", "name": "cap", "title": "Capital", "choices": ["Madrid", "Paris"]},
    {"type": "comment", "name": "op", "title": "Opina"},
]}]}


def _setup(c):
    r = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA, "language": "es"})
    sid, slug = r.json()["id"], r.json()["slug"]
    c.post(f"/api/v1/survey/surveys/{sid}/publish")
    c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"cap": "Paris", "op": "muy bueno"}})
    return sid


def test_export_csv():
    c = new_client(); register(c)
    sid = _setup(c)
    r = c.get(f"/api/v1/survey/surveys/{sid}/export?format=csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    body = r.content.decode("utf-8-sig")
    assert "Capital" in body and "Paris" in body and "Opina" in body


def test_export_xlsx():
    c = new_client(); register(c)
    sid = _setup(c)
    r = c.get(f"/api/v1/survey/surveys/{sid}/export?format=xlsx")
    assert r.status_code == 200
    assert "spreadsheetml" in r.headers["content-type"]
    assert len(r.content) > 100  # a real xlsx (zip) payload


def test_export_org_isolation():
    c = new_client(); register(c)
    sid = _setup(c)
    other = new_client(); register(other)
    assert other.get(f"/api/v1/survey/surveys/{sid}/export").status_code == 404
    assert new_client().get(f"/api/v1/survey/surveys/{sid}/export").status_code == 401
