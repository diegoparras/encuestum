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
  EyeOff,
  Eye,
  FlaskConical,
  Trash2,
  History,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { surveyApi, SURVEY_ACCENT, type ResponseItem, type ResponseDeletion } from "./surveyApi";

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

/** Ancho de la columna de selección: entra en el cálculo de las fijadas. */
const SELECT_W = 42;

type Vista = "counted" | "all" | "excluded" | "test";

const VISTAS: { key: Vista; label: string }[] = [
  { key: "counted", label: "En resultados" },
  { key: "excluded", label: "Excluidas" },
  { key: "test", label: "De prueba" },
  { key: "all", label: "Todas" },
];

export function ResponsesPanel({
  responses,
  schema,
  accent = SURVEY_ACCENT,
  surveyId = "",
  canDelete = false,
  onReload,
}: {
  responses: ResponseItem[];
  schema: any;
  accent?: string;
  surveyId?: string;
  /** Borrar es irreversible: solo admins. */
  canDelete?: boolean;
  onReload?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [showSlicers, setShowSlicers] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [slice, setSlice] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vista, setVista] = useState<Vista>("counted");
  const [working, setWorking] = useState(false);
  const [showLog, setShowLog] = useState(false);
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

  // Conteos por vista (sobre el total, para que no bailen al cambiar de filtro).
  const conteos = useMemo(() => {
    const c = { all: responses.length, counted: 0, excluded: 0, test: 0 };
    for (const r of responses) {
      if (r.excluded) c.excluded++;
      if (r.is_test) c.test++;
      if (!r.excluded && !r.is_test) c.counted++;
    }
    return c;
  }, [responses]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return responses.filter((r) => {
      // Vista: qué subconjunto se está mirando.
      if (vista === "counted" && (r.excluded || r.is_test)) return false;
      if (vista === "excluded" && !r.excluded) return false;
      if (vista === "test" && !r.is_test) return false;
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
  }, [responses, query, activeSlices, identityOf, vista]);

  // La selección no debe arrastrar filas que dejaron de estar a la vista.
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedVisible = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds]
  );
  const allChecked = rows.length > 0 && selectedVisible.length === rows.length;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  }

  async function aplicar(action: "exclude" | "include" | "test" | "untest" | "delete") {
    if (working || selectedVisible.length === 0) return;
    const n = selectedVisible.length;
    if (action === "delete") {
      // Doble confirmación: es irreversible y no hay papelera de respuestas.
      const msg =
        `Vas a BORRAR ${n} ${n === 1 ? "respuesta" : "respuestas"} para siempre.\n\n` +
        `Esto no se puede deshacer. Si solo querés sacarlas de los resultados, ` +
        `usá "Excluir": se ocultan pero no se pierden.\n\n¿Borrar igual?`;
      if (!window.confirm(msg)) return;
    }
    setWorking(true);
    try {
      const res = await surveyApi.bulkResponses(surveyId, selectedVisible, action);
      const etiquetas: Record<string, string> = {
        exclude: "excluidas de los resultados",
        include: "devueltas a los resultados",
        test: "marcadas como prueba",
        untest: "desmarcadas",
        delete: "borradas",
      };
      toast.success(`${res.affected} ${res.affected === 1 ? "respuesta" : "respuestas"} ${etiquetas[action]}.`);
      setSelected(new Set());
      onReload?.();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo completar la acción.");
    } finally {
      setWorking(false);
    }
  }

  // Visibles, con las fijadas adelante en el orden en que se fijaron.
  const visible = useMemo(() => columns.filter((c) => !hidden.includes(c.name)), [columns, hidden]);
  const ordered = useMemo(() => {
    const pins = pinned
      .map((n) => visible.find((c) => c.name === n))
      .filter(Boolean) as Column[];
    return [...pins, ...visible.filter((c) => !pinned.includes(c.name))];
  }, [visible, pinned]);

  // Posición izquierda acumulada de cada columna fija. Arranca después de la
  // columna de selección, que también viaja pegada a la izquierda.
  const { offsets, pinnedWidth, lastPin } = useMemo(() => {
    const o: Record<string, number> = {};
    let x = SELECT_W;
    let last = "";
    for (const c of ordered) {
      if (pinned.includes(c.name)) {
        o[c.name] = x;
        x += c.width;
        last = c.name;
      }
    }
    return { offsets: o, pinnedWidth: x - SELECT_W, lastPin: last };
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
        style={{ tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0, width: totalWidth + SELECT_W }}
      >
        <thead>
          <tr>
            <th
              className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
              style={{ width: SELECT_W, position: "sticky", top: 0, left: 0, zIndex: 35 }}
            >
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
                aria-label="Seleccionar todas las visibles"
                className="h-3.5 w-3.5 align-middle"
              />
            </th>
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
          {rows.map((r, i) => {
            const fuera = r.excluded || r.is_test;
            const marcada = selected.has(r.id);
            return (
              <tr
                key={r.id}
                onClick={() => setOpenIdx(i)}
                title="Ver la ficha de esta persona"
                // Bandas de dos colores + realce al pasar por encima. Los colores
                // deben ser OPACOS: las celdas fijas heredan este fondo y, con
                // transparencia, el contenido que se desplaza se ve por debajo.
                className={`cursor-pointer ${
                  marcada
                    ? "bg-neutral-200 dark:bg-neutral-700"
                    : i % 2
                      ? "bg-neutral-50 dark:bg-[#1b1b1b]"
                      : "bg-white dark:bg-neutral-900"
                } hover:bg-neutral-100 dark:hover:bg-neutral-800`}
              >
                <td
                  className="border-b border-neutral-100 px-3 py-2 dark:border-neutral-800/70"
                  style={{
                    width: SELECT_W,
                    position: "sticky",
                    left: 0,
                    zIndex: 25,
                    backgroundColor: "inherit",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={marcada}
                    onChange={() => toggleRow(r.id)}
                    aria-label="Seleccionar esta respuesta"
                    className="h-3.5 w-3.5 align-middle"
                  />
                </td>
                {ordered.map((c, ci) => (
                  <td
                    key={c.name}
                    title={valueOf(r, c)}
                    className={`truncate border-b border-neutral-100 px-3 py-2 dark:border-neutral-800/70 ${
                      fuera
                        ? "text-neutral-400 line-through decoration-neutral-300 dark:text-neutral-500"
                        : "text-neutral-700 dark:text-neutral-300"
                    }`}
                    style={{ width: c.width, ...stickyStyle(c, false) }}
                  >
                    {/* La marca va en la primera celda, para que se lea al vuelo. */}
                    {ci === 0 && fuera && (
                      <span
                        className="mr-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 align-middle text-[10px] font-medium no-underline"
                        style={{
                          backgroundColor: r.is_test ? "#e0e7ff" : "#fee2e2",
                          color: r.is_test ? "#3730a3" : "#991b1b",
                        }}
                      >
                        {r.is_test ? <FlaskConical className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                        {r.is_test ? "prueba" : "excluida"}
                      </span>
                    )}
                    {valueOf(r, c)}
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

        {/* Vistas: qué subconjunto se está mirando */}
        <div className="inline-flex flex-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-950">
          {VISTAS.filter((v) => v.key === "counted" || v.key === "all" || conteos[v.key] > 0).map((v) => {
            const active = vista === v.key;
            return (
              <button
                key={v.key}
                onClick={() => setVista(v.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
                }`}
                style={active ? { color: accent } : undefined}
              >
                {v.label}
                <span className="ml-1 tabular-nums text-neutral-400">{conteos[v.key]}</span>
              </button>
            );
          })}
        </div>

        <span className="text-xs text-neutral-400">
          {rows.length} de {responses.length}
        </span>

        {canDelete && (
          <button
            onClick={() => setShowLog(true)}
            title="Ver el registro de borrados"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <History className="h-4 w-4" /> Borrados
          </button>
        )}

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

      {/* Barra de acciones: aparece al seleccionar filas */}
      {selectedVisible.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
          style={{ borderColor: accent, backgroundColor: `${accent}0f` }}
        >
          <span className="px-1 text-xs font-medium" style={{ color: accent }}>
            {selectedVisible.length} {selectedVisible.length === 1 ? "seleccionada" : "seleccionadas"}
          </span>
          <button
            onClick={() => aplicar("exclude")}
            disabled={working}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            <EyeOff className="h-3.5 w-3.5" /> Excluir
          </button>
          <button
            onClick={() => aplicar("include")}
            disabled={working}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            <Eye className="h-3.5 w-3.5" /> Incluir
          </button>
          <button
            onClick={() => aplicar("test")}
            disabled={working}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            <FlaskConical className="h-3.5 w-3.5" /> Marcar prueba
          </button>
          <button
            onClick={() => aplicar("untest")}
            disabled={working}
            className="rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            Desmarcar
          </button>

          {canDelete && (
            <button
              onClick={() => aplicar("delete")}
              disabled={working}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400"
            >
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Borrar
            </button>
          )}
          <button
            onClick={() => setSelected(new Set())}
            className={`text-xs font-medium text-neutral-500 underline hover:text-neutral-800 dark:text-neutral-400 ${canDelete ? "" : "ml-auto"}`}
          >
            Limpiar selección
          </button>
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

  const log = showLog ? (
    <DeletionsLog surveyId={surveyId} accent={accent} onClose={() => setShowLog(false)} />
  ) : null;

  if (fullscreen) {
    return (
      <>
        <div className="fixed inset-0 z-40 flex flex-col gap-3 bg-neutral-50 p-4 dark:bg-neutral-950">
          {toolbar}
          <div className="min-h-0 flex-1 overflow-hidden">{table}</div>
        </div>
        {ficha}
        {log}
      </>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}
      <div className="max-h-[70vh]">{table}</div>
      {ficha}
      {log}
    </div>
  );
}

/** Registro de borrados: quién sacó qué respuesta y cuándo. Solo admins. */
function DeletionsLog({
  surveyId,
  accent,
  onClose,
}: {
  surveyId: string;
  accent: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ResponseDeletion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    surveyApi
      .getDeletions(surveyId)
      .then((d) => !cancel && setRows(d))
      .catch((e) => !cancel && setError(e?.message || "No se pudo cargar el registro."));
    return () => {
      cancel = true;
    };
  }, [surveyId]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `${accent}1a`, color: accent }}
          >
            <History className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">Registro de borrados</h2>
            <p className="text-xs text-neutral-400">Borrar es irreversible: queda constancia de quién lo hizo.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : rows === null ? (
            <p className="flex items-center gap-2 text-sm text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
            </p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-400">
              Todavía no se borró ninguna respuesta de esta encuesta.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {rows.map((d) => (
                <li key={d.id} className="py-2.5">
                  <p className="text-sm text-neutral-800 dark:text-neutral-200">
                    {d.respondent || "Anónimo"}
                  </p>
                  <p className="text-xs text-neutral-400">
                    Borrada por {d.deleted_by_email || "—"} ·{" "}
                    {new Date(d.deleted_at).toLocaleString()}
                    {d.submitted_at
                      ? ` · respondida el ${new Date(d.submitted_at).toLocaleDateString()}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
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
