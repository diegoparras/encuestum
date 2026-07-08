// Minimal API helper for the standalone Encuestum frontend.
//
// The backend runs as a separate service, so the base URL is configured at
// build time via NEXT_PUBLIC_API_URL (e.g. http://localhost:8000). If it is
// empty, requests go same-origin (useful when a reverse proxy fronts both).

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || "";
}

function isAbsoluteHttpUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

export function getApiUrl(path: string): string {
  if (isAbsoluteHttpUrl(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${apiBaseUrl()}${normalized}`;
}

// Optional admin gate: if the backend has ENCUESTUM_ADMIN_TOKEN set, the admin
// routes require a matching X-Admin-Token header. Expose the same token to the
// browser via NEXT_PUBLIC_ENCUESTUM_ADMIN_TOKEN so the admin app can call them.
export function adminHeaders(): Record<string, string> {
  const token = process.env.NEXT_PUBLIC_ENCUESTUM_ADMIN_TOKEN;
  return token ? { "X-Admin-Token": token } : {};
}

export async function getApiErrorMessage(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  try {
    const data: unknown = await response.clone().json();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const err = data as { detail?: unknown; message?: string; error?: string };
      if (typeof err.detail === "string") return err.detail;
      if (err.message) return err.message;
      if (err.error) return err.error;
    }
  } catch {
    try {
      const text = await response.text();
      if (text) return text;
    } catch {
      /* fall through */
    }
  }
  return fallbackMessage;
}
