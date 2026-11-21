"""Rate limiter (fixed window per client IP + bucket).

In-memory by default; if ENCUESTUM_REDIS_URL is set, uses Redis so the limit is
shared across instances. Async so the Redis path doesn't block the event loop.
"""

import threading
import time
from collections import defaultdict

from fastapi import HTTPException, Request

from app.config import get_settings

_lock = threading.Lock()
_hits: dict[str, tuple[float, int]] = defaultdict(lambda: (0.0, 0))
# Cada cuánto se barren las ventanas vencidas del modo en memoria. Antes no se
# barrían nunca: cada IP distinta dejaba su clave para siempre y la memoria
# crecía sin techo (justo bajo un ataque con muchas IPs, cuando más importa).
_SWEEP_EVERY_S = 300
_MAX_WINDOW_S = 3600
_last_sweep = 0.0


def _sweep(now: float) -> None:
    """Saca las ventanas que ya vencieron. Se llama con `_lock` tomado."""
    global _last_sweep
    if now - _last_sweep < _SWEEP_EVERY_S:
        return
    _last_sweep = now
    for k in [k for k, (start, _c) in _hits.items() if now - start >= _MAX_WINDOW_S]:
        del _hits[k]

_redis = None
_redis_init = False


def _get_redis():
    global _redis, _redis_init
    if _redis_init:
        return _redis
    _redis_init = True
    url = get_settings().redis_url
    if url:
        import redis.asyncio as aioredis  # lazy import

        _redis = aioredis.from_url(url, encoding="utf-8", decode_responses=True)
    return _redis


def _client_ip(request: Request) -> str:
    # Only honor X-Forwarded-For when we're explicitly behind a trusted proxy,
    # and then take the RIGHTMOST hop (the one our proxy appended), since the
    # leftmost values are attacker-controlled. Otherwise the socket peer IP.
    if get_settings().trust_proxy:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            parts = [p.strip() for p in fwd.split(",") if p.strip()]
            if parts:
                return parts[-1]
    return request.client.host if request.client else "unknown"


def _too_many(retry: int) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail="Demasiados intentos. Probá de nuevo en un momento.",
        headers={"Retry-After": str(max(1, retry))},
    )


def _check_memory(key: str, limit: int, window_s: int) -> None:
    now = time.time()
    with _lock:
        _sweep(now)
        start, count = _hits[key]
        if now - start >= window_s:
            _hits[key] = (now, 1)
            return
        if count >= limit:
            raise _too_many(int(window_s - (now - start)))
        _hits[key] = (start, count + 1)


async def _check_redis(client, key: str, limit: int, window_s: int) -> None:
    count = await client.incr(key)
    if count == 1:
        await client.expire(key, window_s)
    if count > limit:
        ttl = await client.ttl(key)
        raise _too_many(ttl if ttl and ttl > 0 else window_s)


async def rate_limit(request: Request, bucket: str, *, limit: int, window_s: int) -> None:
    if not get_settings().rate_limit_enabled:
        return
    key = f"rl:{bucket}:{_client_ip(request)}"
    client = _get_redis()
    if client is not None:
        try:
            await _check_redis(client, key, limit, window_s)
            return
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — if Redis is down, fall back to memory
            # Avisa: con Redis caído el límite pasa a ser por proceso, y con
            # varias réplicas eso lo multiplica. Antes caía en silencio.
            _warn_redis_down(exc)
    _check_memory(key, limit, window_s)


_redis_warned_at = 0.0


def _warn_redis_down(exc: Exception) -> None:
    global _redis_warned_at
    import logging

    now = time.time()
    if now - _redis_warned_at > 300:
        _redis_warned_at = now
        logging.getLogger("encuestum.ratelimit").warning(
            "Redis no responde (%s): el rate limit cae a memoria, por proceso.", exc
        )
