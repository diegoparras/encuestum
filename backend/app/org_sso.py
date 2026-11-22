"""SSO por organización con cualquier proveedor OIDC.

Flujo (Authorization Code + PKCE, con secreto de cliente):

1. `/auth/org-sso/start?email=ana@escuela.edu` → se busca la organización por
   el dominio del email (o `?org=<slug>`), se descubre el proveedor en
   `<issuer>/.well-known/openid-configuration` y se redirige a su login.
2. `/auth/org-sso/callback` → se canjea el código, se verifica el ID token
   (firma contra el JWKS del proveedor, `iss`, `aud`, `exp`, `nonce`), se exige
   un email verificado del dominio configurado, y se crea la sesión. Con
   `auto_provision` la persona entra a la organización con el rol por defecto.

El estado de la transacción (verifier, state, nonce, org, destino) viaja en una
cookie firmada y de 10 minutos: no hay estado en el servidor.

Este SSO convive con la federación de plataforma (Lockatus, `AUTH_MODE=
federado`): aquélla es para toda la instalación; ésta, para cada organización.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
import urllib.parse
from typing import Optional

import jwt

from app.config import get_settings

CALLBACK_PATH = "/api/v1/auth/org-sso/callback"
TXN_COOKIE = "enc_org_sso"
_TXN_TTL = 600
_CACHE_TTL = 3600
_cache: dict[str, tuple[float, dict]] = {}


class SsoError(Exception):
    """Un problema del lado del proveedor o de la configuración. `code` va en
    la URL de vuelta al login (`?sso_error=`)."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code


def redirect_uri() -> str:
    return f"{get_settings().public_api_base_url.rstrip('/')}{CALLBACK_PATH}"


def clean_domains(raw) -> list[str]:
    out = []
    for d in raw or []:
        d = str(d or "").strip().lower().lstrip("@")
        if not d:
            continue
        if "." not in d or " " in d or "/" in d:
            raise ValueError(f"Dominio inválido: {d}")
        if d not in out:
            out.append(d)
    return out


def email_domain(email: str) -> str:
    return (email or "").rsplit("@", 1)[-1].strip().lower()


# ── HTTP (separado para poder simularlo en los tests) ───────────────────────


async def _get_json(url: str) -> dict:
    import httpx

    from app.net_guard import assert_public_url

    assert_public_url(url)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url)
    r.raise_for_status()
    return r.json()


async def _post_form(url: str, data: dict) -> dict:
    import httpx

    from app.net_guard import assert_public_url

    assert_public_url(url)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(url, data=data, headers={"Accept": "application/json"})
    try:
        return r.json()
    except ValueError:
        return {"error": f"HTTP {r.status_code}"}


async def _cached(url: str) -> dict:
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]
    data = await _get_json(url)
    _cache[url] = (time.time(), data)
    return data


async def discover(issuer: str) -> dict:
    url = issuer.rstrip("/") + "/.well-known/openid-configuration"
    try:
        meta = await _cached(url)
    except Exception as exc:  # noqa: BLE001
        raise SsoError("discovery", f"No se pudo leer {url}: {exc}")
    for k in ("authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"):
        if not meta.get(k):
            raise SsoError("discovery", f"El proveedor no publica {k}")
    return meta


# ── Transacción firmada ─────────────────────────────────────────────────────


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def sign_txn(data: dict) -> str:
    from app.security import create_purpose_token

    return create_purpose_token("org_sso", data, ttl_minutes=_TXN_TTL // 60)


def read_txn(token: Optional[str]) -> Optional[dict]:
    from app.security import read_purpose_token

    return read_purpose_token("org_sso", token or "")


async def authorize_url(cfg, *, next_path: str, login_hint: Optional[str]) -> tuple[str, str]:
    """(URL del proveedor, cookie de transacción)."""
    meta = await discover(cfg.issuer)
    verifier = _b64e(secrets.token_bytes(32))
    challenge = _b64e(hashlib.sha256(verifier.encode()).digest())
    state, nonce = secrets.token_urlsafe(16), secrets.token_urlsafe(16)
    params = {
        "client_id": cfg.client_id, "redirect_uri": redirect_uri(), "response_type": "code",
        "scope": "openid email profile", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256",
    }
    if login_hint:
        params["login_hint"] = login_hint
    sep = "&" if "?" in meta["authorization_endpoint"] else "?"
    url = f"{meta['authorization_endpoint']}{sep}{urllib.parse.urlencode(params)}"
    txn = sign_txn({"o": str(cfg.org_id), "v": verifier, "s": state, "n": nonce, "r": next_path})
    return url, txn


async def finish(cfg, *, code: str, txn: dict) -> dict:
    """Canjea el código y devuelve los claims verificados del ID token."""
    meta = await discover(cfg.issuer)
    tok = await _post_form(meta["token_endpoint"], {
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
        "client_id": cfg.client_id, "client_secret": cfg.client_secret or "",
        "code_verifier": txn["v"],
    })
    id_token = tok.get("id_token")
    if not id_token:
        raise SsoError("token", f"El proveedor no devolvió id_token ({tok.get('error') or 'sin detalle'})")
    claims = await verify_id_token(id_token, meta=meta, client_id=cfg.client_id, nonce=txn["n"])
    email = (claims.get("email") or "").strip().lower()
    if not email:
        raise SsoError("email", "El token no trae email (¿falta el scope «email»?)")
    if claims.get("email_verified") is False:
        raise SsoError("email", "El proveedor no verificó ese email")
    if cfg.domains and email_domain(email) not in cfg.domains:
        raise SsoError("domain", f"{email} no es de un dominio de la organización")
    return claims


async def verify_id_token(token: str, *, meta: dict, client_id: str, nonce: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise SsoError("token", f"ID token ilegible: {exc}")
    alg = header.get("alg")
    if alg not in ("RS256", "RS384", "RS512", "ES256", "ES384", "PS256"):
        # Nunca "none" ni HS*: con HS el "secreto" sería el client_secret y
        # cualquiera con él podría firmar identidades.
        raise SsoError("token", f"Algoritmo no admitido: {alg}")
    jwks = await _cached(meta["jwks_uri"])
    claves = [k for k in jwks.get("keys", []) if not header.get("kid") or k.get("kid") == header.get("kid")]
    if not claves:
        _cache.pop(meta["jwks_uri"], None)  # rotación de claves: se relee la próxima vez
        raise SsoError("token", "Ninguna clave del proveedor coincide con el token")
    try:
        key = jwt.PyJWK(claves[0], algorithm=alg).key
        claims = jwt.decode(token, key, algorithms=[alg], audience=client_id, issuer=meta["issuer"],
                            options={"require": ["exp", "iat", "iss", "aud", "sub"]}, leeway=60)
    except jwt.PyJWTError as exc:
        raise SsoError("token", f"ID token inválido: {exc}")
    if claims.get("nonce") != nonce:
        raise SsoError("token", "nonce inválido")
    return claims


def view(cfg) -> dict:
    secreto = cfg.client_secret or ""
    return {
        "issuer": cfg.issuer, "client_id": cfg.client_id,
        "client_secret_set": bool(secreto), "client_secret_hint": ("…" + secreto[-4:]) if len(secreto) > 4 else None,
        "domains": cfg.domains or [], "enabled": cfg.enabled, "auto_provision": cfg.auto_provision,
        "default_role": cfg.default_role, "enforce": cfg.enforce, "redirect_uri": redirect_uri(),
    }
