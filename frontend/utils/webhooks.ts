// Typed client for the org-level webhooks API.
//
// Cada respuesta enviada a una encuesta se POSTea en tiempo real a la URL del
// webhook (Zapier, Make, Google Sheets o una URL propia) con los headers
// `X-Encuestum-Event` y `X-Encuestum-Signature: sha256=<hmac>` (firmado con el
// `secret` del webhook). Todas las llamadas usan `credentials: "include"` para
// mandar la cookie de sesión; en un 4xx el backend devuelve
// `{ detail: "mensaje en español" }` que surfacemos como `Error(detail)`.

import { getApiUrl } from "@/utils/api";

export interface Webhook {
  id: string;
  url: string;
  // null → aplica a TODAS las encuestas de la org; con valor → solo a esa.
  survey_id: string | null;
  active: boolean;
  secret: string;
  created_at: string;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await res.clone().json();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const detail = (data as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) return detail;
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `La solicitud falló (${res.status})`));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Lista los webhooks de la org (admin+). 404 si no sos miembro, 403 si no admin.
export function listWebhooks(orgId: string): Promise<Webhook[]> {
  return request<Webhook[]>(`/api/v1/orgs/${orgId}/webhooks`);
}

// Crea un webhook. `surveyId` opcional (undefined/null = todas las encuestas).
// 422 si la URL no empieza con http/https; 404 si el survey_id no es de la org.
export function createWebhook(
  orgId: string,
  url: string,
  surveyId?: string | null
): Promise<Webhook> {
  const body: { url: string; survey_id?: string } = { url };
  if (surveyId) body.survey_id = surveyId;
  return request<Webhook>(`/api/v1/orgs/${orgId}/webhooks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteWebhook(orgId: string, id: string): Promise<void> {
  return request<void>(`/api/v1/orgs/${orgId}/webhooks/${id}`, {
    method: "DELETE",
  });
}

// Envía un payload de prueba a la URL del webhook y devuelve si respondió ok.
export function testWebhook(orgId: string, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/v1/orgs/${orgId}/webhooks/${id}/test`, {
    method: "POST",
  });
}
