"use client";

/** Pantallas de la encuesta pública además del formulario: resultado corregido, reclamo, estados, audio e idioma. */

import React, { useEffect, useRef, useState } from "react";
import { Model } from "survey-core";
import { toast } from "sonner";
import { Award, Music, Volume2, VolumeX } from "lucide-react";
import { type AudioSettings, type StateScreenConfig } from "../../../(survey-builder)/builder/model";
import { resolveAssetUrl } from "../../../(survey-builder)/builder/design";

import { useI18n } from "@/lib/i18n";

import { Certificate } from "./Certificate";

import { aplicarIdioma } from "./runtime";

export interface GradedResult {
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

// Floating background-music control. Browsers block autoplay with sound, so we
// respect that: if autoplay is on we start muted and let the respondent unmute,
// otherwise we show a play button. Loop/volume come from the survey design.
export function AudioPlayer({ audio, accent }: { audio: AudioSettings; accent: string }) {
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

export function ResultsScreen({
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

export function VerdictDot({ verdict }: { verdict: string }) {
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

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center px-6 text-neutral-800">
      {children}
    </div>
  );
}

// Pantalla de estado a pantalla completa, personalizable desde el panel de diseño
// (analizando / cerrada): fondo por color o imagen (con velo para legibilidad),
// emoji, spinner, título, mensaje. Con `spinner` es un overlay sobre la encuesta.
export function StateScreen({
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
export function Appeal({
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
export function LanguagePicker({ model, languages }: { model: Model; languages: string[] }) {
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
