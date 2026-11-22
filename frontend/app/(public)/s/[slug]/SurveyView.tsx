"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Model } from "survey-core";
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
import { perQuestionStyleCss, themeToDesign } from "../../../(survey-builder)/builder/model";
import { absolutizeAssets, alignOverrideCss, buttonOverrideCss, cardsCss, ENC_ALIGN_CSS, fontsCss, loadFont, resolveAssetUrl } from "../../../(survey-builder)/builder/design";
import { orgBranding } from "@/utils/auth";
import { useI18n } from "@/lib/i18n";
import { uploadRespondentFile } from "./uploadFile";
import { registerVideoResponseQuestion } from "./VideoResponseQuestion";
import { AccessGate, PostSubmitScreen, useMagicLinkParams } from "./AccessGate";

import { ChatSurveyView } from "./ChatSurveyView";
import { ThankYouView } from "./ThankYouView";
import { getCaptchaSolution } from "./captcha";
import FullscreenButton from "./FullscreenButton";
import { safeRedirectUrl, apiBase, getVisitorId, ahora, INTEGRIDAD, reiniciarTiempos, marcarPagina, registrarRespuesta, tiemposRedondeados, camposOcultos, idiomaInicial, fijarIdiomaOriginal, encolar, nuevoIdDeEnvio, vaciarBandeja, registrarServiceWorker, trackVisit } from "./runtime";
import { AudioPlayer, ResultsScreen, Centered, StateScreen, LanguagePicker } from "./PublicScreens";
import type { GradedResult } from "./PublicScreens";

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

type Status = "loading" | "ready" | "notfound" | "error";

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

