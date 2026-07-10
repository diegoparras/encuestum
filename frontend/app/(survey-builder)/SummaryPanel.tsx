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
} from "lucide-react";
import {
  surveyApi,
  type SummaryQuestion,
  type SummaryOption,
  type Funnel,
} from "./surveyApi";
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
  const { data, status, error, reload } = useAsyncData(
    () => surveyApi.getSummary(surveyId),
    [surveyId]
  );

  if (status === "loading") return <LoadSpinner compact />;
  if (status === "error")
    return <LoadError message={error} onRetry={reload} compact />;
  if (!data) return null;

  if (data.total_responses === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 py-14 text-center">
        <BarChart3 className="mx-auto mb-3 h-8 w-8 text-neutral-300" />
        <p className="text-sm font-medium text-neutral-600">
          Todavía no hay respuestas
        </p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-400">
          Cuando alguien complete la encuesta, acá vas a ver los gráficos con el
          resumen de resultados.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">
        <span className="font-semibold text-neutral-800">
          {data.total_responses}
        </span>{" "}
        {data.total_responses === 1 ? "respuesta" : "respuestas"} en total.
      </p>
      {data.questions.map((q) => (
        <QuestionCard key={q.name} q={q} accent={accent} />
      ))}
    </div>
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
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-neutral-900">Embudo</h3>
          <p className="mt-0.5 text-xs text-neutral-400">
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
        <div className="rounded-lg border border-dashed border-neutral-300 py-10 text-center">
          <Eye className="mx-auto mb-2 h-6 w-6 text-neutral-300" />
          <p className="text-sm font-medium text-neutral-600">
            Todavía no hay visitas registradas
          </p>
          <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-400">
            Las vistas se cuentan desde ahora: compartí el enlace y acá vas a
            ver cuánta gente entra, empieza y completa la encuesta.
          </p>
        </div>
      ) : (
        <FunnelSteps funnel={data} accent={accent} />
      )}
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
              <div className="flex items-center gap-1.5 py-1.5 pl-1 text-xs text-neutral-400">
                <ChevronDown className="h-3.5 w-3.5" />
                <span>
                  {rate !== null ? (
                    <>
                      <span className="font-semibold text-neutral-600">
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
                <span className="text-sm text-neutral-600">{step.label}</span>
                <span className="text-2xl font-semibold tabular-nums text-neutral-900">
                  {step.count.toLocaleString("es-AR")}
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-100">
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
    <div className="mt-5 border-t border-neutral-100 pt-4">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Dónde abandonan
      </h4>
      <div className="space-y-2">
        {top.map((d) => (
          <div key={d.question} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">
              {d.title || d.question}
            </span>
            <div className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-neutral-100 sm:block">
              <div
                className="h-full rounded-full bg-neutral-400"
                style={{ width: `${(d.count / max) * 100}%` }}
              />
            </div>
            <span className="shrink-0 tabular-nums text-sm text-neutral-500">
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
}: {
  q: SummaryQuestion;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-neutral-900">
            {q.title || q.name}
          </h3>
          <p className="mt-0.5 text-xs text-neutral-400">
            {q.answered} {q.answered === 1 ? "respondió" : "respondieron"}
            {q.kind === "choice" && q.multi ? " · opción múltiple" : ""}
          </p>
        </div>
        <KindBadge kind={q.kind} accent={accent} />
      </div>
      <QuestionChart q={q} accent={accent} />
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
        <RatingChart
          min={q.min}
          max={q.max}
          average={q.average}
          distribution={q.distribution}
          accent={accent}
        />
      );
    case "text":
      return <TextList values={q.values} />;
    case "files":
      return <FilesList values={q.values} accent={accent} />;
    default:
      return null;
  }
}

/** Barras horizontales por opción, proporcionales al count (n y %). */
function ChoiceChart({
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
              <span className="min-w-0 truncate text-neutral-700">
                {o.label}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {o.count} · {pct}%
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-100">
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
function RatingChart({
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
        <span className="mb-0.5 text-sm text-neutral-400">
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
              <span className="text-[11px] tabular-nums text-neutral-400">
                {v.count}
              </span>
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height: `${Math.max(h, v.count > 0 ? 4 : 0)}%`,
                  backgroundColor: v.count > 0 ? accent : "transparent",
                  minHeight: v.count > 0 ? 4 : 0,
                }}
                title={`${v.value}: ${v.count}`}
              />
              <span className="text-xs font-medium text-neutral-500">
                {v.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Lista scrolleable de respuestas abiertas (máx ~50 visibles). */
function TextList({ values }: { values: string[] }) {
  const [showAll, setShowAll] = useState(false);
  const nonEmpty = values.filter((v) => v && v.trim().length > 0);
  if (nonEmpty.length === 0) {
    return <EmptyHint text="Sin respuestas de texto." />;
  }
  const LIMIT = 50;
  const visible = showAll ? nonEmpty : nonEmpty.slice(0, LIMIT);
  const hidden = nonEmpty.length - visible.length;

  return (
    <div>
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {visible.map((v, i) => (
          <div
            key={i}
            className="rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm text-neutral-700"
          >
            {v}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
        <span>
          {nonEmpty.length}{" "}
          {nonEmpty.length === 1 ? "respuesta" : "respuestas"}
        </span>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="font-medium text-neutral-600 underline hover:text-neutral-900"
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
                className="max-h-64 w-full rounded-lg border border-neutral-200 bg-black"
              />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900"
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
            className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            <FileText className="h-4 w-4 shrink-0" style={{ color: accent }} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          </a>
        );
      })}
    </div>
  );
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
  return <p className="text-sm text-neutral-400">{text}</p>;
}
