from tests.conftest import new_client, register

SCHEMA = {
    "pages": [
        {"name": "p1", "elements": [
            {"type": "radiogroup", "name": "color", "title": "Color",
             "choices": ["Rojo", "Azul", "Verde"]},
            {"type": "rating", "name": "nps", "title": "NPS", "rateMin": 0, "rateMax": 10},
            {"type": "comment", "name": "libre", "title": "Comentario"},
        ]}
    ]
}


def _survey(c):
    s = c.post("/api/v1/survey/surveys", json={"title": "T", "json_schema": SCHEMA, "language": "es"}).json()
    c.post(f"/api/v1/survey/surveys/{s['id']}/publish")
    return s["id"], s["slug"]


def test_response_summary_charts():
    c = new_client(); register(c)
    sid, slug = _survey(c)
    for color, nps, libre in [("Rojo", 9, "genial"), ("Rojo", 8, "ok"), ("Azul", 3, "")]:
        new_client().post(f"/api/v1/survey/public/{slug}/submit",
                          json={"answers": {"color": color, "nps": nps, "libre": libre}})
    summ = c.get(f"/api/v1/survey/surveys/{sid}/summary").json()
    assert summ["total_responses"] == 3
    q = {x["name"]: x for x in summ["questions"]}
    assert q["color"]["kind"] == "choice"
    rojo = next(o for o in q["color"]["options"] if o["label"] == "Rojo")
    assert rojo["count"] == 2
    assert q["nps"]["kind"] == "rating" and q["nps"]["average"] is not None
    assert q["libre"]["kind"] == "text" and len(q["libre"]["values"]) == 2


def test_notify_emails_roundtrip_and_duplicate():
    c = new_client(); register(c)
    sid, slug = _survey(c)
    upd = c.put(f"/api/v1/survey/surveys/{sid}", json={"notify_emails": "yo@correo.com, otro@correo.com"})
    assert upd.status_code == 200 and "yo@correo.com" in upd.json()["notify_emails"]
    # a submit doesn't error even with notify configured (no SMTP → logged)
    assert new_client().post(f"/api/v1/survey/public/{slug}/submit",
                             json={"answers": {"color": "Azul"}}).status_code == 201

    dup = c.post(f"/api/v1/survey/surveys/{sid}/duplicate")
    assert dup.status_code == 200
    d = dup.json()
    assert d["status"] == "draft" and d["slug"] != slug and "(copia)" in (d["title"] or "")
    assert d["notify_emails"] == "yo@correo.com, otro@correo.com"
