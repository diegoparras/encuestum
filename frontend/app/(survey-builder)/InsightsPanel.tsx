"use client";

import React, { useEffect, useState } from "react";
import { Sparkles, Loader2, Quote, RefreshCw, MessageSquareText } from "lucide-react";
import { surveyApi, Insights, InsightTheme } from "./surveyApi";
import { derivePalette } from "./builder/model";

interface Props {
  surveyId: string;
  accent: string;
}

const SENTIMENT: Record<string, { label: string; bg: string; fg: string }> = {
  positive: { label: "Positivo", bg: "#dcfce7", fg: "#15803d" },
  negative: { label: "Negativo", bg: "#fee2e2", fg: "#b91c1c" },
  neutral: { label: "Neutral", bg: "#f1f5f9", fg: "#475569" },
  mixed: { label: "Mixto", bg: "#fef3c7", fg: "#b45309" },
};

export function InsightsPanel({ surveyId, accent }: Props) {
  const pal = derivePalette(accent);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setInsights(await surveyApi.getInsights(surveyId));
      } catch {
        /* none yet */
      } finally {
        setLoading(false);
      }
    })();
  }, [surveyId]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      setInsights(await surveyApi.generateInsights(surveyId));
    } catch (e: any) {
      setError(
        e?.message?.includes("open-text")
          ? "Esta encuesta no tiene preguntas de texto abierto para resumir."
          : e?.message || "No se pudieron generar los insights."
      );
    } finally {
      setGenerating(false);
    }
  }

  const has = insights && insights.questions.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span
            className="grid place-items-center w-8 h-8 rounded-lg"
            style={{ backgroundColor: pal.light, color: pal.strong }}
          >
            <Sparkles className="w-4 h-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-neutral-800">Insights de IA</h3>
            <p className="text-[11px] text-neutral-400">
              Temas de las respuestas abiertas, citando texto real.
            </p>
          </div>
        </div>
        <button
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
          style={{ backgroundColor: pal.accent, color: pal.fg }}
        >
          {generating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : has ? (
            <RefreshCw className="w-4 h-4" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          {has ? "Regenerar" : "Generar insights"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-neutral-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        </div>
      ) : !has && !error ? (
        <div
          className="rounded-2xl border border-dashed p-10 text-center"
          style={{ borderColor: pal.soft }}
        >
          <MessageSquareText className="w-7 h-7 mx-auto mb-2" style={{ color: pal.accent }} />
          <p className="text-sm text-neutral-500">
            Generá un resumen inteligente de las respuestas abiertas.
          </p>
          <p className="text-xs text-neutral-400 mt-1">
            Cada tema cita frases textuales — sin inventar.
          </p>
        </div>
      ) : (
        has && (
          <div className="space-y-5">
            {insights!.generated_at && (
              <p className="text-[11px] text-neutral-400">
                Generado el {new Date(insights!.generated_at).toLocaleString()}
              </p>
            )}
            {insights!.questions.map((q) => (
              <QuestionCard key={q.name} title={q.title} n={q.n} summary={q.summary} pal={pal} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function QuestionCard({
  title,
  n,
  summary,
  pal,
}: {
  title: string;
  n: number;
  summary: { overall: string; themes: InsightTheme[]; key_takeaways: string[] };
  pal: ReturnType<typeof derivePalette>;
}) {
  return (
    <div
      className="rounded-2xl border bg-white overflow-hidden"
      style={{ borderColor: pal.soft }}
    >
      <div className="px-5 py-4" style={{ backgroundColor: pal.light }}>
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold" style={{ color: pal.strong }}>
            {title}
          </h4>
          <span className="text-[11px] font-medium text-neutral-500 shrink-0">
            {n} respuestas
          </span>
        </div>
        <p className="mt-2 text-sm text-neutral-600 leading-relaxed">{summary.overall}</p>
      </div>

      <div className="p-5 space-y-4">
        {summary.themes.map((t, i) => {
          const s = SENTIMENT[t.sentiment] || SENTIMENT.neutral;
          return (
            <div key={i}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-neutral-800">{t.label}</span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{ backgroundColor: s.bg, color: s.fg }}
                >
                  {s.label}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{ backgroundColor: pal.light, color: pal.strong }}
                >
                  {t.count}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-600">{t.summary}</p>
              {t.evidence?.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {t.evidence.map((e, j) => (
                    <div
                      key={j}
                      className="flex gap-2 text-xs text-neutral-500 pl-3 border-l-2"
                      style={{ borderColor: pal.ring }}
                    >
                      <Quote className="w-3 h-3 shrink-0 mt-0.5" style={{ color: pal.accent }} />
                      <span className="italic">{e}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {summary.key_takeaways?.length > 0 && (
          <div className="pt-3 border-t" style={{ borderColor: pal.soft }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 mb-2">
              Para llevar
            </div>
            <ul className="space-y-1">
              {summary.key_takeaways.map((k, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-neutral-600">
                  <span
                    className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: pal.accent }}
                  />
                  {k}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
