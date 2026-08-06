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
    throw new Error(detalle);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const listPlatforms = () => pedir<LtiPlatform[]>("/api/v1/lti/platforms");
export const listLinks = (id: string) => pedir<LtiLink[]>(`/api/v1/lti/platforms/${id}/links`);
export const disconnectPlatform = (id: string) =>
  pedir<void>(`/api/v1/lti/platforms/${id}`, { method: "DELETE" });
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
