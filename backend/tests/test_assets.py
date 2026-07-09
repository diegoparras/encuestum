import base64

from tests.conftest import new_client, register

# 1x1 transparent PNG
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_upload_list_delete_and_isolation():
    a = new_client(); register(a)
    r = a.post("/api/v1/assets", files={"file": ("logo.png", _PNG, "image/png")})
    assert r.status_code == 201, r.text
    asset = r.json()
    assert asset["kind"] == "image" and asset["url"].startswith("/assets/")
    aid = asset["id"]

    assert len(a.get("/api/v1/assets").json()) == 1
    assert len(a.get("/api/v1/assets?kind=image").json()) == 1
    assert a.get("/api/v1/assets?kind=audio").json() == []

    # another org can't see or delete it
    b = new_client(); register(b)
    assert b.get("/api/v1/assets").json() == []
    assert b.request("DELETE", f"/api/v1/assets/{aid}").status_code == 404

    assert a.request("DELETE", f"/api/v1/assets/{aid}").status_code == 204
    assert a.get("/api/v1/assets").json() == []


def test_reject_unsupported_type():
    a = new_client(); register(a)
    r = a.post("/api/v1/assets", files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 415


def test_upload_requires_auth():
    assert new_client().post(
        "/api/v1/assets", files={"file": ("x.png", _PNG, "image/png")}
    ).status_code == 401
