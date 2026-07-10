"""Unit tests para los fixes de seguridad que no dependen de DNS/red."""

from app.net_guard import _is_blocked_ip


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
