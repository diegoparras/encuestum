"use client";

/**
 * Revisión metodológica de la redacción con IA: preguntas sesgadas, dobles,
 * con opciones superpuestas, escalas desbalanceadas, ambigüedad, negaciones.
 * Revisa lo que está en el editor (aunque no se haya guardado) y deja aplicar
 * la redacción sugerida pregunta por pregunta.
 */

import React, { useEffect, useState } from "react";
import { Loader2, SpellCheck2, X, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { surveyApi, type UsageInfo, type WordingReview as Review } from "../surveyApi";
import type { BuilderQuestion } from "./model";

export function WordingReviewDialog({
  surveyId,
  questions,
  accent,
  onApply,
  onClose,
  onUsage,
}: {
  surveyId: string;
  questions: BuilderQuestion[];
  accent: string;
  onApply: (questionId: string, title: string) => void;
  onClose: () => void;
  onUsage?: (u: UsageInfo) => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aplicadas, setAplicadas] = useState<Set<string>>(new Set());

  const revisables = questions.filter((q) => q.type !== "section" && q.title.trim());
  const porNombre = new Map(revisables.map((q) => [q.name, q]));

  useEffect(() => {
    let cancel = false;
    surveyApi
      .reviewWording(
        surveyId,
        revisables.map((q) => ({
          name: q.name,
          title: q.title,
          type: q.type,
          choices: (q.choices ?? []).map((c) => c.text),
          ...(q.type === "rating" ? { rateMin: q.rateMin, rateMax: q.rateMax } : {}),
        }))
      )
      .then((r) => {
        if (cancel) return;
        setRows(r.questions.filter((x) => x.issues.length));
        if (r.usage) onUsage?.(r.usage);
      })
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancel = true;
    };
    // Se revisa una vez, con lo que había al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl dark:bg-neutral-900">
        <header className="flex items-center gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <SpellCheck2 className="h-5 w-5" style={{ color: accent }} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold dark:text-neutral-100">{t("builder.wording.title")}</h2>
            <p className="text-xs text-neutral-400">{t("builder.wording.subtitle")}</p>
          </div>
          <button onClick={onClose} aria-label={t("builder.wording.close")} className="text-neutral-400 hover:text-neutral-700">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : rows === null ? (
            <p className="flex items-center gap-2 text-sm text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
            </p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-500">{t("builder.wording.ok")}</p>
          ) : (
            rows.map((r) => {
              const q = porNombre.get(r.name);
              if (!q) return null;
              const hecha = aplicadas.has(r.name);
              return (
                <div key={r.name} className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{q.title}</p>
                  <ul className="mt-2 space-y-1.5">
                    {r.issues.map((i, k) => (
                      <li key={k} className="text-xs text-neutral-600 dark:text-neutral-300">
                        <span className="mr-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                          {t(`builder.wording.kind.${i.kind}`)}
                        </span>
                        {i.detail} <span className="text-neutral-400">→ {i.suggestion}</span>
                      </li>
                    ))}
                  </ul>
                  {r.rewrite && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg bg-neutral-50 p-2 dark:bg-neutral-950">
                      <p className="min-w-0 flex-1 text-sm text-neutral-800 dark:text-neutral-200">{r.rewrite}</p>
                      <button
                        onClick={() => {
                          onApply(q.id, r.rewrite);
                          setAplicadas(new Set(aplicadas).add(r.name));
                        }}
                        disabled={hecha}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                        style={{ backgroundColor: accent }}
                      >
                        {hecha ? <><Check className="h-3 w-3" /> {t("builder.wording.applied")}</> : t("builder.wording.apply")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
