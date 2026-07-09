"use client";

import React, { useMemo, useState } from "react";
import { Download, ArrowUpDown } from "lucide-react";
import { surveyApi, GradebookRow, SURVEY_ACCENT } from "./surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError, LoadSpinner } from "@/components/LoadError";

interface Props {
  surveyId: string;
  accent?: string;
}

type SortKey = "percent" | "name";

/** Estado de corrección de una fila, con su etiqueta y estilo de chip. */
function rowState(r: GradebookRow): { label: string; className: string } {
  if (!r.graded)
    return {
      label: "Sin corregir",
      className: "bg-neutral-100 text-neutral-600",
    };
  if (r.needs_review)
    return { label: "A revisar", className: "bg-amber-100 text-amber-700" };
  if (r.passed)
    return { label: "Aprobado", className: "bg-green-100 text-green-700" };
  return { label: "Desaprobado", className: "bg-red-100 text-red-700" };
}

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

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
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
  }, [data, sortKey, asc]);

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
        <p className="text-xs text-neutral-500">
          Aprueba con{" "}
          <span className="font-semibold" style={{ color: accent }}>
            ≥ {data.passing_score}%
          </span>{" "}
          · {data.count} {data.count === 1 ? "respondiente" : "respondientes"}
        </p>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="w-4 h-4" /> Descargar CSV
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 py-10 text-center text-neutral-400 text-sm">
          Todavía no hay respondientes con nota.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  <button
                    onClick={() => toggleSort("name")}
                    className="inline-flex items-center gap-1 hover:text-neutral-800"
                  >
                    Nombre
                    <ArrowUpDown
                      className={`w-3 h-3 ${
                        sortKey === "name" ? "text-neutral-700" : "text-neutral-300"
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
                    className="inline-flex items-center gap-1 hover:text-neutral-800"
                  >
                    %
                    <ArrowUpDown
                      className={`w-3 h-3 ${
                        sortKey === "percent"
                          ? "text-neutral-700"
                          : "text-neutral-300"
                      }`}
                    />
                  </button>
                </th>
                <th className="px-3 py-2 text-left font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => {
                const st = rowState(r);
                return (
                  <tr key={r.response_id} className="hover:bg-neutral-50/60">
                    <td className="px-3 py-2 font-medium text-neutral-800">
                      {r.name || "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">
                      {r.email || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-700">
                      {r.score != null && r.max_score != null
                        ? `${r.score} / ${r.max_score}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {r.percent != null ? (
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
