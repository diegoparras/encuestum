"""State y nonce del flujo OIDC, y la cookie que traspasa la identidad.

El `state` va en una cookie de vida corta y se compara contra el que devuelve la
plataforma: es lo que impide que alguien monte un lanzamiento desde otro lado.
El `nonce` viaja dentro del state firmado, así no hace falta almacenamiento.
"""

from __future__ import annotations

import secrets

LTI_STATE_COOKIE = "enc_lti_state"
LTI_COOKIE = "enc_lti"
LTI_STATE_PURPOSE = "lti_state"
LTI_PURPOSE = "lti_access"

# El lanzamiento debe consumirse enseguida; el acceso dura lo que la clase.
STATE_TTL_S = 600
ACCESS_TTL_S = 4 * 3600


def new_state() -> tuple[str, str]:
    """Un par (state, nonce) nuevo, ambos impredecibles."""
    return secrets.token_urlsafe(24), secrets.token_urlsafe(24)
