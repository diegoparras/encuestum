"use client";

import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Layers,
  MoreVertical,
  Palette,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { surveyApi, SURVEY_ACCENT, type Folder } from "./surveyApi";

/**
 * Árbol de carpetas del listado de encuestas.
 *
 * Arrastrar una encuesta sobre una carpeta la mueve (HTML5 nativo: no hace
 * falta el peso de una librería para arrastrar una fila a un destino).
 *
 * "Todas" y "Sin clasificar" no son carpetas: son vistas. La primera muestra
 * todo; la segunda, lo que todavía no se ordenó — que es a dónde van a parar
 * las encuestas cuando se borra la carpeta que las contenía.
 */

export const SIN_CLASIFICAR = "__none__";
export const TODAS = "__all__";

const COLOR_POR_DEFECTO = SURVEY_ACCENT;

interface Props {
  folders: Folder[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  /** Cuántas encuestas hay sin carpeta (para el contador de "Sin clasificar"). */
  looseCount: number;
  totalCount: number;
}

export function FolderTree({
  folders,
  selected,
  onSelect,
  onChanged,
  looseCount,
  totalCount,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hijasDe = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const k = f.parent_id;
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    return m;
  }, [folders]);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function crear(parentId: string | null) {
    const nombre = window.prompt(
      parentId ? "Nombre de la subcarpeta" : "Nombre de la carpeta"
    );
    if (!nombre?.trim()) return;
    try {
      await surveyApi.createFolder({
        name: nombre.trim(),
        parent_id: parentId,
        color: COLOR_POR_DEFECTO,
      });
      if (parentId) setOpen((p) => new Set(p).add(parentId));
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo crear la carpeta.");
    }
  }

  async function renombrar(f: Folder) {
    const nombre = window.prompt("Nuevo nombre", f.name);
    if (!nombre?.trim() || nombre.trim() === f.name) return;
    try {
      await surveyApi.updateFolder(f.id, { name: nombre.trim() });
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo renombrar.");
    }
  }

  async function recolorear(f: Folder, color: string) {
    try {
      await surveyApi.updateFolder(f.id, { color });
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo cambiar el color.");
    }
  }

  async function borrar(f: Folder) {
    const msg =
      `¿Borrar la carpeta "${f.name}"?\n\n` +
      `Las encuestas que contenga NO se borran: quedan un nivel más arriba. ` +
      `Sus subcarpetas también suben.`;
    if (!window.confirm(msg)) return;
    try {
      await surveyApi.deleteFolder(f.id);
      if (selected === f.id) onSelect(null);
      onChanged();
      toast.success("Carpeta borrada. Su contenido subió un nivel.");
    } catch (e: any) {
      toast.error(e?.message || "No se pudo borrar la carpeta.");
    }
  }

  async function soltar(e: React.DragEvent, destino: string | null) {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData("text/survey-id");
    if (!id || busy) return;
    setBusy(true);
    try {
      await surveyApi.moveSurveys([id], destino);
      onChanged();
      toast.success(destino ? "Encuesta movida." : "Encuesta sin clasificar.");
    } catch (err: any) {
      toast.error(err?.message || "No se pudo mover la encuesta.");
    } finally {
      setBusy(false);
    }
  }

  const dropProps = (destino: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((d) => (d === key ? null : d)),
    onDrop: (e: React.DragEvent) => soltar(e, destino),
  });

  function Rama({ f, nivel }: { f: Folder; nivel: number }) {
    const hijas = hijasDe.get(f.id) ?? [];
    const abierta = open.has(f.id);
    const activa = selected === f.id;
    const resaltada = dropTarget === f.id;
    return (
      <div>
        <div
          {...dropProps(f.id, f.id)}
          className={`group flex items-center gap-1 rounded-lg pr-1 ${
            activa ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
          } ${resaltada ? "ring-2" : ""}`}
          style={{
            paddingLeft: 4 + nivel * 12,
            ...(resaltada ? { boxShadow: `inset 0 0 0 2px ${f.color || COLOR_POR_DEFECTO}` } : {}),
          }}
        >
          <button
            onClick={() => toggle(f.id)}
            aria-label={abierta ? "Contraer" : "Expandir"}
            className={`grid h-5 w-5 shrink-0 place-items-center rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 ${
              hijas.length ? "" : "invisible"
            }`}
          >
            {abierta ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => onSelect(f.id)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm"
          >
            <FolderIcon
              className="h-4 w-4 shrink-0"
              style={{ color: f.color || COLOR_POR_DEFECTO }}
            />
            <span className={`truncate ${activa ? "font-medium" : ""}`}>{f.name}</span>
            {f.survey_count > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-xs text-neutral-400">
                {f.survey_count}
              </span>
            )}
          </button>
          <MenuCarpeta
            folder={f}
            onRename={() => renombrar(f)}
            onColor={(c) => recolorear(f, c)}
            onSub={() => crear(f.id)}
            onDelete={() => borrar(f)}
          />
        </div>
        {abierta && hijas.map((h) => <Rama key={h.id} f={h} nivel={nivel + 1} />)}
      </div>
    );
  }

  const raiz = hijasDe.get(null) ?? [];

  return (
    <aside className="w-full shrink-0 sm:w-56">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Carpetas
        </span>
        <button
          onClick={() => crear(null)}
          title="Nueva carpeta"
          aria-label="Nueva carpeta"
          className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-0.5">
        <button
          onClick={() => onSelect(TODAS)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
            selected === TODAS || selected === null
              ? "bg-neutral-100 font-medium dark:bg-neutral-800"
              : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
          }`}
        >
          <Layers className="h-4 w-4 shrink-0 text-neutral-400" />
          Todas
          <span className="ml-auto tabular-nums text-xs text-neutral-400">{totalCount}</span>
        </button>

        <button
          {...dropProps(null, SIN_CLASIFICAR)}
          onClick={() => onSelect(SIN_CLASIFICAR)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
            selected === SIN_CLASIFICAR
              ? "bg-neutral-100 font-medium dark:bg-neutral-800"
              : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
          }`}
          style={
            dropTarget === SIN_CLASIFICAR
              ? { boxShadow: `inset 0 0 0 2px ${COLOR_POR_DEFECTO}` }
              : undefined
          }
        >
          <Inbox className="h-4 w-4 shrink-0 text-neutral-400" />
          Sin clasificar
          <span className="ml-auto tabular-nums text-xs text-neutral-400">{looseCount}</span>
        </button>

        {raiz.map((f) => (
          <Rama key={f.id} f={f} nivel={0} />
        ))}

        {folders.length === 0 && (
          <p className="px-2 py-3 text-xs leading-relaxed text-neutral-400">
            Creá una carpeta y arrastrá encuestas para ordenarlas.
          </p>
        )}
      </div>
    </aside>
  );
}

/** Menú por carpeta: renombrar, color, subcarpeta y borrar. */
function MenuCarpeta({
  folder,
  onRename,
  onColor,
  onSub,
  onDelete,
}: {
  folder: Folder;
  onRename: () => void;
  onColor: (color: string) => void;
  onSub: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Opciones de ${folder.name}`}
        className="grid h-6 w-6 place-items-center rounded text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-48 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            <button
              onClick={() => { setOpen(false); onRename(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <Pencil className="h-3.5 w-3.5" /> Renombrar
            </button>
            <button
              onClick={() => { setOpen(false); onSub(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <FolderPlus className="h-3.5 w-3.5" /> Nueva subcarpeta
            </button>
            {/* Color libre: el selector nativo, no una paleta cerrada. */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
              <Palette className="h-3.5 w-3.5" /> Color
              <input
                type="color"
                value={folder.color || COLOR_POR_DEFECTO}
                onChange={(e) => onColor(e.target.value)}
                aria-label={`Color de ${folder.name}`}
                className="ml-auto h-5 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </label>
            <div className="my-1 h-px bg-neutral-100 dark:bg-neutral-800" />
            <button
              onClick={() => { setOpen(false); onDelete(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-3.5 w-3.5" /> Borrar carpeta
            </button>
          </div>
        </>
      )}
    </div>
  );
}
