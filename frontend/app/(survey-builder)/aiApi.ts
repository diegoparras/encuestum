// Cliente tipado para el módulo de IA de Encuestum.
//
// Mismo estilo que `surveyApi.ts`: usa `getApiUrl`, manda las cookies de sesión
// con `credentials: "include"` y, ante un 4xx, el backend responde
// `{ detail: "mensaje en español" }`, que se surfacea lanzando `Error(detail)`.

import { getApiUrl } from "@/utils/api";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type ProviderScope = "org" | "global";
export type ProviderKind = "openai" | "openrouter" | "custom";

export interface Provider {
  id: string;
  scope: ProviderScope;
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
  key_hint: string;
  is_default: boolean;
  enabled: boolean;
  editable: boolean;
  created_at: string;
}

export interface AiModel {
  id: string;
  name: string;
  input_per_m: number | null;
  output_per_m: number | null;
}

export type UsageOperation = "generate" | "grade" | "insights";

export interface UsageRecord {
  id: string;
  operation: UsageOperation;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  survey_id: string | null;
  created_at: string;
}

export interface UsageReport {
  scope: ProviderScope;
  totals: {
    calls: number;
    total_tokens: number;
    total_cost_usd: number | null;
  };
  by_operation: Record<
    string,
    { calls: number; tokens: number; cost_usd: number | null }
  >;
  recent: UsageRecord[];
}

export interface PriceRow {
  id: string | null;
  kind: ProviderKind;
  model: string;
  input_per_m: number;
  output_per_m: number;
  source: "custom" | "default";
}

export interface PricesReport {
  prices: PriceRow[];
  editable: boolean;
}

// Información de consumo que devuelve una llamada puntual a la IA (p. ej. al
// generar preguntas). Se muestra en el `UsageModal`.
export interface UsageInfo {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

// ---------------------------------------------------------------------------
// Helper de request (parsea `{detail}` en error)
// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      if (j && typeof j.detail === "string") msg = j.detail;
    } catch {
      /* no es JSON; usamos el texto crudo */
    }
    throw new Error(msg || `La solicitud falló (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface CreateProviderInput {
  scope: ProviderScope;
  name: string;
  kind: ProviderKind;
  base_url?: string;
  api_key: string;
  model: string;
  is_default?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  is_default?: boolean;
  enabled?: boolean;
}

export interface ListModelsInput {
  kind: ProviderKind;
  base_url?: string;
  api_key: string;
}

export interface PriceInput {
  kind: ProviderKind;
  model: string;
  input_per_m: number;
  output_per_m: number;
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export const aiApi = {
  // ---- Proveedores ----
  listProviders: () => request<Provider[]>("/api/v1/ai/providers"),
  createProvider: (body: CreateProviderInput) =>
    request<Provider>("/api/v1/ai/providers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProvider: (id: string, body: UpdateProviderInput) =>
    request<Provider>(`/api/v1/ai/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProvider: (id: string) =>
    request<void>(`/api/v1/ai/providers/${id}`, { method: "DELETE" }),
  providerModels: (id: string) =>
    request<{ models: AiModel[] }>(`/api/v1/ai/providers/${id}/models`),
  // Lista modelos para el formulario ANTES de guardar el proveedor.
  listModels: (body: ListModelsInput) =>
    request<{ models: AiModel[] }>("/api/v1/ai/list-models", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ---- Consumo ----
  usage: (scope: ProviderScope = "org", limit = 50) =>
    request<UsageReport>(`/api/v1/ai/usage?scope=${scope}&limit=${limit}`),

  // ---- Precios ----
  prices: () => request<PricesReport>("/api/v1/ai/prices"),
  putPrice: (body: PriceInput) =>
    request<void>("/api/v1/ai/prices", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deletePrice: (id: string) =>
    request<void>(`/api/v1/ai/prices/${id}`, { method: "DELETE" }),
};

// Defaults de base_url por tipo de proveedor.
export const BASE_URL_DEFAULTS: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  custom: "",
};

export const KIND_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  custom: "Personalizado",
};

export const OPERATION_LABEL: Record<string, string> = {
  generate: "Generar",
  grade: "Corregir",
  insights: "Insights",
};

// Formatea un costo en USD, o "—" cuando no hay precio configurado.
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  return `US$ ${cost.toFixed(4)}`;
}
