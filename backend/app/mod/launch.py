"""Verificación del token de lanzamiento de `mod_encuestum`.

Moodle firma un token corto con **su clave privada RSA** (RS256) y redirige al
alumno a `GET /mod/launch?t=<JWT>`; Encuestum lo canjea por la cookie de sesión
que ya usa LTI. Este módulo no toca la base ni FastAPI: recibe el token y la
clave pública que quedó registrada en la Tarea 1, y dice si el lanzamiento vale.
El endpoint (`app/routers/modapi.py`) se encarga del resto -- buscar el sitio,
la encuesta y sembrar la cookie.

Las tres cosas que se implementan mal en un verificador de JWT, y que acá están
resueltas a propósito:

1. **`algorithms=["RS256"]` explícito, nunca leído del header.** Si se acepta
   HS256, un atacante firma con la clave *pública* -- que es pública -- usada
   como secreto HMAC y el token valida. Es la confusión de algoritmo clásica, y
   con ella cualquiera lanza como cualquier alumno de cualquier curso. `alg:
   none` cae por el mismo lado.
2. **`exp` corto de verdad.** Un token que vence dentro de una hora *no está
   vencido*, así que PyJWT lo acepta sin chistar. El límite `exp <= iat +
   MAX_VIDA_S` es un chequeo aparte, a mano: sin él, quien vea la URL de
   lanzamiento una vez (el historial del navegador, los logs de un proxy, un
   `Referer`) la puede reusar durante toda esa ventana.
3. **`jti` de un solo uso.** Es lo que convierte "corto" en "una sola vez".
"""

from __future__ import annotations

import threading
import time
import uuid

import jwt

from app.mod.wwwroot import normalizar_wwwroot

# Vida máxima del token, medida como `exp - iat`. El plan la fija en 120 s: es
# lo que tarda un navegador en seguir un redirect, con margen de sobra, y es la
# ventana durante la cual un token filtrado sirve para algo.
MAX_VIDA_S = 120

# Explícito y en un solo lugar. Que esta lista sea constante -- y no salga del
# header del token -- es la mitad de la defensa contra la confusión de
# algoritmo; la otra mitad es no tener nunca una clave simétrica a mano.
ALGORITMOS = ["RS256"]

# Claims sin los cuales el token no significa nada. `exp`/`iat` porque son la
# ventana, `jti` porque es el consumo de un solo uso, `iss` porque es lo que
# ata el token al sitio, y los dos ids porque son el lanzamiento en sí. PyJWT
# trata un claim presente en `null` como ausente, que es lo que queremos.
CLAIMS_REQUERIDOS = ["iss", "iat", "exp", "jti", "site_id", "survey_id"]


class LanzamientoInvalido(Exception):
    """El token no sirve. El motivo se registra pero **no** se le devuelve a
    quien lanza: distinguir "firma inválida" de "sitio desconocido" o de "jti
    repetido" le dice a un atacante exactamente qué le falta ajustar."""


def site_id_declarado(token: str) -> uuid.UUID | None:
    """El `site_id` que *dice* el token, leído SIN verificar la firma.

    Es un problema de huevo y gallina inevitable: la clave con la que se
    verifica la firma se busca por `site_id`, y el `site_id` viene adentro del
    token. Lo que sale de acá no es un dato de confianza -- sólo un índice para
    ir a buscar la clave. Todo lo demás (incluido el `site_id` que se use para
    cualquier decisión) sale del token **ya verificado**, y si el que firmó no
    era el dueño de esa clave, la verificación falla y nada de esto importa.
    """
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
        return uuid.UUID(str(claims.get("site_id")))
    except (jwt.PyJWTError, ValueError, TypeError, AttributeError):
        return None


def verificar_lanzamiento(token: str, public_key: str, wwwroot: str) -> dict:
    """Los claims del token si es auténtico, fresco y de un solo uso.

    `public_key` y `wwwroot` son los de la fila de `mod_sites` que corresponde
    al `site_id` declarado; `wwwroot` ya viene en forma canónica (así lo guarda
    el registro), y el `iss` del token se normaliza con la MISMA función antes
    de compararlos.

    El `jti` se consume al final, después de que todo lo demás pasó: si se
    consumiera antes de verificar la firma, cualquiera podría anular el
    lanzamiento legítimo de un alumno mandando primero un token falso con el
    mismo `jti` -- y de paso llenar el caché sin autenticarse.
    """
    try:
        claims = jwt.decode(
            token,
            public_key,
            algorithms=ALGORITMOS,
            options={"require": CLAIMS_REQUERIDOS},
        )
    except jwt.PyJWTError as exc:
        raise LanzamientoInvalido(f"token inválido: {exc}") from exc

    try:
        iat = int(claims["iat"])
        exp = int(claims["exp"])
    except (KeyError, TypeError, ValueError) as exc:
        raise LanzamientoInvalido("iat/exp no son instantes") from exc
    if exp - iat > MAX_VIDA_S:
        # PyJWT ya comprobó que no está vencido; lo que falta comprobar es que
        # la ventana sea corta. Un `exp` a una hora pasa el chequeo de PyJWT.
        raise LanzamientoInvalido(f"la ventana del token supera {MAX_VIDA_S}s")

    if normalizar_wwwroot(str(claims.get("iss") or "")) != wwwroot:
        # El `iss` tiene que ser el wwwroot del sitio cuya clave acabamos de
        # usar. Sin esto, un Moodle podría firmar tokens que dicen venir de
        # otro sitio -- inofensivo hoy, porque la clave ya lo ató, pero es el
        # invariante que hace que el resto del código pueda confiar en el
        # `iss`.
        raise LanzamientoInvalido("el iss no es el wwwroot del sitio")

    # `CLAIMS_REQUERIDOS` ya lo exigió; el guard igual está porque un `jti`
    # vacío que llegara acá se consumiría como cualquier otro y el segundo
    # lanzamiento sin `jti` sería el que quedaría bloqueado -- un fallo mudo y
    # al revés. Un `KeyError` suelto acá sería un 500.
    jti = str(claims.get("jti") or "")
    if not jti:
        raise LanzamientoInvalido("el token no trae jti")
    if not consumir_jti(jti, exp):
        raise LanzamientoInvalido("jti repetido (replay)")
    return claims


# ── Consumo de `jti` ─────────────────────────────────────────────────────────
#
# Caché en memoria con TTL, no una tabla: las entradas viven a lo sumo
# MAX_VIDA_S (120 s), así que persistirlas sería guardar basura que se borra
# sola dos minutos después, y cada lanzamiento pagaría un INSERT sincrónico.
#
# **Qué pasa con varios workers**: cada proceso tendría su propio caché, así
# que un token podría canjearse una vez por worker. Hoy no pasa -- `start.sh`
# corre `uvicorn app.main:app --host 127.0.0.1 --port 8000`, sin `--workers` y
# sin gunicorn, o sea un solo proceso -- y esto queda documentado acá porque el
# día que alguien agregue `--workers N` la protección de replay se degrada en
# silencio: seguirían pasando todos los tests. Si ese día llega, las opciones
# son un `SETNX` con TTL en el Redis que la app ya sabe usar
# (`ENCUESTUM_REDIS_URL`, ver `app/ratelimit.py`, que tiene exactamente este
# mismo problema y esta misma salida) o una tabla con unique sobre `jti`.
_JTIS: dict[str, float] = {}

# El chequeo y la inserción son un solo bloque sin `await`, así que bajo el
# event loop de asyncio ya serían atómicos; el candado cuesta nada y cubre el
# caso de que algún día esto se llame desde el threadpool (una dependencia
# sincrónica de FastAPI, un `run_in_executor`).
_CANDADO = threading.Lock()


def consumir_jti(jti: str, expira_en: float) -> bool:
    """`True` la primera vez que se ve ese `jti`; `False` en cualquier repetición.

    `expira_en` es el `exp` del token: la entrada no tiene por qué sobrevivir al
    token que la generó, porque después de esa marca el token ya se rechaza por
    vencido y el `jti` deja de necesitar memoria.
    """
    ahora = time.time()
    with _CANDADO:
        # Purga perezosa: el caché sólo crece con lanzamientos ya verificados
        # de los últimos MAX_VIDA_S, así que este barrido es sobre unas pocas
        # entradas y evita tener que correr una tarea de limpieza aparte.
        for viejo, vence in list(_JTIS.items()):
            if vence <= ahora:
                del _JTIS[viejo]
        if jti in _JTIS:
            return False
        _JTIS[jti] = expira_en
        return True
