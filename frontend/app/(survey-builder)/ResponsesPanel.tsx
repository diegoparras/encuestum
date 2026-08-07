"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  X,
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  User,
  Filter,
  Columns3,
  Pin,
  AlertTriangle,
} from "lucide-react";
import { SURVEY_ACCENT, type ResponseItem } from "./surveyApi";

/**
 * Tabla de respuestas: una fila por persona, una columna por pregunta.
 *
 * Usa los TÍTULOS reales de las preguntas (antes se veían los nombres internos
 * tipo `radiogroup_1`) y suma tres cosas para encuestas anchas: bandas de dos
 * colores, slicers por pregunta de opción (estilo Excel) y un selector de
 * columnas donde cada una se puede ocultar o fijar a la izquierda.
 *
 * Lo elegido se recuerda por encuesta en el navegador.
 */

interface Column {
  name: string;
  title: string;
  type: string;
  width: number;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Las columnas fijas necesitan ancho conocido para calcular su posición, así que
// el ancho lo define el tipo de pregunta. El texto se corta con "…" y el valor
// completo queda en el tooltip.
const WIDTHS: Record<string, number> = {
  boolean: 110,
  rating: 100,
  date: 130,
  dropdown: 180,
  radiogroup: 200,
  checkbox: 220,
  ranking: 220,
  comment: 280,
};
const DEFAULT_WIDTH = 200;
const META_WIDTHS = { fecha: 150, nombre: 170, email: 220 };

/** Preguntas que sirven de slicer: categóricas de pocos valores. */
const SLICEABLE = new Set(["radiogroup", "dropdown", "boolean", "imagepicker"]);

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
      cols.push({
        name,
        title: el?.title || name,
        type: el?.type || "text",
        width: WIDTHS[el?.type] ?? DEFAULT_WIDTH,
      });
    }
  }
  // Respuestas de preguntas que ya no están en el formulario: no se pierden.
  for (const r of responses) {
    for (const k of Object.keys(r.answers || {})) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push({ name: k, title: k, type: "text", width: DEFAULT_WIDTH });
      }
    }
  }
  return cols;
}

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
  // Las preguntas Sí/No llegan como booleano: "true"/"false" no se lee.
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Preferencias por encuesta (columnas ocultas / fijadas). */
function usePrefs(surveyKey: string) {
  const storageKey = `encuestum.responses.${surveyKey}`;
  const [hidden, setHidden] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw);
        setHidden(Array.isArray(p.hidden) ? p.hidden : []);
        setPinned(Array.isArray(p.pinned) ? p.pinned : []);
      } else {
        setHidden([]);
        setPinned([]);
      }
    } catch {
      /* storage no disponible */
    }
    loaded.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ hidden, pinned }));
    } catch {
      /* ignore */
    }
  }, [storageKey, hidden, pinned]);

  return { hidden, setHidden, pinned, setPinned };
}

export function ResponsesPanel({
  responses,
  schema,
  accent = SURVEY_ACCENT,
  surveyId = "",
}: {
  responses: ResponseItem[];
  schema: any;
  accent?: string;
  surveyId?: string;
}) {
  const [query, setQuery] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [showSlicers, setShowSlicers] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [slice, setSlice] = useState<Record<string, string[]>>({});
  const { hidden, setHidden, pinned, setPinned } = usePrefs(surveyId);

  const allColumns = useMemo(() => buildColumns(schema, responses), [schema, responses]);
  const { nameCol, emailCol } = useMemo(() => identityCols(allColumns), [allColumns]);

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

  // Nombre y Email como columnas propias; se ocultan solas si están vacías en
  // TODAS las filas (una encuesta que no los pregunta no debe gastar dos columnas).
  const hasName = useMemo(
    () => responses.some((r) => identityOf(r).name !== "—"),
    [responses, identityOf]
  );
  const hasEmail = useMemo(
    () => responses.some((r) => identityOf(r).email !== "—"),
    [responses, identityOf]
  );

  // Columnas de la tabla: meta (fecha/nombre/email) + preguntas.
  const columns = useMemo<Column[]>(() => {
    const meta: Column[] = [{ name: "__date", title: "Fecha", type: "__meta", width: META_WIDTHS.fecha }];
    if (hasName) meta.push({ name: "__name", title: "Nombre", type: "__meta", width: META_WIDTHS.nombre });
    if (hasEmail) meta.push({ name: "__email", title: "Email", type: "__meta", width: META_WIDTHS.email });
    // Las preguntas que ya se muestran como identidad no se repiten.
    const qs = allColumns.filter(
      (c) => !(hasName && c.name === nameCol) && !(hasEmail && c.name === emailCol)
    );
    return [...meta, ...qs];
  }, [allColumns, hasName, hasEmail, nameCol, emailCol]);

  const valueOf = useCallback(
    (r: ResponseItem, col: Column): string => {
      if (col.name === "__date") return new Date(r.submitted_at).toLocaleString();
      if (col.name === "__name") return identityOf(r).name;
      if (col.name === "__email") return identityOf(r).email;
      return cellText(r.answers?.[col.name]);
    },
    [identityOf]
  );

  // Slicers: una tarjeta por pregunta categórica, con el conteo de cada valor.
  const slicers = useMemo(() => {
    return allColumns
      .filter((c) => SLICEABLE.has(c.type) && c.name !== nameCol && c.name !== emailCol)
      .map((c) => {
        const counts = new Map<string, number>();
        for (const r of responses) {
          const v = cellText(r.answers?.[c.name]);
          if (v === "—") continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return { col: c, values: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
      })
      .filter((s) => s.values.length > 0);
  }, [allColumns, responses, nameCol, emailCol]);

  const activeSlices = useMemo(
    () => Object.entries(slice).filter(([, vs]) => vs.length > 0),
    [slice]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return responses.filter((r) => {
      // Varios valores en el mismo slicer suman (OR); entre slicers se cruzan (AND).
      for (const [name, vs] of activeSlices) {
        if (!vs.includes(cellText(r.answers?.[name]))) return false;
      }
      if (!q) return true;
      const { name, email } = identityOf(r);
      if (name.toLowerCase().includes(q) || email.toLowerCase().includes(q)) return true;
      return Object.values(r.answers || {}).some((v) =>
        cellText(v).toLowerCase().includes(q)
      );
    });
  }, [responses, query, activeSlices, identityOf]);

  // Visibles, con las fijadas adelante en el orden en que se fijaron.
  const visible = useMemo(() => columns.filter((c) => !hidden.includes(c.name)), [columns, hidden]);
  const ordered = useMemo(() => {
    const pins = pinned
      .map((n) => visible.find((c) => c.name === n))
      .filter(Boolean) as Column[];
    return [...pins, ...visible.filter((c) => !pinned.includes(c.name))];
  }, [visible, pinned]);

  // Posición izquierda acumulada de cada columna fija.
  const { offsets, pinnedWidth, lastPin } = useMemo(() => {
    const o: Record<string, number> = {};
    let x = 0;
    let last = "";
    for (const c of ordered) {
      if (pinned.includes(c.name)) {
        o[c.name] = x;
        x += c.width;
        last = c.name;
      }
    }
    return { offsets: o, pinnedWidth: x, lastPin: last };
  }, [ordered, pinned]);

  const totalWidth = useMemo(() => visible.reduce((a, c) => a + c.width, 0), [visible]);
  const tooMuchPinned = pinnedWidth > totalWidth * 0.5 && pinnedWidth > 0;

  function toggleSlice(name: string, value: string) {
    setSlice((prev) => {
      const cur = prev[name] ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [name]: next };
    });
  }
  function toggleHidden(name: string) {
    setHidden((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      // Ocultar una columna la desfija: no tiene sentido clavar algo invisible.
      if (!prev.includes(name)) setPinned((p) => p.filter((n) => n !== name));
      return next;
    });
  }
  function togglePinned(name: string) {
    if (hidden.includes(name)) return;
    setPinned((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }
  const clearFilters = () => {
    setSlice({});
    setQuery("");
  };

  // En pantalla completa, congelamos el scroll del fondo.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // Escape cierra; flechas navegan entre fichas.
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

  const stickyStyle = (c: Column, isHeader: boolean): React.CSSProperties => {
    if (!pinned.includes(c.name)) return {};
    return {
      position: "sticky",
      left: offsets[c.name],
      // Las celdas fijas necesitan fondo propio: si no, el contenido que se
      // desplaza se ve por debajo. `inherit` toma el color de la fila (bandas).
      backgroundColor: isHeader ? undefined : "inherit",
      zIndex: isHeader ? 30 : 20,
      boxShadow: c.name === lastPin ? "1px 0 0 0 rgba(0,0,0,0.08)" : undefined,
    };
  };

  const table = (
    <div className="h-full overflow-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <table
        className="text-sm"
        style={{ tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0, width: totalWidth }}
      >
        <thead>
          <tr>
            {ordered.map((c) => (
              <th
                key={c.name}
                title={c.title}
                className="truncate border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-left font-medium text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400"
                style={{
                  width: c.width,
                  position: "sticky",
                  top: 0,
                  ...stickyStyle(c, true),
                  zIndex: pinned.includes(c.name) ? 30 : 25,
                }}
              >
                {pinned.includes(c.name) && (
                  <Pin className="mr-1 inline h-3 w-3 shrink-0" style={{ color: accent }} />
                )}
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.id}
              onClick={() => setOpenIdx(i)}
              title="Ver la ficha de esta persona"
              // Bandas de dos colores + realce al pasar por encima. Los colores
              // deben ser OPACOS: las celdas fijas heredan este fondo y, con
              // transparencia, el contenido que se desplaza se ve por debajo.
              className={`cursor-pointer ${
                i % 2
                  ? "bg-neutral-50 dark:bg-[#1b1b1b]"
                  : "bg-white dark:bg-neutral-900"
              } hover:bg-neutral-100 dark:hover:bg-neutral-800`}
            >
              {ordered.map((c) => (
                <td
                  key={c.name}
                  title={valueOf(r, c)}
                  className="truncate border-b border-neutral-100 px-3 py-2 text-neutral-700 dark:border-neutral-800/70 dark:text-neutral-300"
                  style={{ width: c.width, ...stickyStyle(c, false) }}
                >
                  {valueOf(r, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const toolbar = (
    <div className="space-y-2">
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

        {slicers.length > 0 && (
          <button
            onClick={() => setShowSlicers((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium"
            style={
              showSlicers || activeSlices.length
                ? { borderColor: accent, color: accent, backgroundColor: `${accent}12` }
                : undefined
            }
          >
            <Filter className="h-4 w-4" /> Slicers
            {activeSlices.length > 0 && (
              <span className="tabular-nums">{activeSlices.length}</span>
            )}
          </button>
        )}

        <div className="relative">
          <button
            onClick={() => setShowCols((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Columns3 className="h-4 w-4" /> Columnas
            <span className="tabular-nums text-neutral-400">
              {visible.length}/{columns.length}
            </span>
            <ChevronDown className="h-3 w-3 text-neutral-400" />
          </button>
          {showCols && (
            <>
              {/* Capa para cerrar al hacer clic afuera */}
              <div className="fixed inset-0 z-40" onClick={() => setShowCols(false)} />
              <div className="absolute right-0 z-50 mt-1.5 max-h-80 w-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
                  <span className="text-[11px] text-neutral-400">Mostrar</span>
                  <span className="text-[11px] text-neutral-400">Fijar</span>
                </div>
                {columns.map((c) => {
                  const isHidden = hidden.includes(c.name);
                  const isPinned = pinned.includes(c.name);
                  return (
                    <div key={c.name} className="flex items-center gap-2 rounded-md px-2 py-1">
                      <input
                        type="checkbox"
                        checked={!isHidden}
                        onChange={() => toggleHidden(c.name)}
                        aria-label={`Mostrar ${c.title}`}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${
                          isHidden ? "text-neutral-400" : "text-neutral-700 dark:text-neutral-300"
                        }`}
                        title={c.title}
                      >
                        {c.title}
                      </span>
                      <button
                        onClick={() => togglePinned(c.name)}
                        disabled={isHidden}
                        aria-label={`Fijar ${c.title}`}
                        aria-pressed={isPinned}
                        className="grid h-6 w-7 shrink-0 place-items-center rounded-md border disabled:opacity-30"
                        style={
                          isPinned
                            ? { borderColor: accent, color: accent, backgroundColor: `${accent}12` }
                            : { borderColor: "transparent", color: "#a3a3a3" }
                        }
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <span className="text-xs text-neutral-400">
          {rows.length} de {responses.length}
        </span>

        {(activeSlices.length > 0 || query) && (
          <button
            onClick={clearFilters}
            className="text-xs font-medium text-neutral-500 underline hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Limpiar filtros
          </button>
        )}

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

      {showSlicers && slicers.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {slicers.map((s) => (
            <div
              key={s.col.name}
              className="rounded-lg bg-neutral-50 p-2.5 dark:bg-neutral-900/60"
            >
              <p className="mb-1.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400" title={s.col.title}>
                {s.col.title}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {s.values.map(([v, n]) => {
                  const on = (slice[s.col.name] ?? []).includes(v);
                  return (
                    <button
                      key={v}
                      onClick={() => toggleSlice(s.col.name, v)}
                      aria-pressed={on}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                      style={
                        on
                          ? { borderColor: accent, color: accent, backgroundColor: `${accent}18` }
                          : { borderColor: "#d4d4d4" }
                      }
                    >
                      <span className="truncate">{v}</span>
                      <span className="tabular-nums text-neutral-400">{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {tooMuchPinned && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Fijaste casi todo el ancho: queda poco espacio para desplazarte.
        </div>
      )}
    </div>
  );

  const ficha =
    openIdx !== null && rows[openIdx] ? (
      <RespondentCard
        response={rows[openIdx]}
        columns={allColumns}
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
      <div className="max-h-[70vh]">{table}</div>
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
