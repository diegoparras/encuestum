"""Unit tests para los fixes de seguridad que no dependen de DNS/red."""

import asyncio

from app.net_guard import _is_blocked_ip


class _NoPrivateOutbound:
    """Settings stub: apaga el escape single-tenant para poder probar el guard
    (el conftest lo deja en true para que la suite no dependa de DNS)."""

    allow_private_outbound = False


def test_webhook_delivery_revalidates_url(monkeypatch):
    """El guard SSRF debe correr en CADA entrega, no solo al registrar el webhook.

    Si solo se validara al crearlo, un dominio que resuelve a una IP pública en
    ese momento podría re-apuntarse después (TTL bajo) a la red interna, y cada
    respuesta nueva sería un SSRF persistente.
    """
    import httpx

    import app.config as config
    from app import webhooks

    monkeypatch.setattr(config, "get_settings", lambda: _NoPrivateOutbound())

    attempted = []

    class _ClientNeverUsed:
        def __init__(self, *a, **k):
            attempted.append(True)

        async def __aenter__(self):
            raise AssertionError("no se debe abrir el cliente HTTP")

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(httpx, "AsyncClient", _ClientNeverUsed)

    ok = asyncio.run(
        webhooks.post_webhook("http://169.254.169.254/latest/meta-data", "secreto", {"a": 1})
    )

    assert ok is False
    # Lo que realmente importa: ni siquiera se intentó la petición saliente.
    assert attempted == []


def test_webhook_delivery_allows_public_url(monkeypatch):
    """El guard no debe romper los webhooks legítimos: con un host público, la
    entrega sigue su curso normal."""
    import socket

    import httpx

    import app.config as config
    import app.net_guard as net_guard
    from app import webhooks

    monkeypatch.setattr(config, "get_settings", lambda: _NoPrivateOutbound())
    # Sin depender de DNS real: el host resuelve a una IP pública.
    monkeypatch.setattr(
        net_guard.socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
    )

    sent = []

    class _Resp:
        status_code = 200

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, content=None, headers=None):
            sent.append((url, headers))
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _Client)

    ok = asyncio.run(webhooks.post_webhook("https://hooks.example.com/x", "secreto", {"a": 1}))

    assert ok is True
    assert len(sent) == 1
    # Y sigue firmando el payload (no rompimos el HMAC al agregar el guard).
    assert sent[0][1]["X-Encuestum-Signature"].startswith("sha256=")


def test_ssrf_blocks_internal_ips():
    for ip in [
        "127.0.0.1",       # loopback
        "10.0.0.5",        # privada
        "192.168.1.10",    # privada
        "172.16.0.1",      # privada
        "169.254.169.254", # metadata cloud (link-local)
        "::1",             # loopback v6
        "0.0.0.0",         # unspecified
    ]:
        assert _is_blocked_ip(ip) is True, ip


def test_ssrf_allows_public_ips():
    for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34"]:
        assert _is_blocked_ip(ip) is False, ip


def test_superadmin_needs_verified_email():
    from app.models import User
    from app.deps import is_superadmin
    from app.config import get_settings

    email = get_settings().superadmin_email  # "super@example.com" en tests
    # Coincide el email pero NO verificado → NO es super-admin.
    u = User(email=email, password_hash="x", email_verified=False)
    assert is_superadmin(u) is False
    # Verificado → sí.
    u.email_verified = True
    assert is_superadmin(u) is True
    # Columna is_superadmin siempre gana.
    u2 = User(email="otro@example.com", password_hash="x", is_superadmin=True)
    assert is_superadmin(u2) is True
