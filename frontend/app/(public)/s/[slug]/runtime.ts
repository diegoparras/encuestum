/** Lógica de la encuesta pública fuera de React: visitante, tiempos, idioma,
 *  bandeja sin conexión y seguimiento. Vive fuera del componente para que el
 *  lint de React no la trate como estado ni como render. */

import { type Model, surveyLocalization } from "survey-core";
import { getCaptchaSolution } from "./captcha";

// Sólo permitimos redirigir a URLs http(s) absolutas; cualquier otra cosa se
// ignora para evitar esquemas peligrosos (javascript:, data:, etc.).
export function safeRedirectUrl(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function apiBase(): string {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("fastapiUrl");
    if (param) return param;
  }
  return process.env.NEXT_PUBLIC_API_URL || "";
}

// Anonymous visitor id (localStorage) for funnel analytics — no personal data.
export function getVisitorId(): string | null {
  try {
    const k = "enc_visitor";
    let v = window.localStorage.getItem(k);
    if (!v) {
      v = crypto.randomUUID();
      window.localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return null;
  }
}

// Fire-and-forget funnel ping (view | progress). Never blocks nor throws.
/** Marca de tiempo del borrador local. Fuera del componente: el lint de React
 *  no distingue un callback del render y marca `Date.now()` como impuro. */
export function ahora(): number {
  return Date.now();
}

/** Señales de integridad del examen en curso. Una por página (hay un solo
 *  formulario), fuera de React: se acumulan en eventos del documento y se leen
 *  al enviar, sin re-renderizar. */
export const INTEGRIDAD = { tab_switches: 0, hidden_seconds: 0, pastes: [] as { question: string; chars: number }[] };

/** Segundos que llevó contestar cada pregunta: desde que se mostró la página
 *  (o desde la respuesta anterior en la misma página) hasta que se respondió.
 *  Fuera de React por lo mismo que INTEGRIDAD. */
export const TIEMPOS = { porPregunta: {} as Record<string, number>, marca: 0 };

export function reiniciarTiempos() {
  TIEMPOS.porPregunta = {};
  TIEMPOS.marca = ahora();
}

export function marcarPagina() {
  TIEMPOS.marca = ahora();
}

export function registrarRespuesta(nombre: string) {
  const n = ahora();
  TIEMPOS.porPregunta[nombre] = (TIEMPOS.porPregunta[nombre] || 0) + Math.max(0, (n - TIEMPOS.marca) / 1000);
  TIEMPOS.marca = n;
}

export function tiemposRedondeados(): Record<string, number> {
  return Object.fromEntries(Object.entries(TIEMPOS.porPregunta).map(([k, v]) => [k, Math.round(v)]));
}

/** Los campos ocultos declarados, tal como vinieron en la URL del link. */
export function camposOcultos(nombres?: string[]): Record<string, string> {
  if (!nombres?.length || typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const n of nombres) {
    const v = q.get(n);
    if (v) out[n] = v;
  }
  return out;
}

/** Idioma con que arranca la encuesta: ?lang= del link, si no el del
 *  navegador (si está traducida a ese), si no el original. */
export function idiomaInicial(data: { language?: string | null; languages?: string[] }): string {
  const base = data.language || "es";
  const disp = data.languages ?? [];
  if (!disp.length || typeof window === "undefined") return base;
  const pedido = new URLSearchParams(window.location.search).get("lang");
  if (pedido && disp.includes(pedido)) return pedido;
  for (const l of navigator.languages ?? [navigator.language]) {
    const c = (l || "").slice(0, 2).toLowerCase();
    if (disp.includes(c)) return c;
  }
  return base;
}

/** En SurveyJS el texto `default` de una cadena traducida corresponde al
 *  idioma por defecto (inglés, salvo que se cambie). Nuestro `default` es el
 *  idioma ORIGINAL de la encuesta: sin esto, elegir inglés mostraba el
 *  original en vez de la traducción. */
export function fijarIdiomaOriginal(code: string) {
  surveyLocalization.defaultLocale = code;
}

export function aplicarIdioma(model: Model, code: string) {
  model.locale = code;
}

// ── Sin conexión ────────────────────────────────────────────────────────────
// Si al enviar no hay red, la respuesta queda en este dispositivo y se manda
// sola al volver la conexión (o la próxima vez que se abra la encuesta). Cada
// envío lleva un `submission_id`: si el servidor ya la había recibido (se
// perdió sólo la confirmación), no la duplica.
export const BANDEJA = "enc_outbox";

export type Pendiente = { slug: string; body: Record<string, unknown>; at: number };

export function leerBandeja(): Pendiente[] {
  try {
    return JSON.parse(window.localStorage.getItem(BANDEJA) || "[]");
  } catch {
    return [];
  }
}

export function escribirBandeja(items: Pendiente[]) {
  try {
    if (items.length) window.localStorage.setItem(BANDEJA, JSON.stringify(items));
    else window.localStorage.removeItem(BANDEJA);
  } catch {
    /* sin almacenamiento: no hay nada que hacer */
  }
}

export function encolar(slug: string, body: Record<string, unknown>) {
  escribirBandeja([...leerBandeja(), { slug, body, at: ahora() }]);
}

export function nuevoIdDeEnvio(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${ahora()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Manda lo pendiente. Devuelve cuántas respuestas salieron. */
export async function vaciarBandeja(base: string): Promise<number> {
  const pendientes = leerBandeja();
  if (!pendientes.length || (typeof navigator !== "undefined" && !navigator.onLine)) return 0;
  const quedan: Pendiente[] = [];
  let enviadas = 0;
  for (const p of pendientes) {
    try {
      let body = p.body;
      let r = await fetch(`${base}/api/v1/survey/public/${encodeURIComponent(p.slug)}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (r.status === 400 && body.captcha) {
        // El desafío anti-bot vence: se resuelve otro y se reintenta una vez.
        body = { ...body, captcha: await getCaptchaSolution(base, p.slug) };
        r = await fetch(`${base}/api/v1/survey/public/${encodeURIComponent(p.slug)}/submit`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      }
      if (r.ok) enviadas += 1;
      else if (r.status >= 500 || r.status === 429) quedan.push(p);
      // Otro 4xx (cerrada, cupo lleno, acceso vencido): reintentar no lo arregla.
    } catch {
      quedan.push(p);
    }
  }
  escribirBandeja(quedan);
  return enviadas;
}

/** Registra el service worker que deja abrir la encuesta sin conexión. */
export function registrarServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") return;
  navigator.serviceWorker.register("/sw.js", { scope: "/s/" }).catch(() => {});
}

export function trackVisit(slug: string, event: "view" | "progress", question?: string) {
  const vid = getVisitorId();
  if (!vid) return;
  fetch(`${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitor_id: vid, event, question }),
    keepalive: true,
  }).catch(() => {
    /* analytics es best-effort */
  });
}
