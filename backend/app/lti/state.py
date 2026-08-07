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


def lti_cookie_kwargs() -> dict:
    """Las cookies del flujo LTI viajan dentro de un iframe de otro dominio:
    sin SameSite=None; Secure el navegador las descarta directamente. A
    diferencia de las cookies de sesión (SameSite=Lax, que sí funcionan sobre
    HTTP plano), acá `Secure` es parte del invariante mismo — no sigue la
    config `cookie_secure` ni se puede apagar. Si esto rompe algo bajo
    TestClient, el fix es que el test hable HTTPS (`base_url="https://..."`),
    no aflojar esta cookie. Vale también para `delete_cookie`: un borrado sin
    estos atributos emite `SameSite=Lax` y el navegador lo descarta, así que la
    cookie sobrevive dentro del iframe.

    Vive acá, al lado de `LTI_COOKIE`, y no en `routers/lti.py` donde nació,
    porque el lanzamiento de `mod_encuestum` (`routers/modapi.py`) siembra
    **esta misma cookie** a propósito: el lado público (`_lti_context` en
    `routers/public.py`) ya sabe leerla y saltear el PIN con ella. Dos
    definiciones de estos atributos serían dos maneras de que una de las dos se
    afloje sin que nadie lo note."""
    return {
        "httponly": True,
        "secure": True,
        "samesite": "none",
        "path": "/",
    }
