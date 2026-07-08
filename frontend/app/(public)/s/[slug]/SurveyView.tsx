"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import { toast } from "sonner";

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

export default function SurveyView({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<PublicSurvey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<GradedResult | null>(null);

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

  const model = useMemo(() => {
    if (!data) return null;
    const evalMeta = data.evaluation || {};
    const isExam = !!evalMeta.enabled;
    const survey = new Model(data.json_schema || {});

    if (
      data.json_schema?.questionsOnPageMode === undefined &&
      !data.json_schema?.pages?.some?.((p: any) => (p?.elements?.length ?? 0) > 1)
    ) {
      survey.questionsOnPageMode = "questionPerPage";
    }
    if (data.language) survey.locale = data.language;
    if (data.theme) {
      try {
        survey.applyTheme(data.theme as any);
      } catch {
        /* best-effort */
      }
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
              meta: {
                locale: sender.locale || data.language || null,
                referrer: typeof document !== "undefined" ? document.referrer : null,
              },
            }),
          }
        );
        const body = await res.json().catch(() => null);
        if (body?.status === "graded" && body.result) {
          setResults(body.result as GradedResult);
        }
      } catch {
        /* keep the thank-you page even if the network hiccups */
      } finally {
        setSubmitting(false);
      }
    });

    return survey;
  }, [data, slug]);

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

  if (results) {
    return <ResultsScreen results={results} accent={accent} />;
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      {submitting && (
        <div className="fixed top-0 inset-x-0 h-1 animate-pulse" style={{ backgroundColor: accent }} />
      )}
      <Survey model={model} />
    </div>
  );
}

function ResultsScreen({ results, accent }: { results: GradedResult; accent: string }) {
  const pct = Math.round(results.percent ?? 0);
  const showScore = results.total !== undefined;
  const passed = results.passed;

  return (
    <div className="min-h-screen bg-neutral-50 flex items-start justify-center p-6">
      <div className="w-full max-w-xl mt-8">
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-black/5 p-8 text-center">
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
