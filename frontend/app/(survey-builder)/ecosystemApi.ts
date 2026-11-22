// Organización: claves de la API pública, privacidad (retención y derechos de
// las personas) y tope mensual de IA.

import { getApiUrl } from "@/utils/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      /* sin cuerpo */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: "read" | "write";
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  key?: string; // sólo al crearla
}

export interface PersonFound {
  email: string;
  responses: number;
  invitations: number;
  drafts: number;
  surveys: { survey_id: string; title: string | null; responses: number; invited: boolean }[];
}

export interface Budget {
  budget_usd: number | null;
  spent_usd: number;
  ratio: number | null;
  blocked: boolean;
  warn: boolean;
  month: string;
}

export interface SsoConfig {
  configured: boolean;
  redirect_uri: string;
  issuer?: string;
  client_id?: string;
  client_secret_set?: boolean;
  client_secret_hint?: string | null;
  domains?: string[];
  enabled?: boolean;
  auto_provision?: boolean;
  default_role?: "member" | "viewer";
  enforce?: boolean;
}

export const ecosystemApi = {
  sso: () => req<SsoConfig>("/api/v1/sso"),
  saveSso: (body: {
    issuer: string; client_id: string; client_secret?: string; domains: string[];
    enabled: boolean; auto_provision: boolean; default_role: string; enforce: boolean;
  }) => req<SsoConfig>("/api/v1/sso", { method: "PUT", body: JSON.stringify(body) }),
  deleteSso: () => req<void>("/api/v1/sso", { method: "DELETE" }),
  workflow: () => req<{ require_publish_approval: boolean }>("/api/v1/workflow"),
  setWorkflow: (require_publish_approval: boolean) =>
    req<{ require_publish_approval: boolean }>("/api/v1/workflow", {
      method: "PUT",
      body: JSON.stringify({ require_publish_approval }),
    }),
  pendingApprovals: () => req<{ id: string; title: string | null; by: string; at: string }[]>("/api/v1/workflow/pending"),
  mcpUrl: () => getApiUrl("/api/v1/mcp"),
  setMemberScope: (orgId: string, userId: string, folderIds: string[] | null) =>
    req<{ folder_scope: string[] | null }>(`/api/v1/orgs/${orgId}/members/${userId}/scope`, {
      method: "PUT",
      body: JSON.stringify({ folder_ids: folderIds }),
    }),
  listKeys: () => req<ApiKey[]>("/api/v1/api-keys"),
  createKey: (name: string, scope: "read" | "write") =>
    req<ApiKey>("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name, scope }) }),
  revokeKey: (id: string) => req<void>(`/api/v1/api-keys/${id}`, { method: "DELETE" }),
  docsUrl: () => getApiUrl("/api/v1/ext/docs"),
  apiBase: () => getApiUrl("/api/v1/ext"),

  privacySettings: () =>
    req<{ retention_days: number | null; retention_action: "anonymize" | "delete" | null }>("/api/v1/privacy/settings"),
  setPrivacySettings: (retention_days: number, retention_action: "anonymize" | "delete") =>
    req<{ retention_days: number | null; retention_action: string | null }>("/api/v1/privacy/settings", {
      method: "PUT",
      body: JSON.stringify({ retention_days, retention_action }),
    }),
  findPerson: (email: string) => req<PersonFound>(`/api/v1/privacy/person?email=${encodeURIComponent(email)}`),
  exportPersonUrl: (email: string) => getApiUrl(`/api/v1/privacy/person/export?email=${encodeURIComponent(email)}`),
  erasePerson: (email: string, confirm: string, mode: "delete" | "anonymize") =>
    req<{ responses: number; invitations: number; drafts: number }>("/api/v1/privacy/person/erase", {
      method: "POST",
      body: JSON.stringify({ email, confirm, mode }),
    }),

  budget: () => req<Budget>("/api/v1/ai/budget"),
  setBudget: (budget_usd: number | null) =>
    req<Budget>("/api/v1/ai/budget", { method: "PUT", body: JSON.stringify({ budget_usd }) }),
};
