"""Tiny in-memory rate limiter (fixed window per client IP + bucket).

Good enough for a single instance. For multi-instance deployments, swap the
backing store for Redis. Fails open only on internal errors, never silently.
"""

import threading
import time
from collections import defaultdict

from fastapi import HTTPException, Request

_lock = threading.Lock()
# key -> (window_start_epoch, count)
_hits: dict[str, tuple[float, int]] = defaultdict(lambda: (0.0, 0))


def _client_ip(request: Request) -> str:
    # Behind nginx we set X-Forwarded-For; take the first hop.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(request: Request, bucket: str, *, limit: int, window_s: int) -> None:
    from app.config import get_settings

    if not get_settings().rate_limit_enabled:
        return
    now = time.time()
    key = f"{bucket}:{_client_ip(request)}"
    with _lock:
        start, count = _hits[key]
        if now - start >= window_s:
            _hits[key] = (now, 1)
            return
        if count >= limit:
            retry = int(window_s - (now - start))
            raise HTTPException(
                status_code=429,
                detail="Demasiados intentos. Probá de nuevo en un momento.",
                headers={"Retry-After": str(max(1, retry))},
            )
        _hits[key] = (start, count + 1)
