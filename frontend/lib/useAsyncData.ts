"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = []
): AsyncData<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [status, setStatus] = useState<AsyncStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => {
    setStatus("loading");
    setError(null);
    fetcher()
      .then((d) => {
        if (cancelled.current) return;
        setDataState(d);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled.current) return;
        setError(e?.message || "Ocurrió un error al cargar los datos.");
        setStatus("error");
      });
  }, deps);

  useEffect(() => {
    cancelled.current = false;
    load();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setDataState((prev) =>
      typeof updater === "function" ? (updater as (p: T | null) => T)(prev) : updater
    );
  }, []);

  return { data, status, error, reload: load, setData };
}
