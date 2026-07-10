"""SSRF guard: reject URLs that resolve to private / loopback / link-local /
metadata addresses. Used before the server makes any outbound HTTP request on
behalf of a user (webhooks, LLM provider base URLs)."""

import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeUrlError(ValueError):
    pass


def _is_blocked_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True  # not a literal IP → treated by caller via resolution
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local  # 169.254/16 (cloud metadata) + fe80::/10
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def assert_public_url(url: str, *, require_https: bool = False) -> str:
    """Validate a user-supplied outbound URL. Raises UnsafeUrlError if the scheme
    is wrong or the host resolves to a non-public address. Returns the url.

    Honors ENCUESTUM_ALLOW_PRIVATE_OUTBOUND (single-tenant self-host escape)."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https"):
        raise UnsafeUrlError("La URL debe empezar con http:// o https://")
    if require_https and parsed.scheme != "https":
        raise UnsafeUrlError("La URL debe usar HTTPS")
    host = parsed.hostname
    if not host:
        raise UnsafeUrlError("URL sin host")
    from app.config import get_settings

    if get_settings().allow_private_outbound:
        return url  # trusted single-tenant instance
    host_l = host.lower()
    if host_l == "localhost" or host_l.endswith(".localhost") or host_l.endswith(".internal"):
        raise UnsafeUrlError("Host no permitido")
    # Resolve every A/AAAA record and block if ANY is private (DNS-rebinding-safe).
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror:
        raise UnsafeUrlError("No se pudo resolver el host")
    for info in infos:
        ip = info[4][0]
        if _is_blocked_ip(ip):
            raise UnsafeUrlError("La URL apunta a una dirección interna no permitida")
    return url
