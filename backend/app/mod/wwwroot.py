"""Forma canónica del `wwwroot` de un Moodle conectado.

Vive acá, y no en `routers/modapi.py` donde nació, porque la usan los dos lados
del módulo y tienen que usar **la misma**: el registro, para que la unicidad de
`mod_sites` no se pueda esquivar con una barra final, y el lanzamiento, para
comparar el `iss` del token contra el `wwwroot` guardado. Si cada lado
normalizara a su manera, un sitio registrado como `https://moodle.x/` no
matchearía nunca el `iss` `https://moodle.x` y el síntoma (ningún lanzamiento
verifica) aparecería lejísimos de la causa.
"""

from urllib.parse import urlsplit, urlunsplit

_PUERTO_POR_DEFECTO = {"http": 80, "https": 443}


def normalizar_wwwroot(crudo: str) -> str:
    """Forma canónica del `wwwroot`, para que la unicidad no se pueda esquivar.

    `https://moodle.x/`, `https://MOODLE.X` y `https://moodle.x?a=1` son el
    mismo sitio. Si cada variante de escritura fuera una fila distinta, el
    chequeo de dueño del registro (el 409 de `register_site`) se saltearía
    agregando una barra final -- y quedarían dos filas para el mismo Moodle,
    cada una con su clave, sin que nada avise.

    También descarta el userinfo (`https://user:pass@moodle.x`): son
    credenciales que no tienen por qué quedar persistidas, y dos escrituras del
    mismo host con userinfo distinto son el mismo sitio.

    Una URL que no se pueda partir vuelve tal cual, recortada: no es trabajo de
    esta función rechazarla -- eso lo hace `assert_public_url`, que es la única
    validación de URL de este repositorio."""
    crudo = (crudo or "").strip()
    partes = urlsplit(crudo)
    if not partes.scheme or not partes.netloc:
        return crudo
    esquema = partes.scheme.lower()
    host = (partes.hostname or "").lower()
    if not host:
        return crudo
    if ":" in host:
        # IPv6 literal: `hostname` devuelve la dirección sin corchetes y sin
        # ellos la URL reconstruida no sería parseable.
        host = f"[{host}]"
    autoridad = host
    try:
        puerto = partes.port
    except ValueError:
        # Puerto no numérico: la URL está rota, que la rechace el guard.
        return crudo
    # El puerto por defecto del esquema no aporta nada y separaría dos
    # escrituras del mismo sitio (`https://x` y `https://x:443`).
    if puerto is not None and puerto != _PUERTO_POR_DEFECTO.get(esquema):
        autoridad = f"{host}:{puerto}"
    return urlunsplit((esquema, autoridad, partes.path.rstrip("/"), "", ""))
