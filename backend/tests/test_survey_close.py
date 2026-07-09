from datetime import datetime, timedelta, timezone

from tests.conftest import new_client, register

SCHEMA = {"pages": [{"name": "p", "elements": [{"type": "text", "name": "q1", "title": "x"}]}]}


def _survey(c, patch=None):
    r = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA})
    sid, slug = r.json()["id"], r.json()["slug"]
    if patch:
        c.put(f"/api/v1/survey/surveys/{sid}", json=patch)
    c.post(f"/api/v1/survey/surveys/{sid}/publish")
    return sid, slug


def test_close_by_max_responses():
    c = new_client(); register(c)
    _, slug = _survey(c, {"max_responses": 1})
    assert c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "a"}}).status_code == 201
    pub = c.get(f"/api/v1/survey/public/{slug}").json()
    assert pub["available"] is False and "máximo" in pub["closed_reason"]
    assert pub["json_schema"] == {}  # form not shipped when closed
    r = c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "b"}})
    assert r.status_code == 403


def test_close_by_date():
    c = new_client(); register(c)
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    _, slug = _survey(c, {"closes_at": past})
    pub = c.get(f"/api/v1/survey/public/{slug}").json()
    assert pub["available"] is False and "fecha" in pub["closed_reason"]
    assert c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "a"}}).status_code == 403


def test_open_survey_available():
    c = new_client(); register(c)
    _, slug = _survey(c)
    pub = c.get(f"/api/v1/survey/public/{slug}").json()
    assert pub["available"] is True and pub["closed_reason"] is None
    assert pub["json_schema"]["pages"]


def test_close_settings_roundtrip():
    c = new_client(); register(c)
    r = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA})
    sid = r.json()["id"]
    when = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    c.put(f"/api/v1/survey/surveys/{sid}", json={"closes_at": when, "max_responses": 50})
    detail = c.get(f"/api/v1/survey/surveys/{sid}").json()
    assert detail["max_responses"] == 50 and detail["closes_at"] is not None
