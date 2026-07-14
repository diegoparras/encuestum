"use client";

import React, { useState } from "react";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  Printer,
  RefreshCw,
  Quote,
  Lightbulb,
  FileText,
} from "lucide-react";
import { surveyApi, type ExecutiveReport } from "./surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { useI18n } from "@/lib/i18n";

/**
 * Informe ejecutivo por IA. Los números los calcula el servidor; la IA solo
 * redacta la narrativa y cita evidencia textual. Se genera on-demand y se
 * cachea; se puede regenerar y exportar a PDF (vía impresión del navegador).
 */
export function ReportPanel({
  surveyId,
  accent,
  surveyTitle,
}: {
  surveyId: string;
  accent: string;
  surveyTitle: string;
}) {
  const { t, lang } = useI18n();
  const { data, status, error, reload, setData } = useAsyncData(
    () => surveyApi.getReport(surveyId),
    [surveyId]
  );
  const [generating, setGenerating] = useState(false);

  async function generate() {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await surveyApi.generateReport(surveyId);
      setData({ report: res.report });
      toast.success(t("report.done"));
    } catch (e: any) {
      toast.error(e?.message || t("report.error"));
    } finally {
      setGenerating(false);
    }
  }

  function printPdf() {
    // Aísla el informe para la impresión (ver regla @media print en globals.css)
    document.body.classList.add("enc-printing");
    const cleanup = () => {
      document.body.classList.remove("enc-printing");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  if (status === "loading") return <LoadSpinner compact />;
  if (status === "error") return <LoadError message={error} onRetry={reload} compact />;

  const report = data?.report ?? null;

  if (!report) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 py-14 text-center dark:border-neutral-700">
        <div
          className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full"
          style={{ backgroundColor: `${accent}1a`, color: accent }}
        >
          <Sparkles className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {t("report.emptyTitle")}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-400 dark:text-neutral-500">
          {t("report.emptyBody")}
        </p>
        <button
          onClick={generate}
          disabled={generating}
          className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          style={{ backgroundColor: accent }}
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {generating ? t("report.generating") : t("report.generate")}
        </button>
      </div>
    );
  }

  const generatedAt = report.generated_at
    ? new Date(report.generated_at).toLocaleString(lang, {
        dateStyle: "long",
        timeStyle: "short",
      })
    : "";

  return (
    <div className="space-y-4">
      {/* Acciones (no se imprimen) */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t("report.regenerate")}
        </button>
        <button
          onClick={printPdf}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
          style={{ backgroundColor: accent }}
        >
          <Printer className="h-4 w-4" /> {t("results.downloadPdf")}
        </button>
      </div>

      {/* Región imprimible */}
      <article className="enc-print-region rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900 sm:p-8">
        <header className="mb-6 border-b border-neutral-100 pb-5 dark:border-neutral-800">
          <p
            className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: accent }}
          >
            <FileText className="h-3.5 w-3.5" /> {t("report.badge")}
          </p>
          <h1 className="text-xl font-bold leading-tight text-neutral-900 dark:text-neutral-50">
            {surveyTitle}
          </h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            {report.headline}
          </p>
          <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
            {t("report.meta", { n: report.response_count })}
            {generatedAt ? ` · ${generatedAt}` : ""}
          </p>
        </header>

        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {t("report.summary")}
          </h2>
          <p className="text-[15px] leading-relaxed text-neutral-700 dark:text-neutral-200">
            {report.summary}
          </p>
        </section>

        {report.findings.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {t("report.findings")}
            </h2>
            <div className="space-y-4">
              {report.findings.map((f, i) => (
                <div key={i} className="border-l-2 pl-4" style={{ borderColor: accent }}>
                  <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">
                    {f.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                    {f.detail}
                  </p>
                  {f.evidence.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {f.evidence.map((ev, j) => (
                        <li
                          key={j}
                          className="flex gap-1.5 text-sm italic text-neutral-500 dark:text-neutral-400"
                        >
                          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
                          <span>“{ev}”</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {report.recommendations.length > 0 && (
          <section>
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <Lightbulb className="h-4 w-4" /> {t("report.recommendations")}
            </h2>
            <ul className="space-y-2">
              {report.recommendations.map((r, i) => (
                <li
                  key={i}
                  className="flex gap-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-200"
                >
                  <span
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: accent }}
                  />
                  {r}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-8 hidden border-t border-neutral-200 pt-4 text-xs text-neutral-400 print:block">
          {t("report.footer")}
        </footer>
      </article>
    </div>
  );
}
