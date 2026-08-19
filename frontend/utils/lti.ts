// Cliente tipado de la superficie LTI del panel (Moodle y cualquier otro LMS
// que hable LTI 1.3).
//
// Ojo con el orden de las llamadas: con `LTI_ENABLED` apagado, TODO
// `/api/v1/lti/*` responde 404 a propósito (ver `require_lti` en
// `backend/app/routers/lti.py`) — no 403 ni 501. Por eso la sección del panel
// consulta primero `ltiEnabled()`, que lee `/api/v1/auth/config` (siempre
// disponible): sin ese chequeo previo, un servidor con LTI apagado mostraría
// un error de red donde debería haber una explicación.
//
// Igual que `utils/webhooks.ts`: `credentials: "include"` para mandar la
// cookie de sesión, y en un 4xx el backend devuelve `{ detail: "..." }` que
// surfacemos como `Error(detail)`.

import { getApiUrl } from "@/utils/api";

export interface LtiPlatform {
  id: string;
  issuer: string;
  name: string | null;
  created_at: string;
  activities: number;
  responses: number;
}

export interface LtiLink {
  id: string;
  survey_id: string;
  survey_title: string;
  context_title: string | null;
  resource_link_id: string;
  anonymous: boolean;
  responses: number;
  last_response_at: string | null;
}

// Un error de la API con el status HTTP a mano. La pantalla de alta manual
// necesita distinguir 409, 400 y 403 para explicar cada uno con sus propias
// palabras; el mensaje sigue siendo el `detail` que mandó el backend, así que
// todo lo que ya existía —que sólo lo muestra— no cambia en nada.
export class ErrorLti extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ErrorLti";
    this.status = status;
  }
}

async function pedir<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    let detalle = "No se pudo completar la operación.";
    try {
      const d = await res.json();
      if (typeof d?.detail === "string" && d.detail.trim()) detalle = d.detail;
    } catch {
      /* se usa el mensaje por defecto */
    }
    throw new ErrorLti(detalle, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const listPlatforms = () => pedir<LtiPlatform[]>("/api/v1/lti/platforms");
export const listLinks = (id: string) => pedir<LtiLink[]>(`/api/v1/lti/platforms/${id}/links`);
export const disconnectPlatform = (id: string) =>
  pedir<void>(`/api/v1/lti/platforms/${id}`, { method: "DELETE" });
// El alta manual, para quien no puede usar el registro dinámico (que lo hace
// un administrador del SITIO de Moodle). Espejo exacto de `PlatformIn` en
// `backend/app/routers/lti.py`: `deployment_ids` es una lista aunque casi
// siempre traiga un solo id, y `name` es lo único opcional.
export interface PlatformIn {
  issuer: string;
  client_id: string;
  deployment_ids: string[];
  auth_login_url: string;
  auth_token_url: string;
  jwks_url: string;
  name?: string | null;
}

export const createPlatform = (datos: PlatformIn) =>
  pedir<{ id: string }>("/api/v1/lti/platforms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(datos),
  });

// La otra mitad del intercambio: las URLs de ESTA instalación que hay que
// pegar del lado del LMS. Los paths son los del router público de
// `backend/app/routers/lti.py` (`/lti/login`, `/lti/launch`, `/lti/jwks.json`),
// que se monta en la raíz, no bajo `/api/v1`.
//
// El origen es la mejor aproximación disponible desde el frontend, NO la
// verdad: el backend arma sus propias URLs con `public_base_url`
// (`ENCUESTUM_PUBLIC_URL`) y ese valor no está publicado en ningún endpoint
// que podamos leer —`/auth/config` no lo trae y agregarlo sería tocar el
// backend—. Se usa entonces `NEXT_PUBLIC_API_URL` si está definido (que es
// donde vive de verdad el backend) y si no el origen desde el que se está
// mirando el panel, que es lo correcto en el despliegue documentado, donde
// nginx sirve panel y API en el mismo dominio. Por eso la pantalla avisa al
// lado de las URLs que hay que verificarlas contra el dominio público real.
export interface UrlsInstalacion {
  origin: string;
  launch: string;
  jwks: string;
  login: string;
}

export function urlsInstalacion(): UrlsInstalacion | null {
  // Devuelve null en el servidor: esto sólo tiene sentido en el navegador, y
  // los componentes cliente igual se prerenderizan del lado del servidor.
  if (typeof window === "undefined") return null;
  const absoluta = (path: string) => new URL(getApiUrl(path), window.location.origin);
  const launch = absoluta("/lti/launch");
  return {
    origin: launch.origin,
    launch: launch.toString(),
    jwks: absoluta("/lti/jwks.json").toString(),
    login: absoluta("/lti/login").toString(),
  };
}

export const createRegistrationUrl = () =>
  pedir<{ url: string }>("/api/v1/lti/registration-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

// Si este servidor tiene la integración con LMS activa. Endpoint público (no
// pide sesión) y el único que contesta con LTI apagado — ver el comentario de
// arriba sobre por qué hay que consultarlo ANTES que cualquier `/lti/*`.
export async function ltiEnabled(): Promise<boolean> {
  const res = await fetch(getApiUrl("/api/v1/auth/config"), { cache: "no-store" });
  if (!res.ok) throw new Error("No se pudo leer la configuración del servidor.");
  const data = await res.json();
  return data?.lti_enabled === true;
}
