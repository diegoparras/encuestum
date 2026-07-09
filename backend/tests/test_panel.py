from app.grading import build_ai_criteria
from tests.conftest import new_client, register

SCHEMA = {"pages": [{"name": "p", "elements": [{"type": "text", "name": "q1", "title": "Nombre"}]}]}


def _survey_with_response(c):
    r = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA})
    sid, slug = r.json()["id"], r.json()["slug"]
    c.post(f"/api/v1/survey/surveys/{sid}/publish")
    c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "Ada"}})
    return sid


def test_org_overview_and_export():
    c = new_client()
    _, _, me = register(c)
    org = me["orgs"][0]["id"]
    _survey_with_response(c)

    ov = c.get(f"/api/v1/orgs/{org}/overview")
    assert ov.status_code == 200
    body = ov.json()
    assert body["surveys"] == 1 and body["responses"] == 1 and body["members"] == 1
    assert len(body["recent"]) == 1

    r = c.get(f"/api/v1/orgs/{org}/export")
    assert r.status_code == 200 and "spreadsheetml" in r.headers["content-type"]
    assert len(r.content) > 100


def test_org_overview_isolation():
    a = new_client(); _, _, me = register(a)
    org = me["orgs"][0]["id"]
    b = new_client(); register(b)
    assert b.get(f"/api/v1/orgs/{org}/overview").status_code == 404


def test_superadmin_gate():
    normal = new_client(); register(normal)
    assert normal.get("/api/v1/admin/overview").status_code == 403

    su = new_client()
    register(su, email="super@example.com")
    ov = su.get("/api/v1/admin/overview")
    assert ov.status_code == 200
    assert "organizations" in ov.json() and ov.json()["orgs"] >= 1
    assert su.get("/api/v1/auth/me").json()["user"]["is_superadmin"] is True

    r = su.get("/api/v1/admin/export")
    assert r.status_code == 200 and "spreadsheetml" in r.headers["content-type"]


def test_build_ai_criteria():
    assert build_ai_criteria(None) is None
    assert build_ai_criteria({"enabled": False}) is None
    txt = build_ai_criteria({
        "enabled": True, "strictness": "estricto",
        "focus": ["contenido", "claridad"], "tone": "directo",
        "instructions": "Penalizá respuestas sin ejemplos.",
    })
    assert txt and "estricto" in txt and "contenido" in txt and "ejemplos" in txt
