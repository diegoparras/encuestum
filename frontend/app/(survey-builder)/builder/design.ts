// Client-side helpers to apply design at render time: load web fonts and turn
// relative asset URLs (/assets/…) into absolute ones for the current API host.

import "survey-core/i18n/spanish";
import { surveyLocalization } from "survey-core";
import { getApiUrl } from "@/utils/api";
import { fontById, readableForeground } from "./model";

// Progress bar reads "Pregunta X de Y" (each page is one question) instead of
// the default "Página X de Y".
try {
  const es = (surveyLocalization as any).locales?.es;
  if (es) {
    es.progressText = "Pregunta {0} de {1}";
    es.pageProgressText = "Pregunta {0} de {1}";
  }
} catch {
  /* localization is best-effort */
}

const _loaded = new Set<string>();

/** Inject the Google Fonts stylesheet for a font id, once. No-op for "system". */
export function loadFont(id: string): void {
  if (typeof document === "undefined") return;
  const font = fontById(id);
  if (font.id === "system" || _loaded.has(font.id)) return;
  _loaded.add(font.id);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  if (font.google) {
    // Curated font: CSS2 with the exact weight spec.
    link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
  } else {
    // Arbitrary searched family: the v1 API tolerates weights the font lacks
    // (never 400s the whole stylesheet), so request a common set.
    const fam = (font.family || font.id).replace(/\s+/g, "+");
    link.href = `https://fonts.googleapis.com/css?family=${fam}:400,500,600,700&display=swap`;
  }
  link.setAttribute("data-encuestum-font", font.id);
  document.head.appendChild(link);
}

/** CSS that recolors the SurveyJS navigation buttons independently from the
 *  accent. Scope with the `enc-scope` class on the survey wrapper. Empty when
 *  no override is set (the accent keeps ruling). */
export function buttonOverrideCss(color?: string | null): string {
  if (!color) return "";
  const fg = readableForeground(color);
  return `
.enc-scope .sd-btn { color: ${color}; border-color: ${color}; }
.enc-scope .sd-btn--action { background-color: ${color}; color: ${fg}; border-color: ${color}; }
.enc-scope .sd-btn--action:hover { background-color: ${color}; filter: brightness(0.92); }
`;
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
