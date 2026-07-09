// Client-side helpers to apply design at render time: load web fonts and turn
// relative asset URLs (/assets/…) into absolute ones for the current API host.

import { getApiUrl } from "@/utils/api";
import { fontById } from "./model";

const _loaded = new Set<string>();

/** Inject the Google Fonts stylesheet for a font id, once. No-op for "system". */
export function loadFont(id: string): void {
  if (typeof document === "undefined") return;
  const font = fontById(id);
  if (!font.google || _loaded.has(font.id)) return;
  _loaded.add(font.id);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
  link.setAttribute("data-encuestum-font", font.id);
  document.head.appendChild(link);
}

/** Resolve an asset URL. Relative (/assets/…) → absolute against the API base. */
export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith("/")) return getApiUrl(url);
  return url;
}

/** Deep-clone an object, rewriting any "/assets/…" string to an absolute URL so
 *  SurveyJS-rendered media (backgroundImage, image elements, logo) load in dev
 *  where the frontend and API are on different origins. */
export function absolutizeAssets<T>(value: T): T {
  if (typeof value === "string") {
    if (value.startsWith("/assets/")) return resolveAssetUrl(value) as unknown as T;
    // Also rewrite asset URLs embedded inside HTML (e.g. a video <src>).
    if (value.includes("/assets/")) {
      return value.replace(/\/assets\/[^\s"')]+/g, (m) => resolveAssetUrl(m)) as unknown as T;
    }
    return value as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => absolutizeAssets(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      out[k] = absolutizeAssets(v);
    }
    return out as T;
  }
  return value;
}
