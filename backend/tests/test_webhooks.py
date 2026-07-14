import app.routers.public as public_router
import app.routers.webhooks_api as wa
from app.webhooks import sign
from tests.conftest import new_client, register

SCHEMA = {"pages": [{"name": "p", "elements": [{"type": "text", "name": "q1", "title": "x"}]}]}


def test_webhook_crud():
    c = new_client(); _, _, me = register(c)
    org = me["orgs"][0]["id"]

    r = c.post(f"/api/v1/orgs/{org}/webhooks", json={"url": "https://example.com/hook"})
    assert r.status_code == 201, r.text
    wid = r.json()["id"]
    assert r.json()["secret"] and r.json()["active"] is True

    assert len(c.get(f"/api/v1/orgs/{org}/webhooks").json()) == 1
    # bad URL rejected
    assert c.post(f"/api/v1/orgs/{org}/webhooks", json={"url": "ftp://x"}).status_code == 422
    # non-member can't see
    other = new_client(); register(other)
    assert other.get(f"/api/v1/orgs/{org}/webhooks").status_code == 404

    assert c.request("DELETE", f"/api/v1/orgs/{org}/webhooks/{wid}").status_code == 204
    assert c.get(f"/api/v1/orgs/{org}/webhooks").json() == []


def test_webhook_test_endpoint(monkeypatch):
    seen = {}

    async def fake_post(url, secret, payload, event="response.created"):
        seen.update(url=url, event=event, payload=payload)
        return True

    monkeypatch.setattr(wa, "post_webhook", fake_post)
    c = new_client(); _, _, me = register(c)
    org = me["orgs"][0]["id"]
    wid = c.post(f"/api/v1/orgs/{org}/webhooks", json={"url": "https://example.com/hook"}).json()["id"]
    r = c.post(f"/api/v1/orgs/{org}/webhooks/{wid}/test")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert seen["url"] == "https://example.com/hook" and seen["event"] == "ping"


def test_submit_schedules_delivery(monkeypatch):
    calls = []
    monkeypatch.setattr(public_router, "schedule_response_delivery", lambda sid, rid: calls.append((sid, rid)))
    c = new_client(); register(c)
    sv = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    r = c.post(f"/api/v1/survey/public/{sv['slug']}/submit", json={"answers": {"q1": "a"}})
    assert r.status_code == 201
    assert len(calls) == 1


def test_signature_stable():
    body = b'{"hello":"world"}'
    s = sign("secret", body)
    assert s.startswith("sha256=") and sign("secret", body) == s
    assert sign("other", body) != s
