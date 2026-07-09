from tests.conftest import new_client, register, super_client


def _super_client():
    return super_client()


def test_org_provider_crud_and_key_masking():
    c = new_client(); register(c)
    r = c.post(
        "/api/v1/ai/providers",
        json={
            "scope": "org", "name": "Mi OpenRouter", "kind": "openrouter",
            "api_key": "sk-or-secret-abcd1234", "model": "openai/gpt-4o-mini",
        },
    )
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["scope"] == "org" and p["editable"] is True
    assert p["base_url"].startswith("https://openrouter")
    assert p["key_hint"].endswith("1234") and "secret" not in p["key_hint"]
    pid = p["id"]

    assert any(x["id"] == pid for x in c.get("/api/v1/ai/providers").json())

    r2 = c.patch(f"/api/v1/ai/providers/{pid}", json={"model": "anthropic/claude-3.5-sonnet"})
    assert r2.status_code == 200 and r2.json()["model"] == "anthropic/claude-3.5-sonnet"

    assert c.delete(f"/api/v1/ai/providers/{pid}").status_code == 200
    assert not any(x["id"] == pid for x in c.get("/api/v1/ai/providers").json())


def test_only_one_default_per_scope():
    c = new_client(); register(c)
    a = c.post("/api/v1/ai/providers", json={"scope": "org", "name": "A", "kind": "openrouter", "api_key": "sk-aaaaaaaa", "model": "m1", "is_default": True}).json()
    b = c.post("/api/v1/ai/providers", json={"scope": "org", "name": "B", "kind": "openrouter", "api_key": "sk-bbbbbbbb", "model": "m2", "is_default": True}).json()
    providers = {x["id"]: x for x in c.get("/api/v1/ai/providers").json()}
    assert providers[b["id"]]["is_default"] is True
    assert providers[a["id"]]["is_default"] is False


def test_global_provider_requires_super():
    c = new_client(); register(c)
    r = c.post("/api/v1/ai/providers", json={"scope": "global", "name": "G", "kind": "openrouter", "api_key": "sk-12345678", "model": "x"})
    assert r.status_code == 403

    s = _super_client()
    r2 = s.post("/api/v1/ai/providers", json={"scope": "global", "name": "Global", "kind": "openrouter", "api_key": "sk-globalkey", "model": "openai/gpt-4o-mini"})
    assert r2.status_code == 200 and r2.json()["scope"] == "global"


def test_prices_defaults_and_super_only_edit():
    c = new_client(); register(c)
    pr = c.get("/api/v1/ai/prices").json()
    assert pr["editable"] is False
    assert any(x["model"] == "gpt-4o-mini" and x["source"] == "default" for x in pr["prices"])
    # regular user cannot edit
    assert c.put("/api/v1/ai/prices", json={"kind": "openai", "model": "gpt-4o-mini", "input_per_m": 1, "output_per_m": 2}).status_code == 403

    s = _super_client()
    assert s.put("/api/v1/ai/prices", json={"kind": "custom", "model": "mi-modelo", "input_per_m": 0.5, "output_per_m": 1.5}).status_code == 200
    pr2 = s.get("/api/v1/ai/prices").json()
    assert pr2["editable"] is True
    assert any(x["model"] == "mi-modelo" and x["source"] == "custom" for x in pr2["prices"])


def test_usage_starts_empty():
    c = new_client(); register(c)
    u = c.get("/api/v1/ai/usage").json()
    assert u["scope"] == "org"
    assert u["totals"]["calls"] == 0
    assert u["recent"] == []
    # regular user can't request global scope
    assert c.get("/api/v1/ai/usage?scope=global").status_code == 403
