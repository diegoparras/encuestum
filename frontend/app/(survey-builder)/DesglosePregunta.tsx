"use client";

import React from "react";
import { Check } from "lucide-react";

export interface OpcionContada {
  value: string;
  count: number;
  correct: boolean;
}

/** Qué contestaron, para una pregunta de la tabla de correcciones.
 *
 * La tabla dice "0% de acierto" y ahí se corta; la pregunta que sigue siempre es
 * la misma -- ¿y qué contestaron entonces? Hasta acá había que ir a mirar
 * respuesta por respuesta.
 *
 * Va anclado con `position: fixed` a propósito: la tabla vive dentro de un
 * contenedor con `overflow`, y un panel absoluto se recortaría contra su borde. */
export function DesglosePregunta({
  titulo,
  opciones,
  ancla,
}: {
  titulo: string;
  opciones: OpcionContada[];
  ancla: DOMRect;
}) {
  if (!opciones.length) return null;

  const total = opciones.reduce((a, o) => a + o.count, 0) || 1;
  const MARGEN = 12;
  // En una ventana angosta manda la ventana, no el ancho ideal.
  const ancho = Math.min(300, Math.max(200, window.innerWidth - MARGEN * 2));
  // Pegado al borde izquierdo de la fila, sin pasarse de la ventana. El piso va
  // AFUERA: al revés, una ventana más angosta que el panel lo mandaba a una
  // posición negativa, o sea fuera de la pantalla.
  const left = Math.max(
    MARGEN,
    Math.min(ancla.left + 24, window.innerWidth - ancho - MARGEN)
  );
  // Debajo de la fila, salvo que no entre: ahí va arriba.
  const alto = 56 + opciones.length * 26;
  const abajo = ancla.bottom + 8;
  const top =
    abajo + alto > window.innerHeight - MARGEN
      ? Math.max(MARGEN, ancla.top - alto - 8)
      : abajo;

  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-xl border border-neutral-200 bg-white p-3 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      style={{ left, top, width: ancho }}
    >
      <p className="mb-2 line-clamp-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        Qué contestaron
      </p>
      <p className="mb-2.5 line-clamp-2 text-xs text-neutral-600 dark:text-neutral-300">{titulo}</p>
      <div className="space-y-1.5">
        {opciones.map((o) => {
          const pct = Math.round((o.count / total) * 100);
          return (
            <div key={o.value} className="flex items-center gap-2">
              <span
                className={`flex-1 truncate text-xs ${
                  o.correct
                    ? "font-medium text-emerald-700 dark:text-emerald-400"
                    : "text-neutral-600 dark:text-neutral-300"
                }`}
                title={o.value}
              >
                {o.correct && <Check className="mr-0.5 inline h-3 w-3" />}
                {o.value}
              </span>
              {/* La barra da la proporción de un vistazo; el número, el dato. */}
              <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <span
                  className={`block h-full rounded-full ${
                    o.correct ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                {o.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
