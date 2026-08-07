"use client";

import React, { useMemo, useState } from "react";
import { Download, ArrowUpDown, Search, X } from "lucide-react";
import { surveyApi, GradebookRow, SURVEY_ACCENT } from "./surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError, LoadSpinner } from "@/components/LoadError";

interface Props {
  surveyId: string;
  accent?: string;
}

type SortKey = "percent" | "name";
type StateKey = "pending" | "review" | "passed" | "failed" | "unscored";
type Filter = "all" | StateKey;

/** Estado de corrección de una fila, con su etiqueta y estilo de chip. */
function rowState(r: GradebookRow): { key: StateKey; label: string; className: string } {
  if (!r.graded)
    return {
      key: "pending",
      label: "Sin corregir",
      className: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
    };
  // Sin puntaje posible (max_score 0, p. ej. se respondió antes de que hubiera
  // preguntas puntuadas): no está desaprobada, está sin evaluar.
  if (r.scorable === false)
    return {
      key: "unscored",
      label: "Sin evaluar",
      className: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
    };
  if (r.needs_review)
    return { key: "review", label: "A revisar", className: "bg-amber-100 text-amber-700 dark:bg-amber-950/40" };
  if (r.passed)
    return { key: "passed", label: "Aprobado", className: "bg-green-100 text-green-700 dark:bg-green-950/40" };
  return { key: "failed", label: "Desaprobado", className: "bg-red-100 text-red-700 dark:bg-red-950/40" };
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "passed", label: "Aprobados" },
  { key: "review", label: "A revisar" },
  { key: "failed", label: "Desaprobados" },
  { key: "unscored", label: "Sin evaluar" },
];

/**
 * Planilla de notas (gradebook) de una evaluación: una fila por respondiente
 * con su nota, porcentaje y estado. Ordenable por nombre o por %, y exportable
 * a CSV desde el cliente.
 */
export function GradebookPanel({ surveyId, accent = SURVEY_ACCENT }: Props) {
  const { data, status, error, reload } = useAsyncData(
    () => surveyApi.getGradebook(surveyId),
    [surveyId]
  );
  const [sortKey, setSortKey] = useState<SortKey>("percent");
  const [asc, setAsc] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Conteo por estado para las pestañas de filtro (sobre el total, no sobre lo
  // ya filtrado, para que los números no bailen al cambiar de filtro).
  const counts = useMemo(() => {
    const acc: Record<string, number> = { all: data?.rows.length ?? 0 };
    for (const r of data?.rows ?? []) {
      const k = rowState(r).key;
      acc[k] = (acc[k] ?? 0) + 1;
    }
    return acc;
  }, [data]);

  const rows = useMemo(() => {
    let list = [...(data?.rows ?? [])];
    if (filter !== "all") list = list.filter((r) => rowState(r).key === filter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          (r.name || "").toLowerCase().includes(q) ||
          (r.email || "").toLowerCase().includes(q) ||
          (r.code || "").toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      let cmp: number;
      if (sortKey === "name") {
        cmp = (a.name || "").localeCompare(b.name || "", "es", {
          sensitivity: "base",
        });
      } else {
        // Sin corregir van al final; los valores nulos se tratan como -1.
        cmp = (a.percent ?? -1) - (b.percent ?? -1);
      }
      return asc ? cmp : -cmp;
    });
    return list;
  }, [data, sortKey, asc, filter, query]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      setAsc(key === "name"); // nombre asc por defecto, % desc por defecto
    }
  }

  function exportCsv() {
    if (!data) return;
    const header = [
      "nombre",
      "email",
      "codigo",
      "nota",
      "max",
      "porcentaje",
      "estado",
    ];
    const lines = rows.map((r) => [
      r.name,
      r.email ?? "",
      r.code ?? "",
      r.score ?? "",
      r.max_score ?? "",
      r.percent ?? "",
      rowState(r).label,
    ]);
    const csv = [header, ...lines]
      .map((row) =>
        row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
      )
      .join("\r\n");
    // BOM UTF-8 para que Excel respete los acentos.
    const blob = new Blob(["﻿" + csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `notas-${surveyId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (status === "loading") return <LoadSpinner compact />;
  if (status === "error")
    return <LoadError message={error} onRetry={reload} compact />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Aprueba con{" "}
          <span className="font-semibold" style={{ color: accent }}>
            ≥ {data.passing_score}%
          </span>{" "}
          · {data.count} {data.count === 1 ? "respondiente" : "respondientes"}
        </p>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <Download className="w-4 h-4" /> Descargar CSV
        </button>
      </div>

      {/* Filtros por estado + buscador */}
      {(data.rows.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-950">
            {FILTERS.filter((f) => f.key === "all" || (counts[f.key] ?? 0) > 0).map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100"
                      : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
                  }`}
                  style={active ? { color: accent } : undefined}
                >
                  {f.label}
                  <span className="ml-1 tabular-nums text-neutral-400">{counts[f.key] ?? 0}</span>
                </button>
              );
            })}
          </div>

          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre o correo…"
              aria-label="Buscar respondiente"
              className="w-full rounded-lg border border-neutral-200 bg-white py-1.5 pl-8 pr-7 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:focus:border-neutral-600"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Limpiar búsqueda"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 py-10 text-center text-neutral-400 text-sm dark:border-neutral-700 dark:text-neutral-500">
          {data.rows.length === 0
            ? "Todavía no hay respondientes con nota."
            : "Ningún respondiente coincide con el filtro."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  <button
                    onClick={() => toggleSort("name")}
                    className="inline-flex items-center gap-1 hover:text-neutral-800 dark:hover:text-neutral-200"
                  >
                    Nombre
                    <ArrowUpDown
                      className={`w-3 h-3 ${
                        sortKey === "name" ? "text-neutral-700 dark:text-neutral-300" : "text-neutral-300 dark:text-neutral-600"
                      }`}
                    />
                  </button>
                </th>
                <th className="px-3 py-2 text-left font-medium">Email</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                  Nota
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  <button
                    onClick={() => toggleSort("percent")}
                    className="inline-flex items-center gap-1 hover:text-neutral-800 dark:hover:text-neutral-200"
                  >
                    %
                    <ArrowUpDown
                      className={`w-3 h-3 ${
                        sortKey === "percent"
                          ? "text-neutral-700 dark:text-neutral-300"
                          : "text-neutral-300 dark:text-neutral-600"
                      }`}
                    />
                  </button>
                </th>
                <th className="px-3 py-2 text-left font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {rows.map((r) => {
                const st = rowState(r);
                return (
                  <tr key={r.response_id} className="hover:bg-neutral-50/60 dark:hover:bg-neutral-900/60">
                    <td className="px-3 py-2 font-medium text-neutral-800 dark:text-neutral-200">
                      {r.name || "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">
                      {r.email || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-700 dark:text-neutral-300">
                      {r.scorable === false
                        ? "—"
                        : r.score != null && r.max_score != null
                          ? `${r.score} / ${r.max_score}`
                          : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {/* Un 0% en una respuesta sin puntaje posible engaña: va guion. */}
                      {r.scorable !== false && r.percent != null ? (
                        <span
                          className="font-semibold"
                          style={{ color: st.label === "Desaprobado" ? "#dc2626" : accent }}
                        >
                          {r.percent}%
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${st.className}`}
                      >
                        {st.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
