// Client-side helpers to apply design at render time: load web fonts and turn
// relative asset URLs (/assets/…) into absolute ones for the current API host.

import "survey-core/i18n/spanish";
import { surveyLocalization } from "survey-core";
import { getApiUrl } from "@/utils/api";
import { fontById, fontCssFamily, readableForeground, type DesignSettings } from "./model";

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
export function buttonOverrideCss(color?: string | null, shadow?: boolean): string {
  let css = "";
  if (color) {
    const fg = readableForeground(color);
    css += `
.enc-scope .sd-btn { color: ${color}; border-color: ${color}; }
.enc-scope .sd-btn--action { background-color: ${color}; color: ${fg}; border-color: ${color}; }
.enc-scope .sd-btn--action:hover { background-color: ${color}; filter: brightness(0.92); }
`;
  }
  if (shadow) {
    css += `
.enc-scope .sd-btn { box-shadow: 0 4px 14px rgba(0,0,0,0.22); }
.enc-scope .sd-btn:hover { box-shadow: 0 6px 18px rgba(0,0,0,0.28); }
`;
  }
  return css;
}

/** Fuentes por rol: títulos (encuesta/sección), preguntas y botones. Sólo emite
 *  reglas para los roles con fuente propia; sin override, la base rige para todo.
 *  Va después del resto del CSS para ganar por orden. Scope: `enc-scope`. */
export function fontsCss(design: DesignSettings): string {
  let css = "";
  if (design.titleFont) {
    const f = fontCssFamily(design.titleFont);
    css += `.enc-scope .sd-title:not(.sd-question__title), .enc-scope .sd-page__title, .enc-scope .sd-panel__title { font-family: ${f} !important; }\n`;
  }
  if (design.questionFont) {
    const f = fontCssFamily(design.questionFont);
    css += `.enc-scope .sd-question__title, .enc-scope .sd-question__description, .enc-scope .sd-question .sd-input, .enc-scope .sd-question input, .enc-scope .sd-question textarea, .enc-scope .sd-question select, .enc-scope .sd-item__control-label, .enc-scope .sd-selectbase__label, .enc-scope .sd-rating__item-text { font-family: ${f} !important; }\n`;
  }
  if (design.buttonFont) {
    const f = fontCssFamily(design.buttonFont);
    css += `.enc-scope .sd-btn, .enc-scope .sd-navigation button, .enc-scope .sd-action__content { font-family: ${f} !important; }\n`;
  }
  return css;
}

/** Un contenedor visible alrededor de cada pregunta (separador). El trazo y el
 *  tinte dependen del modo para que se note tanto en claro como en oscuro,
 *  incluso con cuadros transparentes sobre una imagen. Scope: `enc-cards`. */
export function cardsCss(dark: boolean): string {
  const line = dark ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.16)";
  const tint = dark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.28)";
  return `
.enc-cards .sd-element.sd-question {
  border: 1.5px solid ${line};
  border-radius: 16px;
  padding: 20px 20px 24px;
  background-color: ${tint};
  background-clip: padding-box;
}
.enc-cards .sd-row + .sd-row { margin-top: 18px; }
.enc-cards .sd-row { margin-bottom: 4px; }
@media (max-width: 640px) {
  .enc-cards .sd-element.sd-question { padding: 14px 14px 18px; }
}
`;
}

/** Centering rules for title, question titles/descriptions, ratings and the
 *  navigation buttons. Scope with `enc-center` on the survey wrapper. */
export const ENC_ALIGN_CSS = `
.enc-center .sd-header__text, .enc-center .sd-title, .enc-center .sd-description { text-align: center; }
.enc-center .sd-question__header, .enc-center .sd-question__title, .enc-center .sd-question__description { text-align: center; }
.enc-center .sd-question__title { justify-content: center; }
.enc-center .sd-action-bar, .enc-center .sd-footer, .enc-center .sd-body__navigation { justify-content: center; }
.enc-center .sd-rating { justify-content: center; margin-left: auto; margin-right: auto; width: fit-content; }
.enc-center .sd-rating__min-text { margin-right: 12px; }
.enc-center .sd-rating__max-text { margin-left: 12px; }
.enc-center .sd-selectbase, .enc-center .sd-imagepicker { margin-left: auto; margin-right: auto; width: fit-content; min-width: 40%; }
.enc-center .sd-boolean { margin-left: auto; margin-right: auto; }
.enc-center .sd-completedpage { text-align: center; }
`;

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
