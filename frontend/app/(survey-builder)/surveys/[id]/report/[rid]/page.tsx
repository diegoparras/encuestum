"use client";

import React, { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Printer, Loader2, GraduationCap } from "lucide-react";
import { surveyApi } from "../../../../surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError } from "@/components/LoadError";
import { derivePalette, themeToAccent } from "../../../../builder/model";
import { useI18n } from "@/lib/i18n";

export default function ReportPage() {
  const { t } = useI18n();
  const { id, rid } = useParams<{ id: string; rid: string }>();
  const { data, status, error, reload } = useAsyncData(async () => {
    const [s, r] = await Promise.all([
      surveyApi.get(id),
      surveyApi.response(id, rid),
    ]);
    return { survey: s, response: r };
  }, [id, rid]);
  const survey = data?.survey ?? null;
  const response = data?.response ?? null;

  const titles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of survey?.json_schema?.pages ?? []) {
      for (const el of p?.elements ?? []) {
        if (el?.name) map[el.name] = el.title || el.name;
      }
    }
    return map;
  }, [survey]);

  if (status === "error")
    return (
      <div className="max-w-3xl mx-auto px-6 py-10">
        <LoadError message={error} onRetry={reload} />
      </div>
    );
  if (!survey || !response)
    return (
      <div className="min-h-screen grid place-items-center text-neutral-400 text-sm dark:text-neutral-500">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> {t("results.loading")}
        </span>
      </div>
    );

  const pal = derivePalette(themeToAccent(survey.theme));
  const grade = response.grade;
  const pct = Math.round(grade?.percent ?? 0);
  const passed = grade?.passed;
  const questions = grade?.questions ?? [];

  return (
    <div className="min-h-screen bg-neutral-100 print:bg-white dark:bg-neutral-950">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report-sheet { box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; }
          @page { margin: 16mm; }
          .q-card { break-inside: avoid; }
        }
      `}</style>

      {/* Toolbar (screen only) */}
      <div className="no-print sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-neutral-200 dark:bg-neutral-900/80 dark:border-neutral-800">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href={`/surveys/${id}`}
            className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            <ArrowLeft className="w-4 h-4" /> {t("results.back")}
          </Link>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ backgroundColor: pal.accent, color: pal.fg }}
          >
            <Printer className="w-4 h-4" /> {t("results.downloadPdf")}
          </button>
        </div>
      </div>

      {/* Sheet */}
      <div className="max-w-3xl mx-auto px-6 py-8 print:p-0">
        <div className="report-sheet bg-white rounded-2xl shadow-sm ring-1 ring-black/5 overflow-hidden dark:bg-neutral-900 dark:ring-white/10">
          {/* Accent header */}
          <div className="h-2" style={{ backgroundColor: pal.accent }} />
          <div className="px-10 pt-8 pb-6">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide mb-2"
                  style={{ color: pal.accent }}
                >
                  <GraduationCap className="w-3.5 h-3.5" />{" "}
                  {t("results.reportTitle")}
                </div>
                <h1 className="text-2xl font-bold text-neutral-900 leading-tight dark:text-neutral-100">
                  {survey.title || t("results.surveyFallback")}
                </h1>
                <p className="mt-1 text-sm text-neutral-400 dark:text-neutral-500">
                  {new Date(response.submitted_at).toLocaleString()} ·{" "}
                  {t("results.participant")}{" "}
                  <span className="font-mono">{String(rid).slice(0, 8)}</span>
                </p>
              </div>

              {grade && <ScoreRing pct={pct} pal={pal} />}
            </div>

            {grade && (
              <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
                <Stat label={t("results.score")} value={`${grade.total} / ${grade.max}`} pal={pal} />
                <Stat label={t("results.percentage")} value={`${pct}%`} pal={pal} />
                {passed !== null && passed !== undefined && (
                  <span
                    className="rounded-full px-3 py-1 text-xs font-semibold"
                    style={{
                      backgroundColor: passed ? "#dcfce7" : "#fee2e2",
                      color: passed ? "#15803d" : "#b91c1c",
                    }}
                  >
                    {passed ? t("results.passed") : t("results.notPassed")}
                  </span>
                )}
                {response.needs_review && (
                  <span className="rounded-full px-3 py-1 text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-950/40">
                    {t("results.inReview")}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Questions */}
          <div className="px-10 pb-10 space-y-4">
            {questions.length === 0 && (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">
                {t("results.notGradedYet")}
              </p>
            )}
            {questions.map((q: any, i: number) => (
              <QuestionBlock
                key={q.name}
                index={i + 1}
                title={titles[q.name] || q.name}
                answer={response.answers?.[q.name]}
                q={q}
                pal={pal}
              />
            ))}
          </div>

          <div
            className="px-10 py-4 text-center text-[11px] text-neutral-400 border-t dark:text-neutral-500"
            style={{ borderColor: pal.soft }}
          >
            {t("results.footer", { brand: "Encuestum · Suite Escriba" })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreRing({
  pct,
  pal,
}: {
  pct: number;
  pal: ReturnType<typeof derivePalette>;
}) {
  return (
    <div
      className="grid place-items-center rounded-full shrink-0"
      style={{
        width: 96,
        height: 96,
        background: `conic-gradient(${pal.accent} ${pct * 3.6}deg, ${pal.light} 0deg)`,
      }}
    >
      <div className="grid place-items-center rounded-full bg-white dark:bg-neutral-900" style={{ width: 76, height: 76 }}>
        <span className="text-xl font-bold" style={{ color: pal.strong }}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  pal,
}: {
  label: string;
  value: string;
  pal: ReturnType<typeof derivePalette>;
}) {
  return (
    <div
      className="rounded-lg px-3 py-1.5"
      style={{ backgroundColor: pal.light }}
    >
      <span className="text-[10px] uppercase tracking-wide text-neutral-400 mr-2">
        {label}
      </span>
      <span className="font-semibold" style={{ color: pal.strong }}>
        {value}
      </span>
    </div>
  );
}

function QuestionBlock({
  index,
  title,
  answer,
  q,
  pal,
}: {
  index: number;
  title: string;
  answer: any;
  q: any;
  pal: ReturnType<typeof derivePalette>;
}) {
  const { t } = useI18n();
  const verdictMeta: Record<string, { label: string; bg: string; fg: string }> = {
    correct: { label: t("results.verdict.correct"), bg: "#dcfce7", fg: "#15803d" },
    partial: { label: t("results.verdict.partial"), bg: "#fef3c7", fg: "#b45309" },
    incorrect: { label: t("results.verdict.incorrect"), bg: "#fee2e2", fg: "#b91c1c" },
    ungraded: { label: t("results.verdict.ungraded"), bg: "#f1f5f9", fg: "#475569" },
  };
  const vm = verdictMeta[q.verdict] || verdictMeta.ungraded;
  const answerText =
    answer == null
      ? "—"
      : Array.isArray(answer)
      ? answer.join(", ")
      : String(answer);

  return (
    <div
      className="q-card rounded-xl border p-5"
      style={{ borderColor: pal.soft }}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          <span style={{ color: pal.accent }}>{index}.</span> {title}
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={{ backgroundColor: vm.bg, color: vm.fg }}
          >
            {vm.label}
          </span>
          <span className="text-sm font-bold" style={{ color: pal.strong }}>
            {q.awarded}/{q.points}
          </span>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wide text-neutral-400 mb-1 dark:text-neutral-500">
          {t("results.answer")}
        </div>
        <div className="text-sm text-neutral-700 whitespace-pre-wrap dark:text-neutral-300">{answerText}</div>
      </div>

      {q.feedback && (
        <div
          className="mt-3 rounded-lg p-3 text-sm text-neutral-700"
          style={{ backgroundColor: pal.light }}
        >
          <span className="font-semibold" style={{ color: pal.strong }}>
            {t("results.feedback")}{" "}
          </span>
          {q.feedback}
        </div>
      )}

      {Array.isArray(q.criteria) && q.criteria.length > 0 && (
        <div className="mt-3 space-y-1">
          {q.criteria.map((c: any, i: number) => (
            <div key={i} className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
              <span>{c.label}</span>
              <span className="font-medium text-neutral-700 dark:text-neutral-300">
                {c.awarded}/{c.max}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
