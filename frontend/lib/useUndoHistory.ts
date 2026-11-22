"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Deshacer / rehacer sobre un estado inmutable, sin tocar cada mutación.
 *
 * Observa los cambios de `state`: cada vez que cambia (y no lo cambió un
 * deshacer/rehacer) apila la versión anterior. Los cambios seguidos dentro de
 * `coalesceMs` (escribir un título letra por letra) se agrupan en un solo
 * paso, así un Ctrl+Z deshace la palabra y no la última letra.
 *
 * `reset()` limpia la historia: se llama al cargar o recargar la encuesta, para
 * que "deshacer" nunca vuelva a un estado de antes de la carga.
 */
export function useUndoHistory<T>(
  state: T | null,
  setState: (s: T) => void,
  {
    limit = 100,
    coalesceMs = 800,
    onChange,
    canCoalesce,
  }: {
    limit?: number;
    coalesceMs?: number;
    onChange?: () => void;
    /** Si dos estados seguidos son "el mismo tipo de cambio" (p. ej. seguir
     *  escribiendo en la misma pregunta). Sin esto, agregar seis preguntas
     *  rápido quedaba en un solo paso y un Ctrl+Z las borraba todas. */
    canCoalesce?: (a: T, b: T) => boolean;
  } = {}
) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const prev = useRef<T | null>(null);
  const skip = useRef(false);
  const lastPush = useRef(0);
  const [, bump] = useState(0);

  useEffect(() => {
    const anterior = prev.current;
    prev.current = state;
    if (anterior === null || state === null || anterior === state) return;
    if (skip.current) {
      skip.current = false;
      return;
    }
    const ahora = Date.now();
    const agrupar =
      ahora - lastPush.current < coalesceMs &&
      past.current.length > 0 &&
      (!canCoalesce || canCoalesce(anterior, state));
    if (!agrupar) {
      past.current.push(anterior);
      if (past.current.length > limit) past.current.shift();
    }
    lastPush.current = ahora;
    if (future.current.length) future.current = [];
    bump((n) => n + 1);
    // canCoalesce se lee al cambiar el estado; no hace falta re-suscribir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, coalesceMs, limit]);

  const undo = useCallback(() => {
    const destino = past.current.pop();
    if (destino === undefined || prev.current === null) return false;
    future.current.push(prev.current);
    skip.current = true;
    lastPush.current = 0;
    setState(destino);
    onChange?.();
    bump((n) => n + 1);
    return true;
  }, [setState, onChange]);

  const redo = useCallback(() => {
    const destino = future.current.pop();
    if (destino === undefined || prev.current === null) return false;
    past.current.push(prev.current);
    skip.current = true;
    lastPush.current = 0;
    setState(destino);
    onChange?.();
    bump((n) => n + 1);
    return true;
  }, [setState, onChange]);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    prev.current = null;
    lastPush.current = 0;
    bump((n) => n + 1);
  }, []);

  return {
    undo,
    redo,
    reset,
    // Se leen en el render para habilitar los botones: `bump` fuerza el
    // re-render cuando cambian.
    // eslint-disable-next-line react-hooks/refs
    canUndo: past.current.length > 0,
    // eslint-disable-next-line react-hooks/refs
    canRedo: future.current.length > 0,
  };
}
