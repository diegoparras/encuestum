"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "survey-core/i18n/spanish";
import { toast } from "sonner";
import { Award, Check, Music, Volume2, VolumeX } from "lucide-react";
import {
  perQuestionStyleCss,
  themeToDesign,
  type AudioSettings,
} from "../../../(survey-builder)/builder/model";
import {
  absolutizeAssets,
  buttonOverrideCss,
  ENC_ALIGN_CSS,
  ENC_CARDS_CSS,
  loadFont,
  resolveAssetUrl,
} from "../../../(survey-builder)/builder/design";
import { orgBranding } from "@/utils/auth";
import { uploadRespondentFile } from "./uploadFile";
import { registerVideoResponseQuestion } from "./VideoResponseQuestion";
import {
  AccessGate,
  PostSubmitScreen,
  useMagicLinkParams,
} from "./AccessGate";
import { Certificate } from "./Certificate";

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
  redirect_url?: string | null;
}

// Sólo permitimos redirigir a URLs http(s) absolutas; cualquier otra cosa se
// ignora para evitar esquemas peligrosos (javascript:, data:, etc.).
function safeRedirectUrl(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

interface GradedResult {
  total?: number;
  max?: number;
  percent?: number;
  passed?: boolean | null;
  needs_review?: boolean;
  questions: {
    title: string;
    verdict: string;
    awarded: number;
    points: number;
    feedback: string;
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

  // Funnel: una vista por visitante al cargar la encuesta (disponible o no gated).
  useEffect(() => {
    if (status === "ready" && data && data.available !== false) {
      trackVisit(slug, "view");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, slug]);

  const model = useMemo(() => {
    if (!data) return null;
    const evalMeta = data.evaluation || {};
    const isExam = !!evalMeta.enabled;
    const survey = new Model(absolutizeAssets(data.json_schema || {}));
    survey.locale = data.language || "es";
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
        toast.error("No se pudo subir el archivo. Probá de nuevo.");
      }
    });

    // Save & resume: keep partial answers on this device and restore them, so a
    // respondent can close the tab and come back. Cleared on submit.
    const resumeKey = `enc_resume_${slug}`;
    try {
      const saved =
        typeof window !== "undefined" ? window.localStorage.getItem(resumeKey) : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.data) survey.data = parsed.data;
        if (typeof parsed?.page === "number") survey.currentPageNo = parsed.page;
      }
    } catch {
      /* ignore corrupt resume state */
    }
    const persist = () => {
      try {
        window.localStorage.setItem(
          resumeKey,
          JSON.stringify({ data: survey.data, page: survey.currentPageNo })
        );
      } catch {
        /* storage may be unavailable */
      }
    };
    survey.onValueChanged.add(persist);
    survey.onCurrentPageChanged.add(persist);
    survey.onComplete.add(() => {
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
      if (integ.timeLimitSec) survey.maxTimeToFinish = integ.timeLimitSec;
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
              body: JSON.stringify({ name: options.name, answer: options.value }),
            }
          );
          if (!res.ok) return; // not gradable → ignore
          const g = await res.json();
          const ok = g.verdict === "correct";
          const partial = g.verdict === "partial";
          toast[ok ? "success" : partial ? "message" : "error"](
            `${g.awarded}/${g.points} · ${g.feedback || (ok ? "¡Correcto!" : "Revisá tu respuesta")}`
          );
        } catch {
          /* ignore live-grading hiccups */
        }
      });
    }

    survey.onComplete.add(async (sender) => {
      setSubmitting(true);
      try {
        const res = await fetch(
          `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/submit`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              answers: sender.data,
              completed: true,
              // Gated surveys require the access token obtained at the gate.
              ...(accessToken ? { access_token: accessToken } : {}),
              meta: {
                locale: sender.locale || data.language || null,
                referrer: typeof document !== "undefined" ? document.referrer : null,
                visitor_id: getVisitorId(),
              },
            }),
          }
        );
        const body = await res.json().catch(() => null);
        // Redirección al terminar: si hay una URL válida, tiene prioridad sobre
        // cualquier pantalla de gracias. Mostramos "Redirigiendo…" y navegamos.
        const redirectTo = safeRedirectUrl(data.redirect_url);
        if (redirectTo) {
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
        /* keep the thank-you page even if the network hiccups */
      } finally {
        setSubmitting(false);
      }
    });

    return survey;
  }, [data, slug, accessToken, magic]);

  const design = useMemo(() => themeToDesign(data?.theme), [data]);
  useEffect(() => {
    loadFont(design.fontFamily);
  }, [design.fontFamily]);

  if (status === "loading") return <Centered>Cargando…</Centered>;
  if (status === "notfound")
    return (
      <Centered>
        <h1 className="text-xl font-semibold">Encuesta no disponible</h1>
        <p className="text-sm opacity-70 mt-2">
          Puede que no exista o que todavía no esté publicada.
        </p>
      </Centered>
    );
  if (status === "error" || !model)
    return (
      <Centered>
        <h1 className="text-xl font-semibold">Algo salió mal</h1>
        <p className="text-sm opacity-70 mt-2">Volvé a intentar en un momento.</p>
      </Centered>
    );

  const accent = data?.theme?.cssVariables?.["--sjs-primary-backcolor"] || "#e25a4e";

  if (data && data.available === false) {
    return (
      <Centered>
        {data.title && <h1 className="text-xl font-semibold">{data.title}</h1>}
        <p className="mt-3 text-base text-neutral-700">
          {data.closed_reason || "Esta encuesta está cerrada."}
        </p>
        <p className="mt-2 text-sm text-neutral-400">Gracias por tu interés.</p>
      </Centered>
    );
  }

  if (redirecting) {
    return (
      <Centered>
        <p className="text-sm opacity-70">Redirigiendo…</p>
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

  // Encuesta terminada (sin redirección): pantalla de gracias con el tema,
  // usando el mensaje personalizado o el texto por defecto.
  if (completed) {
    return (
      <ThankYouScreen
        message={data?.thankyou_message || "¡Gracias por responder! 🙌"}
        accent={accent}
        design={design}
        brandingHeader={brandingHeader}
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
          ENC_CARDS_CSS +
          buttonOverrideCss(design.buttonColor, design.buttonShadow) +
          perQuestionStyleCss(data?.json_schema, design)}
      </style>
      {brandingHeader}
      {submitting && (
        <div className="fixed top-0 inset-x-0 h-1 animate-pulse z-50" style={{ backgroundColor: accent }} />
      )}
      {design.coverImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolveAssetUrl(design.coverImage)}
          alt=""
          // Altura de portada que escala con el viewport: más baja en el
          // celular para no comerse media pantalla antes de la primera pregunta.
          className="w-full object-cover max-h-40 sm:max-h-56 md:max-h-[280px]"
        />
      )}
      <Survey model={model} />
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
}
`;

// Floating background-music control. Browsers block autoplay with sound, so we
// respect that: if autoplay is on we start muted and let the respondent unmute,
// otherwise we show a play button. Loop/volume come from the survey design.
function AudioPlayer({ audio, accent }: { audio: AudioSettings; accent: string }) {
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
      toast.error("No se pudo reproducir la música.");
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
        aria-label={active ? "Pausar música" : "Reproducir música"}
        title={active ? "Pausar música" : "Reproducir música"}
      >
        <Music className="h-4 w-4" />
      </button>
      {playing && (
        <button
          type="button"
          onClick={toggleMute}
          className="grid h-10 w-10 sm:h-8 sm:w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
          aria-label={muted ? "Activar sonido" : "Silenciar"}
          title={muted ? "Activar sonido" : "Silenciar"}
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
              ? "¡Recibimos tus respuestas!"
              : "Resultado de tu evaluación"}
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
                {results.total} / {results.max} puntos
              </p>
              {passed !== null && passed !== undefined && (
                <span
                  className={`inline-block mt-2 rounded-full px-3 py-1 text-xs font-semibold ${
                    passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}
                >
                  {passed ? "Aprobado" : "No aprobado"}
                </span>
              )}
            </>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              Tus respuestas fueron enviadas. Recibirás tu corrección pronto.
            </p>
          )}

          {results.needs_review && (
            <p className="mt-4 text-xs text-amber-600">
              Algunas respuestas serán revisadas por una persona.
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
              <Award className="h-4 w-4" /> Ver certificado
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
                  {q.feedback && (
                    <div className="text-xs text-neutral-500 mt-1">{q.feedback}</div>
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
