"use client";

import React, { useEffect, useRef } from "react";
import { AlertTriangle, EyeOff, Trash2, X } from "lucide-react";

interface Props {
  cantidad: number;
  trabajando: boolean;
  onCancelar: () => void;
  onExcluir: () => void;
  onBorrar: () => void;
}

/** Confirmación de borrado de respuestas.
 *
 * Reemplaza a un `window.confirm`. El cambio no es sólo estético: el texto del
 * confirm decía "si sólo querés sacarlas de los resultados, usá Excluir", un
 * consejo que obligaba a cancelar, buscar el otro botón y volver a empezar.
 * Acá esa salida es un botón: la alternativa segura está a un clic, en el mismo
 * lugar donde la persona está dudando.
 *
 * Borrar es lo único irreversible del panel y no hay papelera de respuestas, así
 * que el botón rojo queda apartado del resto y nunca toma el foco inicial. */
export function ConfirmarBorrado({ cantidad, trabajando, onCancelar, onExcluir, onBorrar }: Props) {
  const cancelar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelar.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelar();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancelar]);

  const plural = cantidad === 1 ? "respuesta" : "respuestas";

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4"
      onClick={onCancelar}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="borrado-titulo"
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pb-4 pt-5">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-red-100 dark:bg-red-950/50">
            <AlertTriangle className="h-[18px] w-[18px] text-red-600 dark:text-red-400" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="borrado-titulo"
              className="text-base font-semibold text-neutral-900 dark:text-neutral-100"
            >
              Borrar {cantidad} {plural}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
              Se {cantidad === 1 ? "va" : "van"} para siempre. No hay papelera de
              respuestas: esto no se puede deshacer.
            </p>
          </div>
          <button
            onClick={onCancelar}
            aria-label="Cerrar"
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* La salida segura, como acción y no como consejo. */}
        <div className="mx-5 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5 dark:border-neutral-800 dark:bg-neutral-950/60">
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {cantidad === 1
              ? "Excluirla la saca de los resultados sin perderla, y podés revertirlo cuando quieras."
              : "Excluirlas las saca de los resultados sin perderlas, y podés revertirlo cuando quieras."}
          </p>
          <button
            onClick={onExcluir}
            disabled={trabajando}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            <EyeOff className="h-3.5 w-3.5" /> Mejor excluir{cantidad === 1 ? "la" : "las"}
          </button>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <button
            ref={cancelar}
            onClick={onCancelar}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Cancelar
          </button>
          <button
            onClick={onBorrar}
            disabled={trabajando}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Borrar para siempre
          </button>
        </div>
      </div>
    </div>
  );
}
