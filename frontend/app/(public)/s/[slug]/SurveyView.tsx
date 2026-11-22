"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Model, surveyLocalization } from "survey-core";
// Debe ir antes de instanciar el Model: desactiva el atajo "valor|etiqueta".
import "@/lib/surveyjs";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "survey-core/i18n/spanish";
// Textos propios de SurveyJS (botones, errores) en los idiomas a los que se
// puede traducir una encuesta.
import "survey-core/i18n/portuguese";
import "survey-core/i18n/french";
import "survey-core/i18n/italian";
import "survey-core/i18n/german";
import "survey-core/i18n/simplified-chinese";
import "survey-core/i18n/japanese";
import "survey-core/i18n/catalan";
import "survey-core/i18n/basque";
import "survey-core/i18n/dutch";
import "survey-core/i18n/polish";
import "survey-core/i18n/russian";
import "survey-core/i18n/arabic";
import "survey-core/i18n/korean";
import { toast } from "sonner";
import { Award, Check, Music, Volume2, VolumeX } from "lucide-react";
import {
  perQuestionStyleCss,
  themeToDesign,
  type AudioSettings,
  type StateScreenConfig,
} from "../../../(survey-builder)/builder/model";
import {
  absolutizeAssets,
  alignOverrideCss,
  buttonOverrideCss,
  cardsCss,
  ENC_ALIGN_CSS,
  fontsCss,
  loadFont,
  resolveAssetUrl,
} from "../../../(survey-builder)/builder/design";
import { orgBranding } from "@/utils/auth";
import { useI18n } from "@/lib/i18n";
import { uploadRespondentFile } from "./uploadFile";
import { registerVideoResponseQuestion } from "./VideoResponseQuestion";
import {
  AccessGate,
  PostSubmitScreen,
  useMagicLinkParams,
} from "./AccessGate";
import { Certificate } from "./Certificate";
import { ChatSurveyView } from "./ChatSurveyView";
import { ThankYouView } from "./ThankYouView";
import { getCaptchaSolution } from "./captcha";
import FullscreenButton from "./FullscreenButton";

// Register the custom "videoresponse" question (webcam recorder) before any
// Survey model parses JSON that uses it.
registerVideoResponseQuestion();

interface EvaluationMeta {
  enabled?: boolean;
  feedbackTiming?: "immediate" | "onComplete" | "never";
  showScoreToRespondent?: boolean;
  passingScore?: number;
  integrity?: {
    shuffleQuestions?: boolean;
    shuffleChoices?: boolean;
    timeLimitSec?: number | null;
    maxAttempts?: number;
    groups?: Record<string, number>;
    signals?: boolean;
  };
}

interface PublicSurvey {
  slug: string;
  title: string | null;
  language: string | null;
  json_schema: Record<string, any>;
  theme: Record<string, any> | null;
  evaluation: EvaluationMeta | null;
  available?: boolean;
  closed_reason?: string | null;
  access_mode?: "public" | "pin" | "list";
  gated?: boolean;
  // Distribución: pantalla de gracias personalizable y redirección al terminar.
  thankyou_message?: string | null;
  grading_message?: string | null;
  redirect_url?: string | null;
  // Anti-bot: exige resolver un proof-of-work antes de enviar.
  require_captcha?: boolean;
  hidden_fields?: string[];
  languages?: string[];
}

// Sólo permitimos redirigir a URLs http(s) absolutas; cualquier otra cosa se
// ignora para evitar esquemas peligrosos (javascript:, data:, etc.).
function safeRedirectUrl(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

interface GradedResult {
  /** Reclamos hechos (estado y respuesta) y si se pueden hacer. */
  appeals?: { question: string; status: string; reply: string | null }[];
  can_appeal?: boolean;
  total?: number;
  max?: number;
  percent?: number;
  passed?: boolean | null;
  needs_review?: boolean;
  questions: {
    name?: string;
    title: string;
    verdict: string;
    awarded: number;
    points: number;
    feedback: string;
    /** Lo que respondió esta persona (siempre viene). */
    answer?: string;
    /** La correcta: sólo si el autor habilitó revelarla en esta pregunta. */
    correct_answer?: string;
    /** Por qué no era correcta (del autor o de la IA). */
    explanation?: string;
  }[];
}

type Status = "loading" | "ready" | "notfound" | "error";

function apiBase(): string {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("fastapiUrl");
    if (param) return param;
  }
  return process.env.NEXT_PUBLIC_API_URL || "";
}

// Anonymous visitor id (localStorage) for funnel analytics — no personal data.
function getVisitorId(): string | null {
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
function ahora(): number {
  return Date.now();
}

/** Señales de integridad del examen en curso. Una por página (hay un solo
 *  formulario), fuera de React: se acumulan en eventos del documento y se leen
 *  al enviar, sin re-renderizar. */
const INTEGRIDAD = { tab_switches: 0, hidden_seconds: 0, pastes: [] as { question: string; chars: number }[] };

/** Segundos que llevó contestar cada pregunta: desde que se mostró la página
 *  (o desde la respuesta anterior en la misma página) hasta que se respondió.
 *  Fuera de React por lo mismo que INTEGRIDAD. */
const TIEMPOS = { porPregunta: {} as Record<string, number>, marca: 0 };
function reiniciarTiempos() {
  TIEMPOS.porPregunta = {};
  TIEMPOS.marca = ahora();
}
function marcarPagina() {
  TIEMPOS.marca = ahora();
}
function registrarRespuesta(nombre: string) {
  const n = ahora();
  TIEMPOS.porPregunta[nombre] = (TIEMPOS.porPregunta[nombre] || 0) + Math.max(0, (n - TIEMPOS.marca) / 1000);
  TIEMPOS.marca = n;
}
function tiemposRedondeados(): Record<string, number> {
  return Object.fromEntries(Object.entries(TIEMPOS.porPregunta).map(([k, v]) => [k, Math.round(v)]));
}

/** Los campos ocultos declarados, tal como vinieron en la URL del link. */
function camposOcultos(nombres?: string[]): Record<string, string> {
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
function idiomaInicial(data: { language?: string | null; languages?: string[] }): string {
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
function fijarIdiomaOriginal(code: string) {
  surveyLocalization.defaultLocale = code;
}

function aplicarIdioma(model: Model, code: string) {
  model.locale = code;
}

// ── Sin conexión ────────────────────────────────────────────────────────────
// Si al enviar no hay red, la respuesta queda en este dispositivo y se manda
// sola al volver la conexión (o la próxima vez que se abra la encuesta). Cada
// envío lleva un `submission_id`: si el servidor ya la había recibido (se
// perdió sólo la confirmación), no la duplica.
const BANDEJA = "enc_outbox";
type Pendiente = { slug: string; body: Record<string, unknown>; at: number };

function leerBandeja(): Pendiente[] {
  try {
    return JSON.parse(window.localStorage.getItem(BANDEJA) || "[]");
  } catch {
    return [];
  }
}

function escribirBandeja(items: Pendiente[]) {
  try {
    if (items.length) window.localStorage.setItem(BANDEJA, JSON.stringify(items));
    else window.localStorage.removeItem(BANDEJA);
  } catch {
    /* sin almacenamiento: no hay nada que hacer */
  }
}

function encolar(slug: string, body: Record<string, unknown>) {
  escribirBandeja([...leerBandeja(), { slug, body, at: ahora() }]);
}

function nuevoIdDeEnvio(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${ahora()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Manda lo pendiente. Devuelve cuántas respuestas salieron. */
async function vaciarBandeja(base: string): Promise<number> {
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
function registrarServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") return;
  navigator.serviceWorker.register("/sw.js", { scope: "/s/" }).catch(() => {});
}

function trackVisit(slug: string, event: "view" | "progress", question?: string) {
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

export default function SurveyView({ slug }: { slug: string }) {
  const { t } = useI18n();
  // El modelo de SurveyJS se construye en un useMemo que NO debe rehacerse al
  // cambiar de idioma (perdería respuestas). Leemos `t` por ref para usarlo en
  // los callbacks del modelo sin meterlo en las dependencias.
  const tRef = useRef(t);
  tRef.current = t;
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<PublicSurvey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<GradedResult | null>(null);
  // Credenciales (email + código) del respondiente en modo lista: habilitan el
  // certificado imprimible en la pantalla de resultado.
  const [certCreds, setCertCreds] = useState<{ email: string; code: string } | null>(
    null
  );
  // Encuesta terminada (para mostrar el mensaje de gracias personalizado).
  const [completed, setCompleted] = useState(false);
  // Redirección al terminar: mostramos "Redirigiendo…" antes de navegar.
  const [redirecting, setRedirecting] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  // Respuestas guardadas sin conexión: se mandan al abrir y al volver la red.
  useEffect(() => {
    registrarServiceWorker();
    const enviar = () => {
      vaciarBandeja(apiBase()).then((n) => {
        if (n > 0) toast.success(t("public.offline.sent", { n }));
      });
    };
    enviar();
    window.addEventListener("online", enviar);
    return () => window.removeEventListener("online", enviar);
  }, [t]);
  // Access token for gated (pin/list) surveys; set once the access gate passes.
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Post-submit screen for list-mode surveys (thank-you + result lookup).
  const [postSubmit, setPostSubmit] = useState<{ pending: boolean } | null>(null);
  const magic = useMagicLinkParams();
  const [branding, setBranding] = useState<{
    name: string;
    logo: string | null;
  } | null>(null);

  // Branding header: when the survey is served from an organization's own
  // subdomain (e.g. `acme.encuestum.example`), show that org's name/logo on top.
  // On localhost, an IP, or an apex domain we render nothing (default behavior).
  useEffect(() => {
    let cancelled = false;
    try {
      const hostname = window.location.host.split(":")[0];
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
      const parts = hostname.split(".");
      if (hostname === "localhost" || isIp || parts.length < 3) return;
      const sub = parts[0].toLowerCase();
      if (["www", "api", "app"].includes(sub)) return;
      orgBranding(sub)
        .then((b) => {
          if (!cancelled && b) setBranding({ name: b.name, logo: b.logo });
        })
        .catch(() => {
          /* branding is best-effort; ignore */
        });
    } catch {
      /* window unavailable or parse error; ignore */
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const brandingHeader = branding ? (
    <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3">
      {branding.logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolveAssetUrl(branding.logo)}
          alt={branding.name}
          className="h-8 w-auto max-w-[160px] object-contain"
        />
      )}
      <span className="text-sm font-semibold text-neutral-800">
        {branding.name}
      </span>
    </div>
  ) : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}`,
          { cache: "no-store" }
        );
        if (res.status === 404) {
          if (!cancelled) setStatus("notfound");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as PublicSurvey;
        if (!cancelled) {
          setData(json);
          setStatus("ready");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Examen con intento en el servidor (tiempo límite, sorteo o señales): se
  // pide el intento ANTES de armar el formulario, porque define qué preguntas
  // ve esta persona y cuánto tiempo le queda. Ver backend/app/exam.py.
  const integ = data?.evaluation?.integrity;
  const necesitaIntento =
    !!data?.evaluation?.enabled &&
    !!(integ?.timeLimitSec || (integ?.groups && Object.keys(integ.groups).length) || integ?.signals);
  const listoParaIntento =
    status === "ready" && !!data && data.available !== false && !(data.gated === true && !accessToken);
  const [examen, setExamen] = useState<{
    status: "loading" | "ready" | "error";
    token?: string;
    secondsLeft?: number | null;
    schema?: Record<string, unknown>;
    signals?: boolean;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!necesitaIntento || !listoParaIntento) return;
    let cancel = false;
    fetch(`${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/start`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: getVisitorId(), ...(accessToken ? { access_token: accessToken } : {}) }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (cancel) return;
        if (!r.ok) {
          setExamen({ status: "error", error: typeof j?.detail === "string" ? j.detail : undefined });
          return;
        }
        if (!j?.exam) {
          setExamen({ status: "ready" });
          return;
        }
        setExamen({
          status: "ready",
          token: j.exam.attempt_token,
          secondsLeft: j.exam.seconds_left,
          schema: j.exam.json_schema,
          signals: !!j.exam.signals,
        });
      })
      .catch(() => !cancel && setExamen({ status: "error" }));
    return () => {
      cancel = true;
    };
  }, [necesitaIntento, listoParaIntento, slug, accessToken]);

  // Señales de integridad (sólo si el examen las pide): cuántas veces salió de
  // la pestaña, cuánto tiempo estuvo afuera y textos largos pegados. Se
  // mandan con la respuesta; el servidor las registra para el docente.
  useEffect(() => {
    if (!examen?.signals) return;
    const integridad = { current: INTEGRIDAD };
    let ocultoDesde: number | null = null;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        integridad.current.tab_switches += 1;
        ocultoDesde = Date.now();
      } else if (ocultoDesde) {
        integridad.current.hidden_seconds += Math.round((Date.now() - ocultoDesde) / 1000);
        ocultoDesde = null;
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const texto = e.clipboardData?.getData("text") ?? "";
      const nombre = (e.target as HTMLElement | null)?.closest("[data-name]")?.getAttribute("data-name") ?? "";
      if (texto.length) integridad.current.pastes.push({ question: nombre, chars: texto.length });
    };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("paste", onPaste, true);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("paste", onPaste, true);
    };
  }, [examen?.signals]);

  // Funnel: una vista por visitante al cargar la encuesta (disponible o no gated).
  useEffect(() => {
    if (status === "ready" && data && data.available !== false) {
      trackVisit(slug, "view");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, slug]);

  const model = useMemo(() => {
    if (!data) return null;
    if (necesitaIntento && listoParaIntento && examen?.status !== "ready") return null;
    const evalMeta = data.evaluation || {};
    const isExam = !!evalMeta.enabled;
    const survey = new Model(absolutizeAssets(examen?.schema || data.json_schema || {}));
    fijarIdiomaOriginal(data.language || "es");
    survey.locale = idiomaInicial(data);
    // The custom video-response recorder reads this to upload to the right survey.
    survey.setVariable("encSlug", slug);
    const themeDesign = themeToDesign(data.theme);
    if (data.theme) {
      try {
        const theme = absolutizeAssets(data.theme) as any;
        // Paint the background full-screen from the page wrapper (below) instead
        // of SurveyJS's own survey element, which in one-per-page mode is short
        // and leaves a band below. So we drop the image here and make the survey
        // surface transparent — the wrapper shows through.
        if (theme.backgroundImage) {
          delete theme.backgroundImage;
          delete theme.backgroundOpacity;
          theme.cssVariables = {
            ...(theme.cssVariables || {}),
            "--sjs-general-backcolor-dim": "transparent",
          };
        }
        survey.applyTheme(theme);
      } catch {
        /* best-effort */
      }
    }

    // Funnel: primer valor respondido = "comenzó"; cada cambio de página marca
    // la última pregunta vista (punto de abandono si no termina).
    let startedTracked = false;
    reiniciarTiempos();
    survey.onCurrentPageChanged.add(marcarPagina);
    survey.onValueChanged.add((_s, opt) => {
      if (opt?.name) registrarRespuesta(opt.name);
    });
    survey.onValueChanged.add((_s, opt: any) => {
      if (!startedTracked) {
        startedTracked = true;
        trackVisit(slug, "progress", opt?.name);
      }
    });
    survey.onCurrentPageChanged.add((sender) => {
      const first = sender.currentPage?.questions?.[0]?.name;
      if (first) trackVisit(slug, "progress", first);
    });

    // Screen transitions when it's one-question-per-page.
    const transition = themeDesign.pageTransition;
    if (transition && transition !== "none") {
      survey.onCurrentPageChanged.add(() => {
        if (typeof document === "undefined") return;
        const el = document.querySelector(".sd-body") as HTMLElement | null;
        if (!el) return;
        el.style.animation = "none";
        // Force reflow so the animation replays on every page change.
        void el.offsetWidth;
        el.style.animation = `enc-${transition} 380ms cubic-bezier(0.22,0.61,0.36,1)`;
      });
    }

    // Video/file answers: upload straight to storage via a presigned URL, so the
    // file never bloats our server. The stored answer is the file's public URL.
    survey.onUploadFiles.add(async (_sender, options: any) => {
      try {
        const uploaded = [];
        for (const file of options.files) {
          const content = await uploadRespondentFile(slug, file);
          uploaded.push({ file, content });
        }
        options.callback("success", uploaded);
      } catch {
        options.callback("error");
        toast.error(tRef.current("public.upload.fileError"));
      }
    });

    // Save & resume: keep partial answers on this device and restore them, so a
    // respondent can close the tab and come back. Cleared on submit.
    const resumeKey = `enc_resume_${slug}`;
    let localAt = 0;
    try {
      const saved =
        typeof window !== "undefined" ? window.localStorage.getItem(resumeKey) : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.data) survey.data = parsed.data;
        if (typeof parsed?.page === "number") survey.currentPageNo = parsed.page;
        if (typeof parsed?.at === "number") localAt = parsed.at;
      }
    } catch {
      /* ignore corrupt resume state */
    }

    // Borrador en el SERVIDOR: sólo existe cuando se sabe quién responde
    // (invitado con código, alumno desde Moodle) y permite retomar desde otro
    // dispositivo. En encuestas públicas anónimas el servidor contesta
    // `enabled: false` y no se le vuelve a mandar nada.
    const draftUrl = `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/draft`;
    let serverDrafts: boolean | null = null;
    let touched = false;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    fetch(
      `${draftUrl}${accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : ""}`,
      { credentials: "include", cache: "no-store" }
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        serverDrafts = !!j?.enabled;
        const d = j?.draft;
        // Gana el más nuevo, y nunca se pisa lo que la persona ya empezó acá.
        if (!d || touched) return;
        if (localAt && Date.parse(d.updated_at) <= localAt) return;
        if (d.answers && Object.keys(d.answers).length) survey.data = d.answers;
        if (typeof d.page === "number") survey.currentPageNo = d.page;
      })
      .catch(() => {
        serverDrafts = false;
      });
    const pushDraft = () => {
      if (serverDrafts === false) return;
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        fetch(draftUrl, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers: survey.data,
            page: survey.currentPageNo,
            ...(accessToken ? { access_token: accessToken } : {}),
          }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (j && j.enabled === false) serverDrafts = false;
          })
          .catch(() => {
            /* best-effort: el borrador local sigue */
          });
      }, 2000);
    };

    const persist = () => {
      touched = true;
      try {
        window.localStorage.setItem(
          resumeKey,
          JSON.stringify({ data: survey.data, page: survey.currentPageNo, at: ahora() })
        );
      } catch {
        /* storage may be unavailable */
      }
      pushDraft();
    };
    survey.onValueChanged.add(persist);
    survey.onCurrentPageChanged.add(persist);
    survey.onComplete.add(() => {
      // El envío borra el borrador del servidor; uno pendiente no lo revive.
      if (draftTimer) clearTimeout(draftTimer);
      serverDrafts = false;
      try {
        window.localStorage.removeItem(resumeKey);
      } catch {
        /* ignore */
      }
    });

    // Prefill por query params: `/s/slug?nombre=Ana` precarga la pregunta cuyo
    // nombre sea "nombre". Sólo cargamos claves que coincidan con nombres de
    // pregunta y excluimos params reservados por la plataforma.
    try {
      const params = new URLSearchParams(window.location.search);
      const reserved = new Set([
        "email",
        "code",
        "access_token",
        "fastapiUrl",
        "embed",
        "redirect_url",
      ]);
      const names = new Set(
        survey.getAllQuestions().map((q: any) => q.name as string)
      );
      const prefill: Record<string, any> = {};
      params.forEach((value, key) => {
        if (reserved.has(key)) return;
        if (names.has(key)) prefill[key] = value;
      });
      if (Object.keys(prefill).length > 0) {
        survey.data = { ...survey.data, ...prefill };
      }
    } catch {
      /* prefill es best-effort; ignorar errores de parseo */
    }

    // La pantalla final por defecto de SurveyJS es pobre y no respeta el tema:
    // para encuestas comunes siempre renderizamos nuestra pantalla de gracias
    // (con el mensaje personalizado si hay, o el texto por defecto).
    if (!isExam) {
      survey.showCompletedPage = false;
    }

    // Integrity options for assessments.
    if (isExam) {
      const integ = evalMeta.integrity || {};
      if (integ.shuffleQuestions) survey.questionOrder = "random";
      if (integ.shuffleChoices) {
        survey.getAllQuestions().forEach((q: any) => {
          if ("choicesOrder" in q) q.choicesOrder = "random";
        });
      }
      // El tiempo que queda lo calcula el SERVIDOR (desde que empezó el
      // intento): recargar la página no reinicia el reloj.
      const restante = examen?.secondsLeft ?? integ.timeLimitSec;
      if (restante) {
        survey.maxTimeToFinish = Math.max(1, restante);
        survey.showTimer = true;
        survey.timerLocation = "top";
      }
      // We render our own results screen for exams.
      survey.showCompletedPage = evalMeta.feedbackTiming === "never";
    }

    // Live per-question feedback (immediate mode).
    if (isExam && evalMeta.feedbackTiming === "immediate") {
      survey.onValueChanged.add(async (_sender, options) => {
        try {
          const res = await fetch(
            `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/grade-question`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: options.name,
                answer: options.value,
                ...(accessToken ? { access_token: accessToken } : {}),
              }),
            }
          );
          if (!res.ok) return; // not gradable → ignore
          const g = await res.json();
          const ok = g.verdict === "correct";
          const partial = g.verdict === "partial";
          toast[ok ? "success" : partial ? "message" : "error"](
            `${g.awarded}/${g.points} · ${
              g.feedback ||
              (ok
                ? tRef.current("public.answer.correct")
                : tRef.current("public.answer.review"))
            }`
          );
        } catch {
          /* ignore live-grading hiccups */
        }
      });
    }

    survey.onComplete.add(async (sender) => {
      setSubmitting(true);
      try {
        // Anti-bot: si la encuesta lo exige, resolvemos el proof-of-work antes de
        // enviar (invisible para la persona, ~medio segundo).
        let captchaSolution = null;
        if (data.require_captcha) {
          try {
            captchaSolution = await getCaptchaSolution(apiBase(), slug);
          } catch {
            /* si falla, el backend rechazará y el usuario puede reintentar */
          }
        }
        const cuerpo: Record<string, unknown> = {
              answers: sender.data,
              completed: true,
              // Gated surveys require the access token obtained at the gate.
              ...(accessToken ? { access_token: accessToken } : {}),
              ...(captchaSolution ? { captcha: captchaSolution } : {}),
              ...(examen?.token ? { attempt_token: examen.token } : {}),
              meta: {
                locale: sender.locale || data.language || null,
                referrer: typeof document !== "undefined" ? document.referrer : null,
                visitor_id: getVisitorId(),
                ...(examen?.signals ? { integrity: INTEGRIDAD } : {}),
                hidden: camposOcultos(data.hidden_fields),
                timing: tiemposRedondeados(),
                submission_id: nuevoIdDeEnvio(),
              },
            };
        let res: Response;
        try {
          res = await fetch(`${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cuerpo),
          });
        } catch {
          // Sin red: la respuesta queda guardada acá y sale sola después.
          encolar(slug, cuerpo);
          setOffline(true);
          return;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          // Cupo lleno u otro rechazo del servidor: se muestra el motivo en vez
          // de un "gracias" que haría creer que la respuesta quedó guardada.
          const d = body?.detail;
          setRejected(typeof d === "string" ? d : typeof d?.message === "string" ? d.message : "");
          return;
        }
        // Redirección al terminar: si hay una URL válida y NO hay cuenta
        // regresiva configurada, saltamos directo (mostrando "Redirigiendo…").
        // Con cuenta regresiva, dejamos que la pantalla de gracias la muestre.
        const redirectTo = safeRedirectUrl(data.redirect_url);
        const tyCfg = themeToDesign(data.theme).thankYou;
        const hasCountdown = !!(tyCfg?.redirectCountdown && tyCfg.redirectCountdown > 0);
        if (redirectTo && !hasCountdown) {
          setRedirecting(true);
          setTimeout(() => {
            window.location.href = redirectTo;
          }, 900);
          return;
        }
        if (body?.status === "graded" && body.result) {
          setResults(body.result as GradedResult);
          // En modo lista, si tenemos email + código (magic link), habilitamos
          // el certificado al aprobar.
          if (data.access_mode === "list" && magic.email && magic.code) {
            setCertCreds({ email: magic.email, code: magic.code });
          }
        } else if (body?.results_pending && body?.can_check) {
          // Results held back: offer the result-lookup screen instead.
          setPostSubmit({ pending: true });
        } else if (data.access_mode === "list") {
          // List-mode: always let respondents look their result up later.
          setPostSubmit({ pending: false });
        } else {
          // Encuesta común: marcamos como terminada para la pantalla de gracias.
          setCompleted(true);
        }
      } catch {
        /* una falla al procesar la respuesta del servidor: la respuesta ya se guardó */
      } finally {
        setSubmitting(false);
      }
    });

    return survey;
  }, [data, slug, accessToken, magic, examen, necesitaIntento, listoParaIntento]);

  const design = useMemo(() => themeToDesign(data?.theme), [data]);
  useEffect(() => {
    for (const f of [design.fontFamily, design.titleFont, design.questionFont, design.buttonFont]) {
      if (f) loadFont(f);
    }
  }, [design.fontFamily, design.titleFont, design.questionFont, design.buttonFont]);

  // Tokens de personalización en la pantalla de gracias: {nombrePregunta} se
  // reemplaza por la respuesta del participante (ej. "¡Gracias, {nombre}!").
  const resolveTokens = React.useCallback(
    (text: string) => {
      if (!text || !model) return text || "";
      return text.replace(/\{([^}]+)\}/g, (_m, key: string) => {
        const name = key.trim();
        try {
          const q = (model as any).getQuestionByName?.(name);
          const v = q?.displayValue ?? (model.data ? (model.data as any)[name] : undefined);
          return v != null && v !== "" ? String(v) : "";
        } catch {
          return "";
        }
      });
    },
    [model]
  );

  if (status === "loading") return <Centered>{t("public.loading")}</Centered>;
  if (necesitaIntento && listoParaIntento && examen?.status === "error")
    return (
      <Centered>
        <h1 className="text-xl font-semibold">{t("public.error.title")}</h1>
        <p className="text-sm opacity-70 mt-2">{examen.error || t("public.error.body")}</p>
      </Centered>
    );
  if (necesitaIntento && listoParaIntento && examen?.status !== "ready")
    return <Centered>{t("public.loading")}</Centered>;
  if (status === "notfound")
    return (
      <Centered>
        <h1 className="text-xl font-semibold">{t("public.notfound.title")}</h1>
        <p className="text-sm opacity-70 mt-2">{t("public.notfound.body")}</p>
      </Centered>
    );
  if (status === "error" || !model)
    return (
      <Centered>
        <h1 className="text-xl font-semibold">{t("public.error.title")}</h1>
        <p className="text-sm opacity-70 mt-2">{t("public.error.body")}</p>
      </Centered>
    );

  const accent = data?.theme?.cssVariables?.["--sjs-primary-backcolor"] || "#8faf0e";

  if (data && data.available === false) {
    const cc = design.closed;
    // Con mensaje propio, el motivo automático (fecha/cupo/cerrada) queda como
    // línea secundaria si el operador no lo desactivó.
    const reason =
      cc?.message && (cc.showReason ?? true) ? data.closed_reason || undefined : undefined;
    return (
      <StateScreen
        config={cc}
        accent={accent}
        dark={design.mode === "dark"}
        title={cc?.title ?? data.title ?? undefined}
        message={cc?.message || data.closed_reason || t("public.closed.default")}
        reason={reason}
        footer={t("public.closed.thanks")}
      />
    );
  }

  if (offline) {
    return (
      <Centered>
        <p className="max-w-md text-center text-base">{t("public.offline.saved")}</p>
      </Centered>
    );
  }

  if (rejected !== null) {
    return (
      <Centered>
        <p className="max-w-md text-center text-base">{rejected || t("public.submit.rejected")}</p>
      </Centered>
    );
  }

  if (redirecting) {
    return (
      <Centered>
        <p className="text-sm opacity-70">{t("public.redirecting")}</p>
      </Centered>
    );
  }

  if (results) {
    return (
      <ResultsScreen
        results={results}
        accent={accent}
        slug={slug}
        apiBase={apiBase}
        certCreds={certCreds}
      />
    );
  }

  // Encuesta terminada. Mensaje (con tokens resueltos) + pantalla de gracias
  // rica. En modo chat con cierre "burbuja", el gracias lo muestra el propio
  // chat (más abajo); acá sólo atajamos el modo "pantalla completa".
  const ty = design.thankYou;
  const finishMessage = resolveTokens(data?.thankyou_message || t("public.thankyou.default"));
  const chatBubbleFinish = completed && !!design.chat && (ty?.chatMode ?? "bubble") === "bubble";
  if (completed && !chatBubbleFinish) {
    return (
      <ThankYouView
        config={ty}
        message={finishMessage}
        accent={accent}
        dark={design.mode === "dark"}
        brandingHeader={brandingHeader}
        redirectUrl={safeRedirectUrl(data?.redirect_url)}
        resolveTokens={resolveTokens}
      />
    );
  }

  // Gated survey (pin/list): show the access gate until the token is obtained.
  if (data && data.gated === true && !accessToken) {
    return (
      <AccessGate
        slug={slug}
        accessMode={data.access_mode === "list" ? "list" : "pin"}
        design={design}
        accent={accent}
        title={data.title}
        brandingHeader={brandingHeader}
        apiBase={apiBase}
        onGranted={(token, survey) => {
          setAccessToken(token);
          // The unlocked survey carries the full json_schema; rebuild from it.
          setData((prev) => ({ ...(prev as PublicSurvey), ...survey, gated: false }));
        }}
      />
    );
  }

  // List-mode post-submit: thank-you plus the "check my result" lookup.
  if (postSubmit) {
    return (
      <PostSubmitScreen
        design={design}
        accent={accent}
        title={data?.title}
        brandingHeader={brandingHeader}
        pending={postSubmit.pending}
        slug={slug}
        prefill={{ email: magic.email, code: magic.code }}
        apiBase={apiBase}
        onGraded={(result, creds) => {
          setResults(result as GradedResult);
          setCertCreds(creds);
        }}
      />
    );
  }

  // Match the page wrapper to the survey's own background so no light strip
  // shows below/around the survey (especially in dark mode or with a bg color).
  const pageBg =
    design.backgroundColor || (design.mode === "dark" ? "#181c24" : "#f6f6f7");

  // Paint the background (image + color + opacity) full-screen on the wrapper,
  // fixed, so it covers the whole viewport — no band below the questions.
  const bgImg = design.backgroundImage ? resolveAssetUrl(design.backgroundImage) : null;
  const bgDim = 1 - (design.backgroundOpacity ?? 1);
  const wrapperStyle: React.CSSProperties = bgImg
    ? {
        backgroundColor: pageBg,
        backgroundImage: `linear-gradient(${hexToRgba(pageBg, bgDim)}, ${hexToRgba(pageBg, bgDim)}), url("${bgImg}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
        backgroundRepeat: "no-repeat",
      }
    : { backgroundColor: pageBg };

  return (
    <div
      className={`min-h-screen enc-scope${design.glass ? " enc-glass" : ""}${design.alignment === "center" ? " enc-center" : ""}${design.questionSeparator ? " enc-cards" : ""}`}
      style={wrapperStyle}
    >
      {/* Glass (frosted) blur behind the boxes + screen transitions + alignment
          + per-question style overrides (transparencia/alineación individual). */}
      <style>
        {ENC_SURFACE_CSS +
          ENC_ALIGN_CSS +
          cardsCss(design.mode === "dark") +
          buttonOverrideCss(design.buttonColor, design.buttonShadow) +
          perQuestionStyleCss(data?.json_schema, design) +
          fontsCss(design) +
          alignOverrideCss(design) +
          ENC_EMBED_CSS}
      </style>
      <FullscreenButton />
      {model && (data?.languages?.length ?? 0) > 1 && (
        <LanguagePicker model={model} languages={data!.languages!} />
      )}
      {brandingHeader}
      {submitting && (
        <StateScreen
          config={design.grading}
          accent={accent}
          dark={design.mode === "dark"}
          spinner
          message={resolveTokens(data?.grading_message || "") || t("public.grading.default")}
        />
      )}
      {design.coverImage && !design.chat && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolveAssetUrl(design.coverImage)}
          alt=""
          // Altura de portada que escala con el viewport: más baja en el
          // celular para no comerse media pantalla antes de la primera pregunta.
          className="w-full object-cover max-h-40 sm:max-h-56 md:max-h-[280px]"
        />
      )}
      {design.chat ? (
        <ChatSurveyView
          model={model}
          accent={accent}
          dark={design.mode === "dark"}
          options={design.chatOptions}
          finished={chatBubbleFinish}
          finishMessage={finishMessage}
          finishCtas={ty?.ctas}
        />
      ) : (
        <Survey model={model} />
      )}
      {design.audio?.url && <AudioPlayer audio={design.audio} accent={accent} />}
    </div>
  );
}

// A hex (#rrggbb) → rgba() with the given alpha. Non-hex passes through opaque.
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

/* --- Encuesta embebida en un iframe (LMS vía LTI) ---
   La clase `enc-embedded` la pone FullscreenButton en <html>: no existe un
   selector CSS para "estoy dentro de un iframe".

   Dentro de Moodle la encuesta comparte pantalla con la cabecera del sitio, el
   índice del curso y la navegación de la actividad, así que el alto útil es la
   mitad que abriéndola por su link. Los paddings de SurveyJS (54px arriba,
   72px abajo) están pensados para una ventana completa y ahí se comen la
   pantalla. Se recortan solo en este caso; abierta por su propio link la
   encuesta no cambia en nada.

   El ancho no se toca a propósito: la columna de lectura de ~810px es una
   decisión tipográfica, no un descuido. Estirarla a todo el ancho de un iframe
   panorámico haría las líneas más largas y más difíciles de leer. */
const ENC_EMBED_CSS = `
.enc-embedded .enc-scope .sd-body,
.enc-embedded .enc-scope .sd-body.sd-body--static,
.enc-embedded .enc-scope .sd-body.sd-body--responsive {
  padding-top: 24px;
  padding-bottom: 32px;
}
/* En pantalla completa recuperamos el aire: ahí sí hay ventana entera. */
.enc-embedded:fullscreen .enc-scope .sd-body,
.enc-embedded:fullscreen .enc-scope .sd-body.sd-body--static,
.enc-embedded:fullscreen .enc-scope .sd-body.sd-body--responsive {
  padding-top: 54px;
  padding-bottom: 72px;
}
/* El fondo del wrapper solo cubre su propia caja; en pantalla completa el
   navegador pinta el resto de negro si no se le dice otra cosa. */
.enc-embedded:fullscreen .enc-scope {
  min-height: 100vh;
}
`;

// Frosted-glass blur behind the question/input boxes + page-transition keyframes.
const ENC_SURFACE_CSS = `
.enc-glass .sd-input,
.enc-glass .sd-comment,
.enc-glass .sd-selectbase,
.enc-glass .sd-dropdown,
.enc-glass .sd-boolean,
.enc-glass .sd-rating__item,
.enc-glass .sd-question__content {
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
@keyframes enc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes enc-slide { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
@keyframes enc-slide-left { from { opacity: 0; transform: translateX(48px); } to { opacity: 1; transform: translateX(0); } }
@keyframes enc-zoom { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
@keyframes enc-flip { from { opacity: 0; transform: perspective(1200px) rotateX(-10deg) translateY(18px); } to { opacity: 1; transform: perspective(1200px) rotateX(0) translateY(0); } }
@keyframes enc-blur { from { opacity: 0; filter: blur(10px); } to { opacity: 1; filter: blur(0); } }

/* --- Responsive móvil (≤640px): contener SurveyJS en pantallas chicas ---
   Reglas SÓLO aditivas: compactan los paddings generosos de SurveyJS, evitan
   el scroll horizontal en 360-400px y aseguran alto táctil en la navegación. */
@media (max-width: 640px) {
  .enc-scope { overflow-x: hidden; }
  .enc-scope .sd-root-modern,
  .enc-scope .sd-container-modern { min-width: 0; max-width: 100vw; }
  .enc-scope .sd-body,
  .enc-scope .sd-body.sd-body--static,
  .enc-scope .sd-body.sd-body--responsive {
    padding-left: 12px;
    padding-right: 12px;
    max-width: 100%;
    box-sizing: border-box;
  }
  .enc-scope .sd-page {
    padding-left: 0;
    padding-right: 0;
  }
  /* Medios dentro de las preguntas nunca deben desbordar el ancho. */
  .enc-scope .sd-question__content img,
  .enc-scope .sd-question__content video,
  .enc-scope .sd-html img {
    max-width: 100%;
    height: auto;
  }
  /* Botones de navegación (Anterior / Siguiente / Completar) táctiles. */
  .enc-scope .sd-navigation__complete-btn,
  .enc-scope .sd-navigation__next-btn,
  .enc-scope .sd-navigation__prev-btn,
  .enc-scope .sd-navigation__start-btn {
    min-height: 44px;
  }
  /* Inputs a 16px: evita el zoom automático de iOS al enfocar en el celular. */
  .enc-scope input, .enc-scope textarea, .enc-scope select, .enc-scope .sd-input {
    font-size: 16px;
  }
}
`;

// Floating background-music control. Browsers block autoplay with sound, so we
// respect that: if autoplay is on we start muted and let the respondent unmute,
// otherwise we show a play button. Loop/volume come from the survey design.
function AudioPlayer({ audio, accent }: { audio: AudioSettings; accent: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLAudioElement | null>(null);
  // El estado se sincroniza con los EVENTOS reales del <audio> (play/pause/
  // ended/volumechange), así los botones nunca quedan desfasados del sonido.
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(!!audio.autoplay);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Volumen 0 configurado por error dejaría el control "muerto": mínimo audible.
    el.volume = Math.max(0.05, Math.min(1, audio.volume ?? 0.6));
    el.loop = audio.loop ?? true;
    const sync = () => {
      setPlaying(!el.paused);
      setMuted(el.muted);
    };
    el.addEventListener("play", sync);
    el.addEventListener("pause", sync);
    el.addEventListener("ended", sync);
    el.addEventListener("volumechange", sync);
    const onError = () => setFailed(true);
    el.addEventListener("error", onError);
    if (audio.autoplay) {
      el.muted = true;
      el.play().catch(() => {
        /* autoplay bloqueado: el usuario tocará el botón */
      });
    }
    return () => {
      el.removeEventListener("play", sync);
      el.removeEventListener("pause", sync);
      el.removeEventListener("ended", sync);
      el.removeEventListener("volumechange", sync);
      el.removeEventListener("error", onError);
    };
  }, [audio.autoplay, audio.loop, audio.volume]);

  async function toggle() {
    const el = ref.current;
    if (!el) return;
    try {
      if (el.paused) {
        // Reproducir: siempre con sonido (es un gesto del usuario).
        el.muted = false;
        await el.play();
      } else if (el.muted) {
        // Sonando en silencio (autoplay): activar el sonido.
        el.muted = false;
      } else {
        el.pause();
      }
    } catch {
      toast.error(t("public.audio.playError"));
    }
  }

  function toggleMute() {
    const el = ref.current;
    if (!el) return;
    el.muted = !el.muted;
  }

  if (failed) return null; // archivo inaccesible: no mostramos un control muerto

  const active = playing && !muted;
  return (
    // En móvil el control sube por encima de la fila de navegación de SurveyJS
    // (Anterior/Completar) para no taparla; en pantallas grandes queda abajo.
    <div className="fixed bottom-20 right-3 sm:bottom-4 sm:right-4 z-50 flex items-center gap-2 rounded-full bg-white/95 shadow-lg ring-1 ring-black/5 px-2.5 py-1.5 sm:px-3 sm:py-2 backdrop-blur">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={ref} src={resolveAssetUrl(audio.url)} preload="auto" />
      <button
        type="button"
        onClick={toggle}
        className={`grid h-10 w-10 sm:h-8 sm:w-8 place-items-center rounded-full text-white${active ? " animate-pulse" : ""}`}
        style={{ backgroundColor: accent, opacity: active ? 1 : 0.85 }}
        aria-label={active ? t("public.audio.pause") : t("public.audio.play")}
        title={active ? t("public.audio.pause") : t("public.audio.play")}
      >
        <Music className="h-4 w-4" />
      </button>
      {playing && (
        <button
          type="button"
          onClick={toggleMute}
          className="grid h-10 w-10 sm:h-8 sm:w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
          aria-label={muted ? t("public.audio.unmute") : t("public.audio.mute")}
          title={muted ? t("public.audio.unmute") : t("public.audio.mute")}
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}

function ResultsScreen({
  results,
  accent,
  slug,
  apiBase,
  certCreds,
}: {
  results: GradedResult;
  accent: string;
  slug: string;
  apiBase: () => string;
  certCreds: { email: string; code: string } | null;
}) {
  const { t } = useI18n();
  const pct = Math.round(results.percent ?? 0);
  const showScore = results.total !== undefined;
  const passed = results.passed;
  const [showCert, setShowCert] = useState(false);
  // El certificado se ofrece sólo si aprobó, no hay revisión pendiente y
  // tenemos sus credenciales (email + código) para pedirlo.
  const canCertify =
    passed === true && !results.needs_review && !!certCreds;

  return (
    <div className="min-h-screen bg-neutral-50 flex items-start justify-center p-4 sm:p-6">
      <div className="w-full max-w-xl mt-4 sm:mt-8">
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-black/5 p-6 sm:p-8 text-center">
          <h1 className="text-lg font-semibold text-neutral-800">
            {results.needs_review
              ? t("public.received")
              : t("public.results.title")}
          </h1>

          {showScore ? (
            <>
              <div
                className="mx-auto mt-6 grid place-items-center rounded-full"
                style={{
                  width: 128,
                  height: 128,
                  background: `conic-gradient(${accent} ${pct * 3.6}deg, #eee 0deg)`,
                }}
              >
                <div className="grid place-items-center rounded-full bg-white" style={{ width: 104, height: 104 }}>
                  <span className="text-2xl font-bold text-neutral-800">{pct}%</span>
                </div>
              </div>
              <p className="mt-3 text-sm text-neutral-500">
                {t("public.results.points", {
                  total: results.total ?? 0,
                  max: results.max ?? 0,
                })}
              </p>
              {passed !== null && passed !== undefined && (
                <span
                  className={`inline-block mt-2 rounded-full px-3 py-1 text-xs font-semibold ${
                    passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}
                >
                  {passed ? t("public.results.passed") : t("public.results.failed")}
                </span>
              )}
            </>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              {t("public.results.sentNoScore")}
            </p>
          )}

          {results.needs_review && (
            <p className="mt-4 text-xs text-amber-600">
              {t("public.results.needsReview")}
            </p>
          )}

          {canCertify && (
            <button
              type="button"
              onClick={() => setShowCert(true)}
              // Ancho completo en móvil y alto táctil (≥44px) para el pulgar.
              className="mt-6 inline-flex w-full sm:w-auto min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition"
              style={{ backgroundColor: accent }}
            >
              <Award className="h-4 w-4" /> {t("public.results.viewCert")}
            </button>
          )}
        </div>

        {results.questions?.length > 0 && (
          <div className="mt-4 space-y-2">
            {results.questions.map((q, i) => (
              <div
                key={i}
                className="bg-white rounded-xl ring-1 ring-black/5 p-4 flex items-start gap-3"
              >
                <VerdictDot verdict={q.verdict} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-neutral-800">{q.title}</div>
                  {/* Su propia respuesta: es el dato que despeja la duda, y
                      antes no se mostraba en ningún lado. */}
                  {q.answer ? (
                    <div className="mt-1.5 text-xs text-neutral-600">
                      <span className="text-neutral-400">{t("public.results.yourAnswer")}</span>{" "}
                      <span className="font-medium">{q.answer}</span>
                    </div>
                  ) : (
                    <div className="mt-1.5 text-xs italic text-neutral-400">
                      {t("public.results.noAnswer")}
                    </div>
                  )}
                  {q.correct_answer && (
                    <div className="mt-1 text-xs text-green-700">
                      <span className="text-green-600/70">{t("public.results.correctAnswer")}</span>{" "}
                      <span className="font-medium">{q.correct_answer}</span>
                    </div>
                  )}
                  {(q.explanation || q.feedback) && (
                    <div className="mt-1.5 rounded-lg bg-neutral-50 px-2.5 py-1.5 text-xs leading-relaxed text-neutral-600">
                      {q.explanation || q.feedback}
                    </div>
                  )}
                  {results.can_appeal && certCreds && q.name && (
                    <Appeal
                      slug={slug}
                      apiBase={apiBase}
                      creds={certCreds}
                      question={q.name}
                      accent={accent}
                      previo={results.appeals?.filter((a) => a.question === q.name).at(-1)}
                    />
                  )}
                </div>
                <div className="text-xs font-semibold text-neutral-400 shrink-0">
                  {q.awarded}/{q.points}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCert && certCreds && (
        <Certificate
          slug={slug}
          email={certCreds.email}
          code={certCreds.code}
          accent={accent}
          apiBase={apiBase}
          onClose={() => setShowCert(false)}
        />
      )}
    </div>
  );
}

// Pantalla de gracias personalizada (encuesta común, sin redirección).
// Respeta el tema claro/oscuro del diseño de la encuesta.
function ThankYouScreen({
  message,
  accent,
  design,
  brandingHeader,
}: {
  message: string;
  accent: string;
  design: ReturnType<typeof themeToDesign>;
  brandingHeader: React.ReactNode;
}) {
  const dark = design.mode === "dark";
  const pageBg = design.backgroundColor || (dark ? "#181c24" : "#f6f6f7");
  const cardBg = dark ? "#232833" : "#ffffff";
  const textColor = dark ? "#e5e7eb" : "#1f2937";

  return (
    <div className="min-h-screen" style={{ backgroundColor: pageBg }}>
      {brandingHeader}
      <div className="flex items-start justify-center p-4 sm:p-6">
        <div className="w-full max-w-xl mt-6 sm:mt-10">
          <div
            className="rounded-2xl p-6 sm:p-8 text-center shadow-sm ring-1 ring-black/5"
            style={{ backgroundColor: cardBg }}
          >
            <div
              className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-full"
              style={{ backgroundColor: `${accent}1a`, color: accent }}
            >
              <Check className="h-6 w-6" />
            </div>
            <p
              className="whitespace-pre-line text-base leading-relaxed"
              style={{ color: textColor }}
            >
              {message}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function VerdictDot({ verdict }: { verdict: string }) {
  const color =
    verdict === "correct" ? "#22c55e" : verdict === "partial" ? "#f59e0b" : "#ef4444";
  return (
    <span
      className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center px-6 text-neutral-800">
      {children}
    </div>
  );
}

// Pantalla de estado a pantalla completa, personalizable desde el panel de diseño
// (analizando / cerrada): fondo por color o imagen (con velo para legibilidad),
// emoji, spinner, título, mensaje. Con `spinner` es un overlay sobre la encuesta.
function StateScreen({
  config,
  accent,
  dark,
  spinner,
  title,
  message,
  reason,
  footer,
}: {
  config?: StateScreenConfig;
  accent: string;
  dark: boolean;
  spinner?: boolean;
  title?: string;
  message: string;
  reason?: string;
  footer?: string;
}) {
  const c = config || {};
  const hasBgImage = !!c.bgImage;
  const showSpinner = !!spinner && (c.spinner ?? true);
  const textColor =
    c.textColor || (hasBgImage ? "#ffffff" : dark ? "#e5e7eb" : "#1f2937");
  const style: React.CSSProperties = hasBgImage
    ? {
        backgroundImage: `linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.55)), url(${resolveAssetUrl(
          c.bgImage!
        )})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : { backgroundColor: c.bgColor || (dark ? "#09090b" : "#ffffff") };
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 px-6 text-center"
      style={style}
    >
      {c.emoji && (
        <div className="text-5xl leading-none" aria-hidden="true">
          {c.emoji}
        </div>
      )}
      {showSpinner && (
        <span
          className="inline-block h-9 w-9 animate-spin rounded-full border-[3px] border-current border-t-transparent"
          style={{ color: accent }}
          aria-hidden="true"
        />
      )}
      {title && (
        <h1 className="text-2xl font-semibold" style={{ color: textColor }}>
          {title}
        </h1>
      )}
      <p
        className="max-w-md text-base font-medium leading-relaxed"
        style={{ color: textColor }}
      >
        {message}
      </p>
      {reason && (
        <p className="text-sm" style={{ color: textColor, opacity: 0.75 }}>
          {reason}
        </p>
      )}
      {footer && (
        <p className="mt-1 text-sm" style={{ color: textColor, opacity: 0.55 }}>
          {footer}
        </p>
      )}
    </div>
  );
}

/** Pedir que se revise la corrección de una pregunta (y ver la respuesta). */
function Appeal({
  slug,
  apiBase,
  creds,
  question,
  accent,
  previo,
}: {
  slug: string;
  apiBase: () => string;
  creds: { email: string; code: string };
  question: string;
  accent: string;
  previo?: { status: string; reply: string | null };
}) {
  const { t } = useI18n();
  const [abierto, setAbierto] = useState(false);
  const [msg, setMsg] = useState("");
  const [estado, setEstado] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (previo && estado !== "sent") {
    return (
      <div className="mt-1.5 rounded-lg bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-600">
        <span className="font-medium">{t(`public.appeal.status.${previo.status}`)}</span>
        {previo.reply && (
          <>
            {" · "}
            {t("public.appeal.reply")} {previo.reply}
          </>
        )}
      </div>
    );
  }
  if (estado === "sent") return <p className="mt-1.5 text-xs text-green-700">{t("public.appeal.sent")}</p>;
  if (!abierto)
    return (
      <button onClick={() => setAbierto(true)} className="mt-1.5 text-xs underline" style={{ color: accent }}>
        {t("public.appeal.ask")}
      </button>
    );

  async function enviar() {
    setEstado("sending");
    setError(null);
    try {
      const r = await fetch(`${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/appeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...creds, question, message: msg.trim() }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setError(typeof j?.detail === "string" ? j.detail : t("public.access.error.unexpected"));
        setEstado("error");
        return;
      }
      setEstado("sent");
    } catch {
      setError(t("public.access.error.connect"));
      setEstado("error");
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <textarea
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder={t("public.appeal.placeholder")}
        className="w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs outline-none"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        onClick={enviar}
        disabled={msg.trim().length < 5 || estado === "sending"}
        className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
        style={{ backgroundColor: accent }}
      >
        {t("public.appeal.send")}
      </button>
    </div>
  );
}

/** Selector de idioma para quien responde (sólo si la encuesta está traducida). */
function LanguagePicker({ model, languages }: { model: Model; languages: string[] }) {
  const [actual, setActual] = useState(model.locale || languages[0]);
  const nombre = (c: string) => {
    try {
      const n = new Intl.DisplayNames([c], { type: "language" }).of(c);
      return n ? n.charAt(0).toUpperCase() + n.slice(1) : c;
    } catch {
      return c;
    }
  };
  return (
    <div className="flex justify-end px-4 pt-3">
      <select
        aria-label="Idioma / Language"
        value={actual}
        onChange={(e) => {
          setActual(e.target.value);
          aplicarIdioma(model, e.target.value);
        }}
        className="rounded-md border border-neutral-200 bg-white/80 px-2 py-1 text-sm text-neutral-700 backdrop-blur"
      >
        {languages.map((l) => (
          <option key={l} value={l}>{nombre(l)}</option>
        ))}
      </select>
    </div>
  );
}
