// Typed client for the admin / analytics panels (org-level + platform-wide).
//
// Every call uses `credentials: "include"` so the session cookie is sent. On a
// 4xx the backend returns `{ detail: "mensaje en español" }`; we surface that
// message by throwing `Error(detail)`. The XLSX downloads mirror the pattern in
// `surveyApi.downloadResponses` (fetch → blob → click a temporary anchor).

import { getApiUrl } from "@/utils/api";

export interface OrgRecentSurvey {
  id: string;
  title: string | null;
  slug: string;
  status: "draft" | "published" | "closed";
  responses: number;
  updated_at: string;
}

export interface OrgOverview {
  surveys: number;
  responses: number;
  members: number;
  by_status: {
    draft: number;
    published: number;
    closed: number;
  };
  recent: OrgRecentSurvey[];
}

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  surveys: number;
  responses: number;
  members: number;
  created_at: string;
}

export interface AdminOverview {
  orgs: number;
  users: number;
  surveys: number;
  responses: number;
  organizations: AdminOrganization[];
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

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `${fallback} (${res.status})`));
  }
  return (await res.json()) as T;
}

// Métricas de la organización activa (cualquier miembro).
export function orgOverview(orgId: string): Promise<OrgOverview> {
  return getJson<OrgOverview>(
    `/api/v1/orgs/${orgId}/overview`,
    "No se pudo cargar el panel de la organización"
  );
}

// Métricas globales de la plataforma (solo super-admin → 403 si no).
export function adminOverview(): Promise<AdminOverview> {
  return getJson<AdminOverview>(
    "/api/v1/admin/overview",
    "No se pudo cargar el panel de administración"
  );
}

async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `No se pudo exportar (${res.status})`));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Exporta todas las encuestas de la organización (XLSX, una hoja por encuesta).
export function downloadOrgExport(orgId: string): Promise<void> {
  return download(`/api/v1/orgs/${orgId}/export`, "organizacion.xlsx");
}

// Exporta el resumen de toda la plataforma (XLSX, solo super-admin).
export function downloadAdminExport(): Promise<void> {
  return download("/api/v1/admin/export", "plataforma.xlsx");
}
