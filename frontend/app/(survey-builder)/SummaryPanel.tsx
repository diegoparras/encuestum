"use client";

import React, { useState } from "react";
import {
  BarChart3,
  Star,
  MessageSquareText,
  FileText,
  ExternalLink,
  Eye,
  Filter,
  ChevronDown,
  Layers,
  X,
  Plus,
  Grid3x3,
  ListOrdered,
  Hash,
  CalendarDays,
  Download,
  Printer,
  Search,
  AlertTriangle,
  ShieldAlert,
  Loader2,
  Sparkles,
  Send,
  PenLine,
} from "lucide-react";
import {
  surveyApi,
  type SummaryQuestion,
  type SummaryOption,
  type SummaryFilter,
  type FilterableQuestion,
  type SummarySegment,
  type Funnel,
  type Significance,
  type QualityReport,
  type DataAnswer,
} from "./surveyApi";
import { useI18n } from "@/lib/i18n";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { resolveAssetUrl } from "./builder/design";

/**
 * Panel de resultados estilo "Resumen" de Google Forms.
 * Carga el resumen agregado de la encuesta y dibuja un gráfico por pregunta,
 * hechos a mano con divs/SVG + Tailwind (sin librerías de charts).
 */
export function SummaryPanel({
  surveyId,
  accent,
}: {
  surveyId: string;
  accent: string;
}) {
  const { t } = useI18n();
  const [segmentBy, setSegmentBy] = useState<string | null>(null);
  const [filters, setFilters] = useState<SummaryFilter[]>([]);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const filtersKey = JSON.stringify(filters);
  const opts = { segmentBy, filters, dateFrom: dateFrom || null, dateTo: dateTo || null };

  const { data, status, error, reload } = useAsyncData(
    () => surveyApi.getSummary(surveyId, opts),
    [surveyId, segmentBy, filtersKey, dateFrom, dateTo]
  );

  // La primera carga no tiene datos aún; los cambios de filtro conservan el
  // `data` anterior (useAsyncData no lo limpia) para no desmontar los controles.
  if (!data && status === "loading") return <LoadSpinner compact />;
  if (!data && status === "error")
    return <LoadError message={error} onRetry={reload} compact />;
  if (!data) return null;

  const hasResponses = data.total_responses > 0;
  const loading = status === "loading";

  return (
    <div className="enc-print-region space-y-4">
      {hasResponses && (
        <SummaryControls
          filterable={data.filterable}
          segmentBy={segmentBy}
          filters={data.filters}
          activeFilters={filters}
          accent={accent}
          onSegmentChange={setSegmentBy}
          onFiltersChange={setFilters}
        />
      )}

      {hasResponses && (
        <div className="flex flex-wrap items-center gap-2 text-xs print:hidden">
          <CalendarDays className="h-3.5 w-3.5 text-neutral-400" />
          <span className="font-medium text-neutral-500 dark:text-neutral-400">Período</span>
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="Desde"
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          />
          <span className="text-neutral-400">a</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="Hasta"
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => {
                setDateFrom("");
                setDateTo("");
              }}
              className="text-neutral-500 underline hover:text-neutral-800 dark:text-neutral-400"
            >
              Todo el período
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            {segmentBy && (
              <a
                href={surveyApi.crosstabUrl(surveyId, opts, "xlsx")}
                className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-1 font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <Download className="h-3.5 w-3.5" /> Exportar cruce
              </a>
            )}
            <button
              onClick={imprimir}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-1 font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Printer className="h-3.5 w-3.5" /> Imprimir / PDF
            </button>
          </span>
        </div>
      )}

      {hasResponses && <QualityCard surveyId={surveyId} onExcluded={reload} />}

      {hasResponses && <AskCard surveyId={surveyId} segmentBy={segmentBy} accent={accent} />}

      {!hasResponses ? (
        <div className="rounded-xl border border-dashed border-neutral-300 py-14 text-center dark:border-neutral-700">
          <BarChart3 className="mx-auto mb-3 h-8 w-8 text-neutral-300 dark:text-neutral-600" />
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            {t("summary.empty.title")}
          </p>
          <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-400 dark:text-neutral-500">
            {t("summary.empty.body")}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {data.filtered_responses !== data.total_responses ? (
              <>
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {data.filtered_responses}
                </span>{" "}
                {t("summary.ofTotal", { total: data.total_responses })}
              </>
            ) : (
              <>
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {data.total_responses}
                </span>{" "}
                {t("summary.responsesTotal", { n: data.total_responses })}
              </>
            )}
          </p>
          {data.segment?.small_sample && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Algunos grupos tienen menos de 30 respuestas (
                {data.segment.values
                  .filter((v) => v.small)
                  .map((v) => `${v.label}: ${v.count}`)
                  .join(", ")}
                ). Las diferencias entre grupos tan chicos pueden ser casualidad: mirá la marca de
                significancia de cada pregunta antes de sacar conclusiones.
              </span>
            </div>
          )}
          {(data.timeline?.length ?? 0) > 1 && (
            <Timeline points={data.timeline!} accent={accent} />
          )}
          <div className={loading ? "opacity-50 transition-opacity" : "transition-opacity"}>
            {data.filtered_responses === 0 ? (
              <EmptyHint text={t("summary.noneMatch")} />
            ) : (
              data.questions.map((q) => (
                <div key={q.name} className="mb-4">
                  <QuestionCard q={q} accent={accent} segment={data.segment} />
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Barra de controles: segmentar por una pregunta + filtros activos. */
function SummaryControls({
  filterable,
  segmentBy,
  filters,
  activeFilters,
  accent,
  onSegmentChange,
  onFiltersChange,
}: {
  filterable: FilterableQuestion[];
  segmentBy: string | null;
  filters: { name: string; title: string; values: string[] }[];
  activeFilters: SummaryFilter[];
  accent: string;
  onSegmentChange: (name: string | null) => void;
  onFiltersChange: (filters: SummaryFilter[]) => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);

  if (filterable.length === 0) return null;

  function addFilter(name: string, value: string) {
    const existing = activeFilters.find((f) => f.name === name);
    let next: SummaryFilter[];
    if (existing) {
      if (existing.values.includes(value)) return;
      next = activeFilters.map((f) =>
        f.name === name ? { ...f, values: [...f.values, value] } : f
      );
    } else {
      next = [...activeFilters, { name, values: [value] }];
    }
    onFiltersChange(next);
    setAdding(false);
  }

  function removeFilterValue(name: string, value: string) {
    const next = activeFilters
      .map((f) =>
        f.name === name ? { ...f, values: f.values.filter((v) => v !== value) } : f
      )
      .filter((f) => f.values.length > 0);
    onFiltersChange(next);
  }

  const labelFor = (qName: string, value: string) => {
    const q = filterable.find((fq) => fq.name === qName);
    return q?.options.find((o) => o.value === value)?.label ?? value;
  };

  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 print:hidden dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className="flex flex-wrap items-center gap-2">
        {/* Segmentar por */}
        <label className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <Layers className="h-3.5 w-3.5" /> {t("summary.segmentBy")}
        </label>
        <div className="relative">
          <select
            value={segmentBy ?? ""}
            onChange={(e) => onSegmentChange(e.target.value || null)}
            className="appearance-none rounded-lg border border-neutral-300 bg-white py-1.5 pl-2.5 pr-7 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="">{t("summary.segmentNone")}</option>
            {filterable.map((q) => (
              <option key={q.name} value={q.name}>
                {q.title}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
        </div>

        <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />

        {/* Filtros activos como chips */}
        <label className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <Filter className="h-3.5 w-3.5" /> {t("summary.filter")}
        </label>
        {filters.flatMap((f) =>
          f.values.map((v) => (
            <span
              key={`${f.name}:${v}`}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium"
              style={{ backgroundColor: `${accent}1a`, color: accent }}
            >
              <span className="text-neutral-500 dark:text-neutral-400">{f.title}:</span>
              {labelFor(f.name, v)}
              <button
                onClick={() => removeFilterValue(f.name, v)}
                className="ml-0.5 rounded-full hover:bg-black/10"
                aria-label={t("summary.removeFilter")}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}

        {adding ? (
          <FilterAdder
            filterable={filterable}
            onPick={addFilter}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            <Plus className="h-3 w-3" /> {t("summary.addFilter")}
          </button>
        )}

        {(segmentBy || filters.length > 0) && (
          <button
            onClick={() => {
              onSegmentChange(null);
              onFiltersChange([]);
            }}
            className="ml-auto text-xs font-medium text-neutral-500 underline hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {t("summary.clearAll")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Selector en dos pasos para agregar un filtro: pregunta → valor. */
function FilterAdder({
  filterable,
  onPick,
  onCancel,
}: {
  filterable: FilterableQuestion[];
  onPick: (name: string, value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [qName, setQName] = useState<string>(filterable[0]?.name ?? "");
  const q = filterable.find((f) => f.name === qName);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-800">
      <select
        value={qName}
        onChange={(e) => setQName(e.target.value)}
        className="rounded-md bg-transparent px-1.5 py-1 text-sm outline-none"
      >
        {filterable.map((f) => (
          <option key={f.name} value={f.name}>
            {f.title}
          </option>
        ))}
      </select>
      <select
        defaultValue=""
        onChange={(e) => e.target.value && onPick(qName, e.target.value)}
        className="rounded-md bg-transparent px-1.5 py-1 text-sm outline-none"
      >
        <option value="" disabled>
          {t("summary.pickValue")}
        </option>
        {q?.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        onClick={onCancel}
        className="rounded-md p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        aria-label={t("common.cancel")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/**
 * Tarjeta "Embudo": vistas → comenzaron → completaron, con barras
 * decrecientes y el % de conversión entre pasos. Incluye "Dónde abandonan"
 * (top 5 preguntas donde la gente dejó la encuesta a medias).
 */
export function FunnelCard({
  surveyId,
  accent,
}: {
  surveyId: string;
  accent: string;
}) {
  const { data, status, error, reload } = useAsyncData(
    () => surveyApi.getFunnel(surveyId),
    [surveyId]
  );

  if (status === "loading") return <LoadSpinner compact />;
  if (status === "error")
    return <LoadError message={error} onRetry={reload} compact />;
  if (!data) return null;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-neutral-900 dark:text-neutral-100">Embudo</h3>
          <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            De la vista a la respuesta completa
          </p>
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: `${accent}1a`, color: accent }}
        >
          <Filter className="h-3 w-3" /> Conversión
        </span>
      </div>
      {data.views === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 py-10 text-center dark:border-neutral-700">
          <Eye className="mx-auto mb-2 h-6 w-6 text-neutral-300 dark:text-neutral-600" />
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            Todavía no hay visitas registradas
          </p>
          <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-400 dark:text-neutral-500">
            Las vistas se cuentan desde ahora: compartí el enlace y acá vas a
            ver cuánta gente entra, empieza y completa la encuesta.
          </p>
        </div>
      ) : (
        <FunnelSteps funnel={data} accent={accent} />
      )}
      <FunnelExtras funnel={data} />
      {data.dropoff.length > 0 && <DropoffList items={data.dropoff} />}
    </div>
  );
}

/** Los tres pasos del embudo con barras decrecientes y % entre pasos. */
function FunnelSteps({ funnel, accent }: { funnel: Funnel; accent: string }) {
  const steps = [
    { label: "Vistas", count: funnel.views },
    { label: "Comenzaron", count: funnel.starts },
    { label: "Completaron", count: funnel.completions },
  ];
  const base = Math.max(1, funnel.views);

  return (
    <div>
      {steps.map((step, i) => {
        const width = Math.min(100, (step.count / base) * 100);
        // % de conversión respecto del paso anterior (se calcula del conteo
        // para no depender de la escala de los rates del backend).
        const prev = i > 0 ? steps[i - 1].count : null;
        const rate =
          prev !== null && prev > 0
            ? Math.round((step.count / prev) * 100)
            : null;
        return (
          <React.Fragment key={step.label}>
            {i > 0 && (
              <div className="flex items-center gap-1.5 py-1.5 pl-1 text-xs text-neutral-400 dark:text-neutral-500">
                <ChevronDown className="h-3.5 w-3.5" />
                <span>
                  {rate !== null ? (
                    <>
                      <span className="font-semibold text-neutral-600 dark:text-neutral-300">
                        {rate}%
                      </span>{" "}
                      {i === 1 ? "comenzaron" : "completaron"}
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
            )}
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="text-sm text-neutral-600 dark:text-neutral-300">{step.label}</span>
                <span className="text-2xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
                  {step.count.toLocaleString("es-AR")}
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${step.count > 0 ? Math.max(width, 2) : 0}%`,
                    backgroundColor: accent,
                    // Cada paso un poco más tenue, para reforzar el embudo.
                    opacity: 1 - i * 0.25,
                  }}
                />
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Top 5 de preguntas donde más gente abandonó, ordenado descendente. */
function DropoffList({ items }: { items: Funnel["dropoff"] }) {
  const top = [...items].sort((a, b) => b.count - a.count).slice(0, 5);
  const max = Math.max(1, ...top.map((d) => d.count));
  return (
    <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Dónde abandonan
      </h4>
      <div className="space-y-2">
        {top.map((d) => (
          <div key={d.question} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-300">
              {d.title || d.question}
            </span>
            <div className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-neutral-100 sm:block dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-neutral-400"
                style={{ width: `${(d.count / max) * 100}%` }}
              />
            </div>
            <span className="shrink-0 tabular-nums text-sm text-neutral-500 dark:text-neutral-400">
              {d.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  accent,
  segment,
}: {
  q: SummaryQuestion;
  accent: string;
  segment?: SummarySegment | null;
}) {
  const { t } = useI18n();
  // Cross-tab: hay segmento activo, esta pregunta trae desglose y es de un tipo
  // que se puede cruzar (choice / rating).
  const segmented =
    !!segment &&
    !!q.by_segment &&
    (q.kind === "choice" || q.kind === "rating");
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-neutral-900 dark:text-neutral-100">
            {q.hidden_field && (
              <span className="mr-1.5 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] font-normal text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                {t("summary.hiddenField")}
              </span>
            )}
            {q.title || q.name}
          </h3>
          <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            {t("summary.answeredCount", { n: q.answered })}
            {q.timing ? ` · ${t("summary.medianTime", { s: formatSeconds(q.timing.median_seconds) })}` : ""}
            {q.kind === "choice" && q.multi ? ` · ${t("summary.multi")}` : ""}
            {segmented ? ` · ${t("summary.byLabel", { seg: segment!.title })}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <KindBadge kind={q.kind} accent={accent} />
          {segmented && q.significance && <SignificanceBadge sig={q.significance} />}
        </div>
      </div>
      {segmented ? (
        <SegmentedChart q={q} segment={segment!} accent={accent} />
      ) : (
        <QuestionChart q={q} accent={accent} />
      )}
    </div>
  );
}

/** Cross-tab: una pregunta desglosada por los valores del segmento.
 * choice → tabla opción × segmento (conteos). rating → promedio por segmento. */
function SegmentedChart({
  q,
  segment,
  accent,
}: {
  q: SummaryQuestion;
  segment: SummarySegment;
  accent: string;
}) {
  const cols = segment.values;

  if (q.kind === "rating") {
    const avgs = cols.map((c) => {
      const sub = q.by_segment?.[c.value];
      return sub && sub.kind === "rating" ? sub.average : null;
    });
    const maxAvg = Math.max(1, ...avgs.map((a) => a ?? 0));
    return (
      <div className="space-y-2.5">
        {cols.map((c, i) => {
          const a = avgs[i];
          return (
            <div key={c.value} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-sm text-neutral-700 dark:text-neutral-300">
                {c.label}
              </span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${a != null ? (a / maxAvg) * 100 : 0}%`, backgroundColor: accent }}
                />
              </div>
              <span className="w-12 shrink-0 text-right tabular-nums text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {a != null ? a.toFixed(2) : "—"}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // choice → tabla cruzada. Filas = opciones; columnas = segmentos; celda = n (%).
  const options = q.kind === "choice" ? q.options : [];
  const colTotals = cols.map((c) => {
    const sub = q.by_segment?.[c.value];
    if (sub && sub.kind === "choice") {
      return sub.options.reduce((s, o) => s + o.count, 0);
    }
    return 0;
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            <th className="py-2 pr-3 text-left font-medium text-neutral-400 dark:text-neutral-500" />
            {cols.map((c) => (
              <th
                key={c.value}
                className="px-2 py-2 text-right font-medium text-neutral-600 dark:text-neutral-300"
              >
                {c.label}
                <span className="block text-[11px] font-normal text-neutral-400">
                  n={c.count}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {options.map((opt, ri) => (
            <tr key={ri} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
              <td className="py-2 pr-3 text-neutral-700 dark:text-neutral-300">{opt.label}</td>
              {cols.map((c, ci) => {
                const sub = q.by_segment?.[c.value];
                const cell =
                  sub && sub.kind === "choice"
                    ? sub.options.find((o) => o.value === opt.value)?.count ?? 0
                    : 0;
                const pct = colTotals[ci] > 0 ? Math.round((cell / colTotals[ci]) * 100) : 0;
                return (
                  <td key={c.value} className="px-2 py-2 text-right tabular-nums">
                    <span className="font-medium text-neutral-800 dark:text-neutral-200">{cell}</span>
                    <span className="ml-1 text-[11px] text-neutral-400">{pct}%</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindBadge({
  kind,
  accent,
}: {
  kind: SummaryQuestion["kind"];
  accent: string;
}) {
  const map: Record<
    SummaryQuestion["kind"],
    { icon: React.ComponentType<{ className?: string }>; label: string }
  > = {
    choice: { icon: BarChart3, label: "Opciones" },
    rating: { icon: Star, label: "Puntuación" },
    text: { icon: MessageSquareText, label: "Texto" },
    files: { icon: FileText, label: "Archivos" },
    matrix: { icon: Grid3x3, label: "Matriz" },
    ranking: { icon: ListOrdered, label: "Ranking" },
    numeric: { icon: Hash, label: "Número" },
    dates: { icon: CalendarDays, label: "Fecha" },
    signature: { icon: PenLine, label: "Firma" },
  };
  const { icon: Icon, label } = map[kind];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: `${accent}1a`, color: accent }}
    >
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

function QuestionChart({
  q,
  accent,
}: {
  q: SummaryQuestion;
  accent: string;
}) {
  switch (q.kind) {
    case "choice":
      return <ChoiceChart options={q.options} accent={accent} />;
    case "rating":
      return (
        <>
          {q.nps && <NpsBlock nps={q.nps} />}
          <RatingChart
            min={q.min}
            max={q.max}
            average={q.average}
            distribution={q.distribution}
            accent={accent}
          />
          <RatingStats q={q} />
        </>
      );
    case "text":
      return <TextList values={q.values} terms={q.terms} accent={accent} />;
    case "files":
      return <FilesList values={q.values} accent={accent} />;
    case "matrix":
      return <MatrixChart q={q} accent={accent} />;
    case "ranking":
      return <RankingChart q={q} accent={accent} />;
    case "numeric":
      return <NumericChart q={q} accent={accent} />;
    case "dates":
      return <DatesChart q={q} accent={accent} />;
    case "signature":
      return (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          <span className="text-2xl font-semibold tabular-nums" style={{ color: accent }}>
            {q.signed}
          </span>{" "}
          {q.signed === 1 ? "persona firmó" : "personas firmaron"}. Las firmas se ven en la ficha de cada respuesta.
        </p>
      );
    default:
      return null;
  }
}

/** Barras horizontales por opción, proporcionales al count (n y %). */
function formatSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

export function ChoiceChart({
  options,
  accent,
}: {
  options: SummaryOption[];
  accent: string;
}) {
  if (options.length === 0) {
    return <EmptyHint text="Sin opciones registradas." />;
  }
  const total = options.reduce((sum, o) => sum + o.count, 0);
  const maxCount = Math.max(1, ...options.map((o) => o.count));
  return (
    <div className="space-y-3">
      {options.map((o, i) => {
        const pct = total > 0 ? Math.round((o.count / total) * 100) : 0;
        const width = (o.count / maxCount) * 100;
        return (
          <div key={i}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-300">
                {o.label}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400">
                {o.count} · {pct}%
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${width}%`,
                  backgroundColor: accent,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Histograma de barras verticales por valor min..max + promedio grande. */
export function RatingChart({
  min,
  max,
  average,
  distribution,
  accent,
}: {
  min: number;
  max: number;
  average: number | null;
  distribution: { value: number; count: number }[];
  accent: string;
}) {
  // Arma todos los valores min..max, rellenando con count 0 los que falten.
  const byValue = new Map(distribution.map((d) => [d.value, d.count]));
  const values: { value: number; count: number }[] = [];
  for (let v = min; v <= max; v++) {
    values.push({ value: v, count: byValue.get(v) ?? 0 });
  }
  const maxCount = Math.max(1, ...values.map((v) => v.count));

  return (
    <div>
      <div className="mb-4 flex items-end gap-2">
        <span
          className="text-4xl font-semibold leading-none"
          style={{ color: accent }}
        >
          {average != null ? average.toFixed(1) : "—"}
        </span>
        <span className="mb-0.5 text-sm text-neutral-400 dark:text-neutral-500">
          promedio (de {min} a {max})
        </span>
      </div>
      <div className="flex items-end gap-1.5" style={{ height: 128 }}>
        {values.map((v) => {
          const h = (v.count / maxCount) * 100;
          return (
            <div
              key={v.value}
              className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
            >
              <span className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                {v.count}
              </span>
              {/* Alto en píxeles: un % no tiene contra qué medirse dentro de
                  una columna flex sin alto propio y la barra salía plana. */}
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height: v.count > 0 ? Math.max(4, (h / 100) * 92) : 0,
                  backgroundColor: v.count > 0 ? accent : "transparent",
                }}
                title={`${v.value}: ${v.count}`}
              />
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {v.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Respuestas abiertas: términos frecuentes (clic = filtrar), buscador y lista. */
function TextList({
  values,
  terms,
  accent,
}: {
  values: string[];
  terms?: { term: string; count: number }[];
  accent: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const nonEmpty = values.filter((v) => v && v.trim().length > 0);
  if (nonEmpty.length === 0) {
    return <EmptyHint text="Sin respuestas de texto." />;
  }
  const fold = (x: string) =>
    x
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
  const q = fold(query.trim());
  const matching = q ? nonEmpty.filter((v) => fold(v).includes(q)) : nonEmpty;
  const LIMIT = 50;
  const visible = showAll ? matching : matching.slice(0, LIMIT);
  const hidden = matching.length - visible.length;

  return (
    <div>
      {terms && terms.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {terms.map((t) => {
            const active = q === fold(t.term);
            return (
              <button
                key={t.term}
                onClick={() => setQuery(active ? "" : t.term)}
                title={`Aparece en ${t.count} respuestas`}
                className="rounded-full px-2 py-0.5 text-xs font-medium transition-colors"
                style={
                  active
                    ? { backgroundColor: accent, color: "#fff" }
                    : { backgroundColor: `${accent}1a`, color: accent }
                }
              >
                {t.term} <span className="opacity-70">{t.count}</span>
              </button>
            );
          })}
        </div>
      )}
      {nonEmpty.length > 8 && (
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800">
          <Search className="h-3.5 w-3.5 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en las respuestas…"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
      )}
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1 print:max-h-none">
        {visible.map((v, i) => (
          <div
            key={i}
            className="rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
          >
            {v}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-neutral-400 dark:text-neutral-500">
        <span>
          {q ? `${matching.length} de ` : ""}
          {nonEmpty.length} {nonEmpty.length === 1 ? "respuesta" : "respuestas"}
        </span>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="font-medium text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            Ver todas ({hidden} más)
          </button>
        )}
      </div>
    </div>
  );
}

const VIDEO_RE = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i;

/** Lista de enlaces a archivos; mini-preview para videos. */
function FilesList({
  values,
  accent,
}: {
  values: string[];
  accent: string;
}) {
  const urls = values.filter((v) => v && v.trim().length > 0);
  if (urls.length === 0) {
    return <EmptyHint text="Sin archivos adjuntos." />;
  }
  return (
    <div className="space-y-3">
      {urls.map((raw, i) => {
        const url = resolveAssetUrl(raw);
        const isVideo = VIDEO_RE.test(raw);
        const name = fileName(raw);
        if (isVideo) {
          return (
            <div key={i} className="space-y-1">
              <video
                src={url}
                controls
                preload="metadata"
                className="max-h-64 w-full rounded-lg border border-neutral-200 bg-black dark:border-neutral-800"
              />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              >
                {name} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          );
        }
        return (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <FileText className="h-4 w-4 shrink-0" style={{ color: accent }} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
          </a>
        );
      })}
    </div>
  );
}

/** Imprime sólo el resumen (misma técnica que el informe ejecutivo: ver
 *  `.enc-printing` en globals.css). El navegador ofrece "Guardar como PDF". */
function imprimir() {
  document.body.classList.add("enc-printing");
  const fin = () => {
    document.body.classList.remove("enc-printing");
    window.removeEventListener("afterprint", fin);
  };
  window.addEventListener("afterprint", fin);
  window.print();
}

function fileName(url: string): string {
  try {
    const clean = url.split("?")[0].split("#")[0];
    const parts = clean.split("/");
    return decodeURIComponent(parts[parts.length - 1] || url);
  } catch {
    return url;
  }
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-neutral-400 dark:text-neutral-500">{text}</p>;
}

/** Marca de significancia de un cruce: ¿la diferencia entre grupos es real? */
function SignificanceBadge({ sig }: { sig: Significance }) {
  if (!sig.reliable) {
    return (
      <span
        className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
        title="Hay pocas respuestas por celda para que la prueba chi² sea confiable."
      >
        Muestra insuficiente
      </span>
    );
  }
  const pTxt = sig.p < 0.001 ? "p < 0,001" : `p = ${sig.p.toFixed(3).replace(".", ",")}`;
  return sig.significant ? (
    <span
      className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      title={`Chi² = ${sig.chi2} (${sig.dof} g.l.), ${pTxt}, V de Cramér = ${sig.cramers_v ?? "—"}. Es poco probable que la diferencia entre grupos sea casualidad.`}
    >
      Diferencia significativa · {pTxt}
    </span>
  ) : (
    <span
      className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
      title={`Chi² = ${sig.chi2} (${sig.dof} g.l.), ${pTxt}. La diferencia entre grupos puede ser casualidad.`}
    >
      Sin diferencia clara · {pTxt}
    </span>
  );
}

/** Respuestas por día, como barras finas. */
function Timeline({ points, accent }: { points: { date: string; count: number }[]; accent: string }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((a, p) => a + p.count, 0);
  const pico = points.reduce((a, p) => (p.count > a.count ? p : a), points[0]);
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-2 flex items-baseline justify-between text-xs text-neutral-500 dark:text-neutral-400">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">Respuestas por día</span>
        <span>
          {total} en {points.length} días · pico {pico.count} el {fmt(pico.date)}
        </span>
      </div>
      <div className="flex h-16 items-end gap-px" role="img" aria-label="Respuestas por día">
        {points.map((p) => (
          <div
            key={p.date}
            className="min-w-[2px] flex-1 rounded-t-sm"
            title={`${fmt(p.date)}: ${p.count}`}
            style={{
              height: `${(p.count / max) * 100}%`,
              minHeight: p.count ? 2 : 0,
              backgroundColor: accent,
              opacity: p.count ? 0.85 : 0,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
        <span>{fmt(points[0].date)}</span>
        <span>{fmt(points[points.length - 1].date)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-950">
      <p className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">{value}</p>
    </div>
  );
}

const num = (v: number | null | undefined, d = 1) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

function RatingStats({ q }: { q: Extract<SummaryQuestion, { kind: "rating" }> }) {
  if (q.median == null && q.top2 == null) return null;
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Mediana" value={num(q.median)} />
      <Stat label="Desvío" value={num(q.stdev, 2)} />
      {q.top2 != null && <Stat label={`Top-2 (${q.max - 1}-${q.max})`} value={`${num(q.top2)}%`} />}
      {q.bottom2 != null && <Stat label={`Bottom-2 (${q.min}-${q.min + 1})`} value={`${num(q.bottom2)}%`} />}
    </div>
  );
}

/** Net Promoter Score: promotores (9-10) menos detractores (0-6). */
function NpsBlock({ nps }: { nps: { score: number; promoters: number; passives: number; detractors: number } }) {
  const total = nps.promoters + nps.passives + nps.detractors || 1;
  const seg = [
    { label: "Detractores (0-6)", n: nps.detractors, color: "#ef4444" },
    { label: "Pasivos (7-8)", n: nps.passives, color: "#a3a3a3" },
    { label: "Promotores (9-10)", n: nps.promoters, color: "#22c55e" },
  ];
  return (
    <div className="mb-5 rounded-lg border border-neutral-100 p-3 dark:border-neutral-800">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
          {nps.score > 0 ? `+${nps.score}` : nps.score}
        </span>
        <span className="text-xs text-neutral-500">NPS (de −100 a +100)</span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {seg.map((x) => (
          <div key={x.label} style={{ width: `${(x.n / total) * 100}%`, backgroundColor: x.color }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-neutral-500">
        {seg.map((x) => (
          <span key={x.label} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: x.color }} />
            {x.label}: {x.n} ({Math.round((x.n / total) * 100)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

/** Matriz: tabla filas × columnas con intensidad según el % de la fila. */
function MatrixChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "matrix" }>; accent: string }) {
  if (!q.rows.length || !q.columns.length) return <EmptyHint text="Sin filas o columnas definidas." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr>
            <th />
            {q.columns.map((c) => (
              <th key={c.value} className="px-2 py-1.5 text-center text-xs font-medium text-neutral-500">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.rows.map((r, i) => {
            const fila = q.cells[i] ?? [];
            const tot = fila.reduce((a, b) => a + b, 0);
            return (
              <tr key={r.value} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-1.5 pr-3 text-neutral-700 dark:text-neutral-300">{r.label}</td>
                {fila.map((n, j) => {
                  const pct = tot ? n / tot : 0;
                  return (
                    <td key={j} className="p-1 text-center">
                      <div
                        className="rounded-md px-2 py-1.5 tabular-nums"
                        style={{
                          backgroundColor: `${accent}${Math.round(pct * 200 + 10)
                            .toString(16)
                            .padStart(2, "0")}`,
                          color: pct > 0.55 ? "#fff" : undefined,
                        }}
                        title={`${r.label} → ${q.columns[j]?.label}: ${n}`}
                      >
                        {tot ? `${Math.round(pct * 100)}%` : "—"}
                        <span className="ml-1 text-[10px] opacity-70">{n}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Ranking: de la más priorizada a la menos (posición promedio). */
function RankingChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "ranking" }>; accent: string }) {
  const nOpts = q.items.length || 1;
  return (
    <ol className="space-y-2.5">
      {q.items.map((it, i) => {
        const score = it.avg_position == null ? 0 : (nOpts - it.avg_position + 1) / nOpts;
        return (
          <li key={it.value}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-300">
                <span className="mr-2 tabular-nums text-neutral-400">{i + 1}.</span>
                {it.label}
              </span>
              <span className="shrink-0 tabular-nums text-xs text-neutral-500">
                posición media {num(it.avg_position, 2)} · 1.º para {it.first}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
              <div className="h-full rounded-full" style={{ width: `${score * 100}%`, backgroundColor: accent }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function MiniBars({
  bars,
  accent,
}: {
  bars: { label: string; count: number; title: string }[];
  accent: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <div className="flex items-end gap-1" style={{ height: 96 }}>
      {bars.map((b, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={b.title}>
          <span className="text-[10px] tabular-nums text-neutral-400">{b.count || ""}</span>
          <div
            className="w-full rounded-t"
            style={{ height: b.count ? Math.max(3, (b.count / max) * 64) : 0, backgroundColor: accent }}
          />
          <span className="max-w-full truncate text-[10px] text-neutral-500">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

function NumericChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "numeric" }>; accent: string }) {
  if (!q.n) return <EmptyHint text="Sin respuestas numéricas." />;
  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
        <Stat label="Promedio" value={num(q.average, 2)} />
        <Stat label="Mediana" value={num(q.median, 2)} />
        <Stat label="Desvío" value={num(q.stdev, 2)} />
        <Stat label="Mínimo" value={num(q.min, 2)} />
        <Stat label="Máximo" value={num(q.max, 2)} />
      </div>
      <MiniBars
        accent={accent}
        bars={q.histogram.map((h) => ({
          label: num(h.from, 1),
          count: h.count,
          title: `${num(h.from, 2)} a ${num(h.to, 2)}: ${h.count}`,
        }))}
      />
    </div>
  );
}

function DatesChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "dates" }>; accent: string }) {
  if (!q.n) return <EmptyHint text="Sin fechas respondidas." />;
  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat label="Primera" value={q.min} />
        <Stat label="Mediana" value={q.median} />
        <Stat label="Última" value={q.max} />
      </div>
      {q.by_month.length > 1 && (
        <MiniBars
          accent={accent}
          bars={q.by_month.map((m) => ({ label: m.month, count: m.count, title: `${m.month}: ${m.count}` }))}
        />
      )}
    </div>
  );
}

const MOTIVOS: Record<string, string> = {
  speeder: "Apurada",
  straight_line: "En línea recta",
  duplicate: "Duplicada",
};

/** Respuestas con señales de baja calidad, con la opción de excluirlas
 *  (reversible: se pueden volver a incluir desde la tabla de respuestas). */
function QualityCard({ surveyId, onExcluded }: { surveyId: string; onExcluded: () => void }) {
  const { data, reload } = useAsyncData(() => surveyApi.getQuality(surveyId), [surveyId]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!data || data.flagged.length === 0) return null;
  const porMotivo: Record<string, number> = {};
  for (const f of data.flagged) for (const r of f.reasons) porMotivo[r.code] = (porMotivo[r.code] ?? 0) + 1;

  async function excluir(d: QualityReport) {
    if (!window.confirm(`¿Excluir ${d.flagged.length} respuestas de los resultados? Se pueden volver a incluir.`))
      return;
    setBusy(true);
    try {
      await surveyApi.bulkResponses(surveyId, d.flagged.map((f) => f.response_id), "exclude");
      reload();
      onExcluded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600" />
        <span className="font-medium text-amber-900 dark:text-amber-200">
          {data.flagged.length} {data.flagged.length === 1 ? "respuesta" : "respuestas"} con señales de baja calidad
        </span>
        <span className="text-xs text-amber-800/80 dark:text-amber-300/80">
          {Object.entries(porMotivo)
            .map(([k, n]) => `${MOTIVOS[k] ?? k}: ${n}`)
            .join(" · ")}
        </span>
        <span className="ml-auto flex gap-2">
          <button onClick={() => setOpen((o) => !o)} className="text-xs font-medium text-amber-900 underline dark:text-amber-200">
            {open ? "Ocultar" : "Ver detalle"}
          </button>
          <button
            onClick={() => excluir(data)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Excluirlas
          </button>
        </span>
      </div>
      {open && (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs text-amber-900 dark:text-amber-200">
          {data.flagged.map((f) => (
            <li key={f.response_id}>
              <span className="font-mono opacity-60">{f.response_id.slice(0, 8)}</span> ·{" "}
              {f.reasons.map((r) => `${MOTIVOS[r.code] ?? r.code} (${r.detail})`).join("; ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DISPOSITIVOS: Record<string, string> = { mobile: "Celular", desktop: "Computadora", tablet: "Tableta" };

function duracion(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1).replace(".", ",")} h`;
}

/** Tiempo de completado, dispositivos y personas con una respuesta en curso. */
function FunnelExtras({ funnel }: { funnel: Funnel }) {
  const t = funnel.completion_seconds;
  const devs = Object.entries(funnel.devices ?? {});
  const totalDev = devs.reduce((a, [, n]) => a + n, 0);
  if (!t?.n && !totalDev && !funnel.in_progress) return null;
  return (
    <div className="mt-5 grid grid-cols-1 gap-2 border-t border-neutral-100 pt-4 sm:grid-cols-3 dark:border-neutral-800">
      {t && t.n > 0 && (
        <Stat
          label="Tiempo para completar"
          value={
            <span title={`Desde que abrió la encuesta hasta que la envió. Mitad central: ${duracion(t.p25)} a ${duracion(t.p75)}.`}>
              {duracion(t.median)} <span className="text-xs font-normal text-neutral-400">mediana</span>
            </span>
          }
        />
      )}
      {totalDev > 0 && (
        <Stat
          label="Dispositivo"
          value={devs
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${DISPOSITIVOS[k] ?? k} ${Math.round((n / totalDev) * 100)}%`)
            .join(" · ")}
        />
      )}
      {!!funnel.in_progress && (
        <Stat
          label="En curso"
          value={
            <span title="Personas identificadas (invitados o alumnos desde Moodle) con una respuesta a medio hacer guardada.">
              {funnel.in_progress} {funnel.in_progress === 1 ? "persona" : "personas"}
            </span>
          }
        />
      )}
    </div>
  );
}

/** "Preguntale a tus datos": la IA responde con los números que calcula el
 *  servidor (no inventa). Si hay un segmento activo, el cruce va en el
 *  contexto, con su prueba de significancia. */
function AskCard({ surveyId, segmentBy, accent }: { surveyId: string; segmentBy: string | null; accent: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<DataAnswer | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function preguntar(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim().length < 3) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await surveyApi.ask(surveyId, q.trim(), segmentBy));
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 print:hidden">
      <form onSubmit={preguntar} className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0" style={{ color: accent }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={500}
          placeholder={
            segmentBy
              ? "Preguntale a tus datos (con el cruce activo): ¿qué grupo está más conforme?"
              : "Preguntale a tus datos: ¿qué es lo que más se critica?"
          }
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button
          type="submit"
          disabled={busy || q.trim().length < 3}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: accent }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Preguntar
        </button>
      </form>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {res && (
        <div className="mt-3 border-t border-neutral-100 pt-3 text-sm dark:border-neutral-800">
          <p className={res.answerable ? "text-neutral-800 dark:text-neutral-100" : "text-neutral-500"}>{res.answer}</p>
          {res.figures.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {res.figures.map((f, i) => (
                <span key={i} className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
                  <span className="text-neutral-500">{f.label}:</span>{" "}
                  <span className="font-semibold tabular-nums">{f.value}</span>
                </span>
              ))}
            </div>
          )}
          {res.caveats.map((c, i) => (
            <p key={i} className="mt-1.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {c}
            </p>
          ))}
          <p className="mt-2 text-[11px] text-neutral-400">
            Las cifras salen de los datos calculados por Encuestum, no de la IA. Verificalas en los gráficos.
          </p>
        </div>
      )}
    </div>
  );
}
