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
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
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
        except Exception:  # noqa: BLE001 — if Redis is down, fall back to memory
            pass
    _check_memory(key, limit, window_s)
