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
