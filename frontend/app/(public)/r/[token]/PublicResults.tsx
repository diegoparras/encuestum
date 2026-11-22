"use client";

import React from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { getApiUrl } from "@/utils/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { ChoiceChart, RatingChart } from "../../../(survey-builder)/SummaryCharts";
import type { SummaryQuestion } from "../../../(survey-builder)/surveyApi";

interface PublicResultsData {
  title: string | null;
  theme: { accent?: string; primaryColor?: string } | null;
  total_responses: number;
  min_responses: number;
  enough: boolean;
  summary: { total_responses: number; questions: SummaryQuestion[] } | null;
}

async function cargar(token: string, signal?: AbortSignal): Promise<PublicResultsData> {
  const res = await fetch(getApiUrl(`/api/v1/survey/public/results/${encodeURIComponent(token)}`), {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(res.status === 404 ? "404" : `Error ${res.status}`);
  return res.json();
}

export default function PublicResults({ token }: { token: string }) {
  const { t } = useI18n();
  const { data, status, error } = useAsyncData((signal) => cargar(token, signal), [token]);
  const accent = data?.theme?.accent || data?.theme?.primaryColor || "#8faf0e";

  if (status === "loading")
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
      </div>
    );
  if (status === "error" || !data)
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center text-neutral-600 dark:text-neutral-300">
        {error === "404" ? t("publicResults.notFound") : error}
      </div>
    );

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <header className="mb-8">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          <BarChart3 className="h-4 w-4" /> {t("publicResults.kicker")}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{data.title}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("publicResults.total", { n: data.total_responses })}
        </p>
      </header>
      {!data.enough || !data.summary ? (
        <p className="rounded-xl border border-neutral-200 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          {t("publicResults.notEnough", { n: data.min_responses })}
        </p>
      ) : (
        <div className="space-y-4">
          {data.summary.questions.map((q) => (
            <section key={q.name} className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
              <h2 className="font-medium text-neutral-900 dark:text-neutral-100">{q.title || q.name}</h2>
              <p className="mb-4 mt-0.5 text-xs text-neutral-400">{t("summary.answeredCount", { n: q.answered })}</p>
              <Bloque q={q} accent={accent} />
            </section>
          ))}
        </div>
      )}
      <footer className="mt-10 text-center text-xs text-neutral-400">Encuestum</footer>
    </main>
  );
}

function Bloque({ q, accent }: { q: SummaryQuestion; accent: string }) {
  const { t } = useI18n();
  switch (q.kind) {
    case "choice":
      return <ChoiceChart options={q.options} accent={accent} />;
    case "rating":
      return <RatingChart min={q.min} max={q.max} average={q.average} distribution={q.distribution} accent={accent} />;
    case "numeric":
      return (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          {t("publicResults.numeric", { avg: q.average ?? "—", min: q.min ?? "—", max: q.max ?? "—" })}
        </p>
      );
    case "text":
      return (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm text-neutral-700 dark:text-neutral-300">
          {q.values.map((v, i) => (
            <li key={i} className="rounded-md bg-neutral-50 px-3 py-2 dark:bg-neutral-800">{v}</li>
          ))}
        </ul>
      );
    default:
      return <p className="text-xs text-neutral-400">{t("publicResults.unsupported")}</p>;
  }
}
