// Cliente tipado del módulo nativo de Moodle (`mod_encuestum`) para el panel.
//
// La superficie que hay hoy es UN endpoint: `POST /api/v1/mod/connect-url`
// (ver `backend/app/routers/modapi.py`), que devuelve el link que el admin pega
// en los ajustes del plugin. Todavía no existen "listar sitios conectados" ni
// "desconectar" — que sí existen para LTI — así que la pantalla puede dar de
// alta una conexión pero no puede mostrar cuáles ya se dieron de alta.
//
// **El 404 es información, no un fallo.** Con `MOD_ENABLED` sin definir, todo
// `/mod/*` responde 404 a propósito (`require_mod`, mismo criterio que
// `require_lti`). Y a diferencia de LTI, esa bandera **no** viaja en
// `/api/v1/auth/config`, que sólo expone `lti_enabled`: no hay nada que
// consultar antes de llamar. O sea que el único momento en que el cliente se
// entera de que el módulo está apagado es este mismo POST, y el único indicio
// es el código de estado. Por eso el 404 se traduce a `ModuloApagado` y una
// caída de transporte a `ErrorDeRed`: son dos pantallas distintas ("falta
// definir la variable en el servidor" contra "el servidor no contesta") y
// confundirlas manda al administrador a tocar lo que no es.
//
// Lo prolijo sería que `/auth/config` expusiera `mod_enabled` igual que
// `lti_enabled`, y que esta sección lo consultara ANTES de ofrecer el botón;
// mientras eso no exista, la distinción vive acá.
//
// Igual que `utils/lti.ts` y `utils/webhooks.ts`: `credentials: "include"` para
// mandar la cookie de sesión, y en un 4xx el backend devuelve `{ detail: "..." }`
// que surfacemos como `Error(detail)`.

import { getApiUrl } from "@/utils/api";

/** El módulo está apagado en este servidor (`MOD_ENABLED` sin definir). */
export class ModuloApagado extends Error {
  constructor() {
    super("El módulo nativo de Moodle está apagado en este servidor.");
    this.name = "ModuloApagado";
  }
}

/** No hubo respuesta del servidor (sin conexión, DNS, TLS, CORS). */
export class ErrorDeRed extends Error {
  constructor() {
    super("No se pudo contactar al servidor.");
    this.name = "ErrorDeRed";
  }
}

export interface ModConnectUrl {
  /** Endpoint + `?enc=<token>`: es lo único que el admin tiene que copiar. */
  url: string;
  /**
   * El mismo token, suelto. El plugin lo saca de la URL, así que la pantalla no
   * lo muestra; queda tipado porque el backend lo devuelve y esconderlo del tipo
   * haría creer que no viene.
   */
  token: string;
  /**
   * Vida del token, en segundos. La pantalla lo muestra en minutos en vez de
   * hardcodear "30": si el backend cambia `MOD_REGISTER_TOKEN_TTL_MIN`, el texto
   * cambia solo en vez de mentir.
   */
  expires_in: number;
}

export async function createModConnectUrl(): Promise<ModConnectUrl> {
  let res: Response;
  try {
    res = await fetch(getApiUrl("/api/v1/mod/connect-url"), {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    // `fetch` sólo rechaza por problemas de transporte: cualquier respuesta del
    // servidor, incluso un 500, resuelve. Ese reparto es lo que permite que más
    // abajo el 404 signifique "el servidor contestó que esto no existe" y no
    // "no llegamos".
    throw new ErrorDeRed();
  }
  if (res.status === 404) {
    // Ver la cabecera del archivo: bandera apagada. También cae acá un backend
    // viejo que no tenga el router de `mod`, y el remedio que ve el admin es el
    // mismo (definir la variable y actualizar el servidor).
    throw new ModuloApagado();
  }
  if (!res.ok) {
    let detalle = "No se pudo completar la operación.";
    try {
      const d = await res.json();
      if (typeof d?.detail === "string" && d.detail.trim()) detalle = d.detail;
    } catch {
      /* se usa el mensaje por defecto */
    }
    throw new Error(detalle);
  }
  return (await res.json()) as ModConnectUrl;
}
