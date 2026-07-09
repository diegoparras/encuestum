from urllib.parse import parse_qs, urlparse

import app.storage
from tests.conftest import new_client, register

SCHEMA = {"pages": [{"name": "p", "elements": [{"type": "text", "name": "q1", "title": "x"}]}]}


def _published(c):
    r = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA})
    sid, slug = r.json()["id"], r.json()["slug"]
    c.post(f"/api/v1/survey/surveys/{sid}/publish")
    return slug


def test_response_upload_flow_local():
    owner = new_client(); register(owner)
    slug = _published(owner)

    anon = new_client()  # respondent, no session
    r = anon.post(f"/api/v1/survey/public/{slug}/upload-url",
                  json={"content_type": "video/mp4", "size": 1000})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method"] == "PUT"
    assert body["public_url"].startswith("/assets/responses/")

    token = parse_qs(urlparse(body["upload_url"]).query)["token"][0]
    r = anon.put(f"/api/v1/uploads/local?token={token}", content=b"FAKEVIDEO-BYTES")
    assert r.status_code == 200, r.text

    # the uploaded file is now served
    r = anon.get(body["public_url"])
    assert r.status_code == 200 and r.content == b"FAKEVIDEO-BYTES"


def test_upload_url_rejects_bad_type_and_size():
    owner = new_client(); register(owner)
    slug = _published(owner)
    anon = new_client()
    assert anon.post(f"/api/v1/survey/public/{slug}/upload-url",
                     json={"content_type": "application/x-msdownload"}).status_code == 415
    assert anon.post(f"/api/v1/survey/public/{slug}/upload-url",
                     json={"content_type": "video/mp4", "size": 999_999_999}).status_code == 413


def test_upload_url_requires_published():
    owner = new_client(); register(owner)
    r = owner.post("/api/v1/survey/surveys", json={"title": "D", "json_schema": SCHEMA})
    slug = r.json()["slug"]  # draft, not published
    assert new_client().post(f"/api/v1/survey/public/{slug}/upload-url",
                             json={"content_type": "video/mp4"}).status_code == 404


class _FakeSettings:
    s3_endpoint = "https://acc.r2.cloudflarestorage.com"
    s3_bucket = "encuestum"
    s3_access_key = "AKIAFAKE"
    s3_secret_key = "secretfake"
    s3_region = "auto"
    s3_public_url = "https://cdn.example.com"
    s3_prefix = ""
    upload_url_ttl = 900


def test_s3_presign_offline(monkeypatch):
    monkeypatch.setattr(app.storage, "get_settings", lambda: _FakeSettings())
    st = app.storage.S3Storage()
    t = st.presign_upload("responses/s1/abc.mp4", "video/mp4")
    assert t.method == "PUT"
    assert "X-Amz-Signature" in t.url and "acc.r2.cloudflarestorage.com" in t.url
    assert t.public_url == "https://cdn.example.com/responses/s1/abc.mp4"
