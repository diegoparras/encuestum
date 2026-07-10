"""Proof-of-work captcha (Altcha-style), self-contained — no third party.

The server hands out a challenge: `challenge = sha256(salt + secretNumber)`, plus
an HMAC `signature` over the challenge+expiry so it can't be forged. The browser
brute-forces `secretNumber` in [0, maxnumber) — cheap for one human (~half a
second), expensive for a bot firing thousands of submissions. On submit we verify
the number reproduces the challenge, the signature is ours, it hasn't expired, and
it hasn't been used before (replay protection).

Nothing leaves the instance; there are no keys to configure and no user puzzles.
Replay state is in-memory (fine for a single instance); use Redis for multi-node.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Any

from app.config import get_settings

_ALGO = "SHA-256"

# Signatures already spent (replay guard): signature -> expiry epoch seconds.
_used: dict[str, float] = {}
_MAX_USED = 50_000  # backstop so the map can't grow unbounded


def _secret() -> bytes:
    return get_settings().session_secret.encode("utf-8")


def _sign(challenge: str, expires: int) -> str:
    msg = f"{challenge}.{expires}".encode("utf-8")
    return hmac.new(_secret(), msg, hashlib.sha256).hexdigest()


def make_challenge() -> dict[str, Any]:
    """Build a fresh challenge to send to the browser."""
    settings = get_settings()
    max_number = settings.captcha_max_number
    number = secrets.randbelow(max_number)
    salt = secrets.token_hex(12)
    challenge = hashlib.sha256(f"{salt}{number}".encode("utf-8")).hexdigest()
    expires = int(time.time()) + settings.captcha_ttl_seconds
    return {
        "algorithm": _ALGO,
        "challenge": challenge,
        "salt": salt,
        "maxnumber": max_number,
        "expires": expires,
        "signature": _sign(challenge, expires),
    }


def _prune(now: float) -> None:
    if len(_used) < _MAX_USED:
        # Cheap opportunistic prune of expired entries.
        expired = [s for s, exp in _used.items() if exp < now]
        for s in expired:
            _used.pop(s, None)
        return
    # Hard cap hit: drop everything expired, then oldest, to bound memory.
    for s in [s for s, exp in _used.items() if exp < now]:
        _used.pop(s, None)
    while len(_used) >= _MAX_USED:
        _used.pop(next(iter(_used)), None)


def verify_solution(payload: Any) -> bool:
    """Validate a solved challenge coming back from the browser.

    `payload` is the object the client echoes back: the fields we issued plus the
    `number` it found. Returns True only if everything checks out.
    """
    if not isinstance(payload, dict):
        return False
    try:
        challenge = str(payload["challenge"])
        salt = str(payload["salt"])
        number = int(payload["number"])
        expires = int(payload["expires"])
        signature = str(payload["signature"])
    except (KeyError, TypeError, ValueError):
        return False

    now = time.time()
    if expires < now:
        return False
    if number < 0 or number > get_settings().captcha_max_number:
        return False
    # The signature must be one we produced over this exact challenge+expiry.
    if not hmac.compare_digest(signature, _sign(challenge, expires)):
        return False
    # The number must actually reproduce the challenge.
    recomputed = hashlib.sha256(f"{salt}{number}".encode("utf-8")).hexdigest()
    if not hmac.compare_digest(recomputed, challenge):
        return False
    # Replay guard: a signature can only be spent once.
    if signature in _used:
        return False
    _prune(now)
    _used[signature] = float(expires)
    return True
