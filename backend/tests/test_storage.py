from urllib.parse import parse_qs, urlparse

import pytest

import app.storage
from app.storage import RangeNotSatisfiable, parse_range
from tests.conftest import new_client, register, super_client

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


class _FakeSettingsPrivate(_FakeSettings):
    s3_public_url = None  # sin CDN → proxy same-origin, bucket privado


def test_s3_public_url_relative_by_default(monkeypatch):
    """Sin ENCUESTUM_S3_PUBLIC_URL las URLs son relativas /assets/… — el dominio
    del bucket nunca llega al navegador."""
    monkeypatch.setattr(app.storage, "get_settings", lambda: _FakeSettingsPrivate())
    st = app.storage.S3Storage()
    assert st.public_url("responses/s1/abc.mp4") == "/assets/responses/s1/abc.mp4"
    t = st.presign_upload("responses/s1/abc.mp4", "video/mp4")
    assert t.public_url == "/assets/responses/s1/abc.mp4"
    # la subida sí va directo al bucket (URL prefirmada, por diseño)
    assert "acc.r2.cloudflarestorage.com" in t.url


def test_parse_range():
    assert parse_range(None, 100) is None
    assert parse_range("bytes=0-49", 100) == (0, 49)
    assert parse_range("bytes=50-", 100) == (50, 99)
    assert parse_range("bytes=-10", 100) == (90, 99)
    assert parse_range("bytes=0-999", 100) == (0, 99)  # end se recorta al tamaño
    assert parse_range("bytes=0-10,20-30", 100) is None  # multi-range: se ignora
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=100-", 100)
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=-0", 100)


def _uploaded_response_file(owner):
    """Sube un archivo de respuesta como anónimo; devuelve (url_con_token, url_pelada)."""
    slug = _published(owner)
    anon = new_client()
    body = anon.post(f"/api/v1/survey/public/{slug}/upload-url",
                     json={"content_type": "video/mp4", "size": 1000}).json()
    token = parse_qs(urlparse(body["upload_url"]).query)["token"][0]
    r = anon.put(f"/api/v1/uploads/local?token={token}", content=b"PRIVATE-VIDEO")
    assert r.status_code == 200, r.text
    with_token = r.json()["public_url"]
    return anon, with_token, with_token.split("?")[0]


def test_response_files_are_access_gated():
    owner = new_client(); register(owner)
    anon, with_token, bare = _uploaded_response_file(owner)

    # sin sesión ni token → denegado
    assert new_client().get(bare).status_code == 403
    # el que subió, con su token firmado → OK (su propia preview)
    r = anon.get(with_token)
    assert r.status_code == 200 and r.content == b"PRIVATE-VIDEO"
    # token de OTRO archivo no sirve para este
    other_qs = with_token.split("?")[1]
    assert new_client().get(f"/assets/responses/x/otro.mp4?{other_qs}").status_code == 403
    # miembro de la org dueña (sesión, sin token) → OK
    assert owner.get(bare).status_code == 200
    # usuario autenticado de OTRA org → denegado
    stranger = new_client(); register(stranger)
    assert stranger.get(bare).status_code == 403
    # super-admin de plataforma → OK
    assert super_client().get(bare).status_code == 200


def test_design_assets_public_with_range():
    owner = new_client(); register(owner)
    data = b"0123456789" * 10  # 100 bytes
    r = owner.post("/api/v1/assets", files={"file": ("fondo.png", data, "image/png")})
    assert r.status_code == 201, r.text
    url = r.json()["url"]
    assert url.startswith("/assets/")

    anon = new_client()  # los respondientes los ven sin sesión
    full = anon.get(url)
    assert full.status_code == 200 and full.content == data
    assert "public" in full.headers["cache-control"]

    part = anon.get(url, headers={"Range": "bytes=10-19"})
    assert part.status_code == 206
    assert part.content == b"0123456789"
    assert part.headers["content-range"] == "bytes 10-19/100"

    tail = anon.get(url, headers={"Range": "bytes=-5"})
    assert tail.status_code == 206 and tail.content == b"56789"

    bad = anon.get(url, headers={"Range": "bytes=500-"})
    assert bad.status_code == 416
    assert bad.headers["content-range"] == "bytes */100"


def test_asset_key_traversal_blocked():
    anon = new_client()
    # ".." codificado para que el cliente no lo normalice antes de mandarlo
    assert anon.get("/assets/%2e%2e/app/config.py").status_code == 404
    assert anon.get("/assets/a/%2e%2e/%2e%2e/etc/passwd").status_code == 404
    assert anon.get("/assets/no-existe/x.png").status_code == 404
