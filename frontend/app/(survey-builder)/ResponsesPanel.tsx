"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  X,
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronRight,
  User,
} from "lucide-react";
import { SURVEY_ACCENT, type ResponseItem } from "./surveyApi";

/**
 * Tabla de respuestas: una fila por persona, una columna por pregunta.
 *
 * Usa los TÍTULOS reales de las preguntas (antes se veían los nombres internos
 * tipo `radiogroup_1`), permite pantalla completa para encuestas anchas, y
 * abre una ficha por persona con todas sus respuestas y navegación ‹ ›.
 */

interface Column {
  name: string;
  title: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const strip = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Columnas en el orden del formulario; las claves sueltas van al final. */
function buildColumns(schema: any, responses: ResponseItem[]): Column[] {
  const cols: Column[] = [];
  const seen = new Set<string>();
  for (const page of schema?.pages ?? []) {
    for (const el of page?.elements ?? []) {
      const name = el?.name;
      if (!name || seen.has(name)) continue;
      if (["html", "image", "expression"].includes(el?.type)) continue;
      if (name.endsWith("__img") || name.endsWith("__vid")) continue;
      seen.add(name);
      cols.push({ name, title: el?.title || name });
    }
  }
  // Respuestas de preguntas que ya no están en el formulario: no se pierden.
  for (const r of responses) {
    for (const k of Object.keys(r.answers || {})) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push({ name: k, title: k });
      }
    }
  }
  return cols;
}

/** Qué preguntas identifican a la persona (mismo criterio que el backend). */
function identityCols(cols: Column[]): { nameCol?: string; emailCol?: string } {
  let nameCol: string | undefined;
  let emailCol: string | undefined;
  for (const c of cols) {
    const t = strip(c.title);
    if (!emailCol && /\b(mail|e-?mail|correo)\b/.test(t)) emailCol = c.name;
    else if (!nameCol && /\b(nombre|apellido|name)\b/.test(t)) nameCol = c.name;
  }
  return { nameCol, emailCol };
}

function cellText(value: any): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ResponsesPanel({
  responses,
  schema,
  accent = SURVEY_ACCENT,
}: {
  responses: ResponseItem[];
  schema: any;
  accent?: string;
}) {
  const [query, setQuery] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const columns = useMemo(() => buildColumns(schema, responses), [schema, responses]);
  const { nameCol, emailCol } = useMemo(() => identityCols(columns), [columns]);

  // Columnas de preguntas, sin las que ya se muestran como identidad.
  const questionCols = useMemo(
    () => columns.filter((c) => c.name !== nameCol && c.name !== emailCol),
    [columns, nameCol, emailCol]
  );

  const identityOf = useCallback(
    (r: ResponseItem) => {
      const a = r.answers || {};
      const name = nameCol ? cellText(a[nameCol]) : "—";
      let email = emailCol ? cellText(a[emailCol]) : "—";
      if (email === "—") {
        const hit = Object.values(a).find(
          (v) => typeof v === "string" && EMAIL_RE.test(v.trim())
        );
        if (hit) email = String(hit).trim();
      }
      return { name, email };
    },
    [nameCol, emailCol]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return responses;
    return responses.filter((r) => {
      const { name, email } = identityOf(r);
      if (name.toLowerCase().includes(q) || email.toLowerCase().includes(q)) return true;
      // También busca dentro de las respuestas.
      return Object.values(r.answers || {}).some((v) =>
        cellText(v).toLowerCase().includes(q)
      );
    });
  }, [responses, query, identityOf]);

  // En pantalla completa, congelamos el scroll del fondo: si no, la rueda del
  // mouse mueve la página de atrás y queda el hueco de su barra de scroll.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // Escape sale de pantalla completa / cierra la ficha.
  useEffect(() => {
    if (!fullscreen && openIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (openIdx !== null) setOpenIdx(null);
        else setFullscreen(false);
      }
      if (openIdx !== null && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        setOpenIdx((i) => {
          if (i === null) return i;
          const next = e.key === "ArrowLeft" ? i - 1 : i + 1;
          return next >= 0 && next < rows.length ? next : i;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, openIdx, rows.length]);

  const table = (
    <div className="overflow-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10 bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Fecha</th>
            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Nombre</th>
            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Email</th>
            {questionCols.map((c) => (
              <th
                key={c.name}
                className="max-w-[280px] truncate px-3 py-2 text-left font-medium"
                title={c.title}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map((r, i) => {
            const { name, email } = identityOf(r);
            return (
              <tr
                key={r.id}
                onClick={() => setOpenIdx(i)}
                className="cursor-pointer hover:bg-neutral-50/70 dark:hover:bg-neutral-800/40"
                title="Ver la ficha de esta persona"
              >
                <td className="whitespace-nowrap px-3 py-2 text-neutral-400 dark:text-neutral-500">
                  {new Date(r.submitted_at).toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-medium text-neutral-800 dark:text-neutral-200">
                  {name}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-500 dark:text-neutral-400">
                  {email}
                </td>
                {questionCols.map((c) => (
                  <td
                    key={c.name}
                    className="max-w-[320px] truncate px-3 py-2 align-top text-neutral-700 dark:text-neutral-300"
                    title={cellText(r.answers?.[c.name])}
                  >
                    {cellText(r.answers?.[c.name])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar en las respuestas…"
          aria-label="Buscar en las respuestas"
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
      <span className="text-xs text-neutral-400">
        {rows.length} de {responses.length}
      </span>
      <button
        onClick={() => setFullscreen((v) => !v)}
        className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {fullscreen ? (
          <>
            <Minimize2 className="h-4 w-4" /> Salir de pantalla completa
          </>
        ) : (
          <>
            <Maximize2 className="h-4 w-4" /> Pantalla completa
          </>
        )}
      </button>
    </div>
  );

  const ficha =
    openIdx !== null && rows[openIdx] ? (
      <RespondentCard
        response={rows[openIdx]}
        columns={columns}
        identity={identityOf(rows[openIdx])}
        index={openIdx}
        total={rows.length}
        accent={accent}
        onClose={() => setOpenIdx(null)}
        onPrev={() => setOpenIdx((i) => (i !== null && i > 0 ? i - 1 : i))}
        onNext={() => setOpenIdx((i) => (i !== null && i < rows.length - 1 ? i + 1 : i))}
      />
    ) : null;

  if (fullscreen) {
    return (
      <>
        <div className="fixed inset-0 z-40 flex flex-col gap-3 bg-neutral-50 p-4 dark:bg-neutral-950">
          {toolbar}
          <div className="min-h-0 flex-1 overflow-hidden">{table}</div>
        </div>
        {ficha}
      </>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}
      {table}
      {ficha}
    </div>
  );
}

/** Ficha de una persona: todas sus respuestas, con navegación entre respondentes. */
function RespondentCard({
  response,
  columns,
  identity,
  index,
  total,
  accent,
  onClose,
  onPrev,
  onNext,
}: {
  response: ResponseItem;
  columns: Column[];
  identity: { name: string; email: string };
  index: number;
  total: number;
  accent: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  // Corrección por pregunta, si la encuesta es una evaluación.
  const byQuestion: Record<string, any> = {};
  for (const q of (response.grade as any)?.questions ?? []) {
    if (q?.name) byQuestion[q.name] = q;
  }
  const percent = (response.grade as any)?.percent;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `${accent}1a`, color: accent }}
          >
            <User className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-neutral-900 dark:text-neutral-100">
              {identity.name !== "—" ? identity.name : "Anónimo"}
            </h2>
            <p className="truncate text-xs text-neutral-400">
              {identity.email !== "—" ? `${identity.email} · ` : ""}
              {new Date(response.submitted_at).toLocaleString()}
            </p>
          </div>
          {response.max_score != null && Number(response.max_score) > 0 && (
            <span
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{ backgroundColor: `${accent}1a`, color: accent }}
            >
              {response.score} / {response.max_score}
              {percent != null ? ` · ${percent}%` : ""}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {columns.map((c) => {
            const g = byQuestion[c.name];
            return (
              <div key={c.name}>
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  {c.title}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">
                  {cellText(response.answers?.[c.name])}
                </p>
                {g && (
                  <p className="mt-1 text-xs text-neutral-400">
                    {g.awarded} / {g.points} pts
                    {g.feedback ? ` · ${g.feedback}` : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
          <button
            onClick={onPrev}
            disabled={index === 0}
            className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <ChevronLeft className="h-4 w-4" /> Anterior
          </button>
          <span className="text-xs text-neutral-400">
            {index + 1} de {total}
          </span>
          <button
            onClick={onNext}
            disabled={index >= total - 1}
            className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Siguiente <ChevronRight className="h-4 w-4" />
          </button>
        </footer>
      </div>
    </div>
  );
}
