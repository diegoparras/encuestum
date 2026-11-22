"use client";

/** Gráficos y bloques de cada tipo de pregunta del resumen (extraídos de SummaryPanel). */

import React, { useState } from "react";
import { FileText, ExternalLink, Search } from "lucide-react";
import { type SummaryQuestion, type SummaryOption, type Significance } from "./surveyApi";
import { resolveAssetUrl } from "./builder/design";

export function formatSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

/** Barras horizontales por opción, proporcionales al count (n y %). */
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
export function TextList({
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

export const VIDEO_RE = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i;

/** Lista de enlaces a archivos; mini-preview para videos. */
export function FilesList({
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

export function fileName(url: string): string {
  try {
    const clean = url.split("?")[0].split("#")[0];
    const parts = clean.split("/");
    return decodeURIComponent(parts[parts.length - 1] || url);
  } catch {
    return url;
  }
}

export function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-neutral-400 dark:text-neutral-500">{text}</p>;
}

/** Marca de significancia de un cruce: ¿la diferencia entre grupos es real? */
export function SignificanceBadge({ sig }: { sig: Significance }) {
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
export function Timeline({ points, accent }: { points: { date: string; count: number }[]; accent: string }) {
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

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-950">
      <p className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">{value}</p>
    </div>
  );
}

export function RatingStats({ q }: { q: Extract<SummaryQuestion, { kind: "rating" }> }) {
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

export const num = (v: number | null | undefined, d = 1) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

/** Net Promoter Score: promotores (9-10) menos detractores (0-6). */
export function NpsBlock({ nps }: { nps: { score: number; promoters: number; passives: number; detractors: number } }) {
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
export function MatrixChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "matrix" }>; accent: string }) {
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
export function RankingChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "ranking" }>; accent: string }) {
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

export function MiniBars({
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

export function NumericChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "numeric" }>; accent: string }) {
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

export function DatesChart({ q, accent }: { q: Extract<SummaryQuestion, { kind: "dates" }>; accent: string }) {
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
