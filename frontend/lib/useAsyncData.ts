"use client";

import { useCallback, useEffect, useState } from "react";

export type AsyncStatus = "loading" | "ready" | "error";

export interface AsyncData<T> {
  data: T | null;
  status: AsyncStatus;
  error: string | null;
  reload: () => void;
  setData: (updater: T | ((prev: T | null) => T)) => void;
}

/**
 * Fetch-on-mount with explicit loading / ready / error states and a `reload()`.
 * The fetcher should throw on failure (a network failure surfaces as a clear
 * Spanish ConnectionError). Distinguishes "error" from an endless spinner.
 *
 * El fetcher recibe opcionalmente un `AbortSignal`: al re-montar o cambiar de
 * deps abortamos la petición en curso para evitar carreras (que una respuesta
 * vieja pise a una nueva). Los fetchers que ignoran el signal siguen andando.
 */
export function useAsyncData<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  deps: unknown[] = []
): AsyncData<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [status, setStatus] = useState<AsyncStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback((signal?: AbortSignal) => {
    setStatus("loading");
    setError(null);
    fetcher(signal)
      .then((d) => {
        if (signal?.aborted) return;
        setDataState(d);
        setStatus("ready");
      })
      .catch((e) => {
        // El abort no es un error real: lo ignoramos para no pintar "error".
        if (signal?.aborted || e?.name === "AbortError") return;
        setError(e?.message || "Ocurrió un error al cargar los datos.");
        setStatus("error");
      });
  }, deps);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  // Recarga manual (botón "Reintentar"): sin signal, no aborta nada.
  const reload = useCallback(() => load(), [load]);

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setDataState((prev) =>
      typeof updater === "function" ? (updater as (p: T | null) => T)(prev) : updater
    );
  }, []);

  return { data, status, error, reload, setData };
}
