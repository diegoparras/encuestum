// Typed client for the Encuestum multi-tenant auth + orgs API.
//
// Every call uses `credentials: "include"` so the browser sends/receives the
// session cookies (`enc_session`, `enc_org`) the backend sets. On a 4xx the
// backend returns `{ detail: "mensaje en español" }`; we surface that message
// by throwing `Error(detail)`.

import { getApiUrl } from "@/utils/api";

export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  is_superadmin: boolean;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: Role;
  created_at: string;
  subdomain?: string | null;
  logo?: string | null;
}

export interface Me {
  user: User;
  orgs: Org[];
  active_org_id: string;
  base_domain?: string | null;
}

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  role: Role;
  joined_at: string;
}

export interface Invitation {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  created_at: string;
  accept_url: string | null;
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

// A fetch that turns a network failure (server unreachable) into a clear,
// Spanish error instead of the browser's "Failed to fetch".
export class ConnectionError extends Error {
  constructor() {
    super("No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.");
    this.name = "ConnectionError";
  }
}

async function safeFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    // TypeError: Failed to fetch → server unreachable / offline / CORS blocked.
    throw new ConnectionError();
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await safeFetch(getApiUrl(path), {
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

// Returns the current session, or null when unauthenticated (401). Throws a
// ConnectionError when the server is unreachable so the shell can distinguish
// "not logged in" from "offline".
export async function getMe(): Promise<Me | null> {
  const res = await safeFetch(getApiUrl("/api/v1/auth/me"), {
    cache: "no-store",
    credentials: "include",
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(await errorMessage(res, `No se pudo obtener la sesión (${res.status})`));
  }
  return (await res.json()) as Me;
}

export function login(email: string, password: string): Promise<Me> {
  return request<Me>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function register(input: {
  email: string;
  password: string;
  name?: string;
  orgName?: string;
}): Promise<Me> {
  const body: Record<string, string> = {
    email: input.email,
    password: input.password,
  };
  if (input.name && input.name.trim()) body.name = input.name.trim();
  if (input.orgName && input.orgName.trim()) body.org_name = input.orgName.trim();
  return request<Me>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function logout(): Promise<void> {
  return request<void>("/api/v1/auth/logout", { method: "POST" });
}

export function switchOrg(orgId: string): Promise<Me> {
  return request<Me>("/api/v1/orgs/switch", {
    method: "POST",
    body: JSON.stringify({ org_id: orgId }),
  });
}

export function createOrg(name: string): Promise<Org> {
  return request<Org>("/api/v1/orgs", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// Set (or clear) the organization's custom subdomain. Pass `null` or `""` to
// remove it. Throws Error(detail) on 422 (invalid/reserved), 409 (taken) or
// 404 (not admin/member).
export function setSubdomain(
  orgId: string,
  subdomain: string | null
): Promise<Org> {
  return request<Org>(`/api/v1/orgs/${orgId}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ subdomain }),
  });
}

// Public branding lookup by subdomain (no auth). Returns `null` on 404 instead
// of throwing, so callers can probe silently.
export async function orgBranding(
  subdomain: string
): Promise<{ name: string; logo: string | null; subdomain: string } | null> {
  const res = await fetch(
    getApiUrl(`/api/v1/orgs/branding/${encodeURIComponent(subdomain)}`),
    { cache: "no-store" }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await errorMessage(res, `No se pudo obtener el branding (${res.status})`));
  }
  return (await res.json()) as { name: string; logo: string | null; subdomain: string };
}

export function listMembers(orgId: string): Promise<Member[]> {
  return request<Member[]>(`/api/v1/orgs/${orgId}/members`);
}

export function addMember(orgId: string, email: string, role: Role): Promise<Member> {
  return request<Member>(`/api/v1/orgs/${orgId}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export function updateMemberRole(
  orgId: string,
  userId: string,
  role: Role
): Promise<Member> {
  return request<Member>(`/api/v1/orgs/${orgId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function removeMember(orgId: string, userId: string): Promise<void> {
  return request<void>(`/api/v1/orgs/${orgId}/members/${userId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Password recovery + email verification
// ---------------------------------------------------------------------------

// Always returns a generic message (no account enumeration).
export function forgotPassword(email: string): Promise<{ detail: string }> {
  return request<{ detail: string }>("/api/v1/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// Throws Error(detail) on a 400 (invalid/expired token).
export function resetPassword(
  token: string,
  password: string
): Promise<{ detail: string }> {
  return request<{ detail: string }>("/api/v1/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

// Throws Error(detail) on a 400 (invalid token).
export function verifyEmail(token: string): Promise<{ detail: string }> {
  return request<{ detail: string }>("/api/v1/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function resendVerification(email: string): Promise<{ detail: string }> {
  return request<{ detail: string }>("/api/v1/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// ---------------------------------------------------------------------------
// Organization invitations
// ---------------------------------------------------------------------------

export function listInvitations(orgId: string): Promise<Invitation[]> {
  return request<Invitation[]>(`/api/v1/orgs/${orgId}/invitations`);
}

// 409 if the email is already a member; 400 on an invalid role.
export function createInvitation(
  orgId: string,
  email: string,
  role: Role
): Promise<Invitation> {
  return request<Invitation>(`/api/v1/orgs/${orgId}/invitations`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export function revokeInvitation(orgId: string, inviteId: string): Promise<void> {
  return request<void>(`/api/v1/orgs/${orgId}/invitations/${inviteId}`, {
    method: "DELETE",
  });
}

// Requires a session. 403 if the invitation email does not match the account;
// 400 if the invitation expired or does not exist.
export function acceptInvite(token: string): Promise<Me> {
  return request<Me>("/api/v1/orgs/accept-invite", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

// Role hierarchy helper: is `role` at least `min`?
const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
