"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  RefreshCw,
  Download,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Check,
  FileText,
} from "lucide-react";
import {
  surveyApi,
  Analytics,
  ResponseItem,
  SURVEY_ACCENT,
} from "./surveyApi";

interface Props {
  surveyId: string;
  accent?: string;
}

export function GradesPanel({ surveyId, accent = SURVEY_ACCENT }: Props) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [responses, setResponses] = useState<ResponseItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);

  async function load() {
    try {
      const [an, resp] = await Promise.all([
        surveyApi.analytics(surveyId),
        surveyApi.responses(surveyId),
      ]);
      setAnalytics(an);
      setResponses(resp);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "No se pudieron cargar las notas.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  async function gradeAll() {
    setGrading(true);
    try {
      await surveyApi.gradeAll(surveyId);
      await load();
    } catch (e: any) {
      setError(e?.message || "No se pudo corregir.");
    } finally {
      setGrading(false);
    }
  }

  function exportCsv() {
    if (!responses) return;
    const cols = new Set<string>();
    responses.forEach((r) => Object.keys(r.answers || {}).forEach((k) => cols.add(k)));
    const answerCols = [...cols];
    const header = [
      "id",
      "submitted_at",
      "score",
      "max_score",
      "percent",
      "needs_review",
      ...answerCols,
    ];
    const rows = responses.map((r) => [
      r.id,
      r.submitted_at,
      r.score ?? "",
      r.max_score ?? "",
      r.grade?.percent ?? "",
      r.needs_review ? "1" : "0",
      ...answerCols.map((c) => csvCell(r.answers?.[c])),
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `notas-${surveyId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const shown = useMemo(() => {
    if (!responses) return [];
    return onlyReview ? responses.filter((r) => r.needs_review) : responses;
  }, [responses, onlyReview]);

  if (error)
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40">
        {error}
      </div>
    );
  if (!analytics || !responses)
    return (
      <div className="flex items-center gap-2 text-neutral-500 text-sm dark:text-neutral-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Cargando notas…
      </div>
    );

  return (
    <div className="space-y-6">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Respuestas" value={analytics.responses} />
        <Tile
          label="Promedio"
          value={analytics.avg_percent != null ? `${analytics.avg_percent}%` : "—"}
          accent={accent}
        />
        <Tile
          label="Aprobados"
          value={analytics.pass_rate != null ? `${analytics.pass_rate}%` : "—"}
        />
        <Tile
          label="A revisar"
          value={analytics.needs_review}
          warn={analytics.needs_review > 0}
        />
      </div>

      {/* Distribution + actions */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Distribution buckets={analytics.score_distribution} accent={accent} />
        <div className="flex items-center gap-2">
          <button
            onClick={gradeAll}
            disabled={grading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {grading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Corregir todo
          </button>
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Download className="w-4 h-4" /> CSV
          </button>
        </div>
      </div>

      {/* Per-question analytics */}
      {analytics.per_question.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                <th className="text-left font-medium px-3 py-2">Pregunta</th>
                <th className="text-left font-medium px-3 py-2">Respuestas</th>
                <th className="text-left font-medium px-3 py-2">% acierto</th>
                <th className="text-left font-medium px-3 py-2">Puntaje medio</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {analytics.per_question.map((q) => (
                <tr key={q.name}>
                  <td className="px-3 py-2 font-mono text-xs">{q.name}</td>
                  <td className="px-3 py-2">{q.responses}</td>
                  <td className="px-3 py-2">{q.correct_rate}%</td>
                  <td className="px-3 py-2">
                    {q.avg_score_pct != null ? `${q.avg_score_pct}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Responses / scorecard */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
            Respuestas ({shown.length})
          </h3>
          <label className="flex items-center gap-1.5 text-xs text-neutral-500 cursor-pointer dark:text-neutral-400">
            <input
              type="checkbox"
              checked={onlyReview}
              onChange={(e) => setOnlyReview(e.target.checked)}
            />
            Solo a revisar
          </label>
        </div>
        <div className="space-y-2">
          {shown.map((r) => (
            <ResponseRow
              key={r.id}
              surveyId={surveyId}
              response={r}
              accent={accent}
              onSaved={load}
            />
          ))}
          {shown.length === 0 && (
            <div className="rounded-lg border border-dashed border-neutral-300 py-8 text-center text-neutral-400 text-sm dark:border-neutral-700 dark:text-neutral-500">
              No hay respuestas {onlyReview ? "para revisar" : "todavía"}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResponseRow({
  surveyId,
  response,
  accent,
  onSaved,
}: {
  surveyId: string;
  response: ResponseItem;
  accent: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [awards, setAwards] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const grade = response.grade;
  const pct = grade?.percent ?? null;
  const questions = grade?.questions ?? [];

  async function saveOverride() {
    setSaving(true);
    try {
      await surveyApi.override(surveyId, response.id, {
        awards,
        clear_review: true,
      });
      setAwards({});
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-neutral-400 dark:text-neutral-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-neutral-400 dark:text-neutral-500" />
        )}
        <span className="text-xs text-neutral-400 shrink-0 dark:text-neutral-500">
          {new Date(response.submitted_at).toLocaleString()}
        </span>
        <span className="flex-1" />
        {response.needs_review && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-[11px] font-medium dark:bg-amber-950/40">
            <AlertTriangle className="w-3 h-3" /> revisar
          </span>
        )}
        {grade?.overridden && (
          <span className="rounded-full bg-blue-100 text-blue-700 px-2 py-0.5 text-[11px] font-medium dark:bg-blue-950/40">
            ajustada
          </span>
        )}
        <span className="text-sm font-semibold" style={{ color: accent }}>
          {response.score ?? "—"}/{response.max_score ?? "—"}
          {pct != null ? ` · ${pct}%` : ""}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-neutral-100 pt-3 space-y-2 dark:border-neutral-800">
          {questions.length === 0 && (
            <p className="text-xs text-neutral-400 dark:text-neutral-500">Sin corrección todavía.</p>
          )}
          {questions.map((q: any) => (
            <div key={q.name} className="flex items-start gap-3">
              <VerdictDot verdict={q.verdict} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-neutral-800 dark:text-neutral-200">
                  {q.name}{" "}
                  <span className="text-[11px] text-neutral-400 dark:text-neutral-500">({q.grader})</span>
                </div>
                {q.feedback && (
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">{q.feedback}</div>
                )}
                {Array.isArray(q.evidence) && q.evidence.length > 0 && (
                  <div className="text-[11px] text-neutral-400 italic mt-0.5 dark:text-neutral-500">
                    “{q.evidence.join("… ")}”
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="number"
                  min={0}
                  max={q.points}
                  step={0.5}
                  defaultValue={q.awarded}
                  onChange={(e) =>
                    setAwards((a) => ({ ...a, [q.name]: Number(e.target.value) }))
                  }
                  className="w-14 rounded-md border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
                <span className="text-xs text-neutral-400 dark:text-neutral-500">/{q.points}</span>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <Link
              href={`/surveys/${surveyId}/report/${response.id}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              <FileText className="w-3.5 h-3.5" /> Ver reporte
            </Link>
            {questions.length > 0 && (
              <button
                onClick={saveOverride}
                disabled={saving || Object.keys(awards).length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: accent }}
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Guardar ajuste
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-bold"
        style={{ color: warn ? "#d97706" : accent ?? "#1f2937" }}
      >
        {value}
      </div>
    </div>
  );
}

function Distribution({ buckets, accent }: { buckets: number[]; accent: string }) {
  const max = Math.max(1, ...buckets);
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 mb-1.5 dark:text-neutral-500">
        Distribución de notas
      </div>
      <div className="flex items-end gap-1 h-20">
        {buckets.map((b, i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <div
              className="w-5 rounded-t"
              style={{
                height: `${(b / max) * 64 + 2}px`,
                backgroundColor: accent,
                opacity: 0.35 + (i / (buckets.length - 1)) * 0.65,
              }}
              title={`${i * 10}-${i * 10 + 10}%: ${b}`}
            />
            <span className="text-[9px] text-neutral-400 dark:text-neutral-500">{i * 10}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VerdictDot({ verdict }: { verdict: string }) {
  const color =
    verdict === "correct"
      ? "#22c55e"
      : verdict === "partial"
      ? "#f59e0b"
      : verdict === "ungraded"
      ? "#9ca3af"
      : "#ef4444";
  return (
    <span
      className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

function csvCell(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
