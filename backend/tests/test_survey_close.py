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


def test_not_yet_open_by_start_date():
    c = new_client(); register(c)
    future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    _, slug = _survey(c, {"opens_at": future})
    pub = c.get(f"/api/v1/survey/public/{slug}").json()
    assert pub["available"] is False and "abierta" in pub["closed_reason"]
    assert c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "a"}}).status_code == 403
    # ya pasada la apertura → disponible
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    sid = c.get("/api/v1/survey/surveys").json()[0]["id"]
    c.put(f"/api/v1/survey/surveys/{sid}", json={"opens_at": past})
    assert c.get(f"/api/v1/survey/public/{slug}").json()["available"] is True


def test_opens_after_closes_rejected():
    c = new_client(); register(c)
    r = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA})
    sid = r.json()["id"]
    opens = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    closes = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    r = c.put(f"/api/v1/survey/surveys/{sid}", json={"opens_at": opens, "closes_at": closes})
    assert r.status_code == 400 and "anterior" in r.json()["detail"]


def test_reopen_closed_survey():
    c = new_client(); register(c)
    sid, slug = _survey(c)
    c.post(f"/api/v1/survey/surveys/{sid}/close")
    assert c.get(f"/api/v1/survey/public/{slug}").json()["available"] is False
    # reabrir = volver a publicar
    c.post(f"/api/v1/survey/surveys/{sid}/publish")
    assert c.get(f"/api/v1/survey/public/{slug}").json()["available"] is True


def test_custom_slug_and_uniqueness():
    c = new_client(); register(c)
    r = c.post("/api/v1/survey/surveys", json={"title": "E1", "json_schema": SCHEMA})
    sid1 = r.json()["id"]
    # normaliza "Mi Encuesta 2026!" → "mi-encuesta-2026"
    r = c.put(f"/api/v1/survey/surveys/{sid1}", json={"slug": "Mi Encuesta 2026!"})
    assert r.status_code == 200 and r.json()["slug"] == "mi-encuesta-2026"
    # otra encuesta no puede tomar el mismo slug
    sid2 = c.post("/api/v1/survey/surveys", json={"title": "E2", "json_schema": SCHEMA}).json()["id"]
    assert c.put(f"/api/v1/survey/surveys/{sid2}", json={"slug": "mi-encuesta-2026"}).status_code == 409
    # demasiado corto → 400
    assert c.put(f"/api/v1/survey/surveys/{sid2}", json={"slug": "ab"}).status_code == 400
    # el slug nuevo funciona como link público
    c.post(f"/api/v1/survey/surveys/{sid1}/publish")
    assert c.get("/api/v1/survey/public/mi-encuesta-2026").status_code == 200
    # timezone expuesto en el detalle
    assert "timezone" in c.get(f"/api/v1/survey/surveys/{sid1}").json()
