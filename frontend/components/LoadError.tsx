"use client";

import { Loader2, WifiOff } from "lucide-react";

/** Inline error state with retry, for a data-fetching page/section that failed
 *  (typically a connection problem). Pair with useAsyncData. */
export function LoadError({
  message,
  onRetry,
  compact = false,
}: {
  message?: string | null;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-4 text-center ${
        compact ? "py-10" : "min-h-[50vh]"
      }`}
    >
      <div className="grid h-11 w-11 place-items-center rounded-full bg-red-50 text-red-500 dark:bg-red-950/40">
        <WifiOff className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          No se pudo cargar
        </p>
        <p className="mt-1 max-w-xs text-sm text-neutral-500 dark:text-neutral-400">
          {message || "Revisá tu conexión e intentá de nuevo."}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      >
        Reintentar
      </button>
    </div>
  );
}

/** A centered spinner for a page/section that is loading. */
export function LoadSpinner({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex items-center justify-center ${compact ? "py-10" : "min-h-[50vh]"}`}
    >
      <Loader2 className="h-6 w-6 animate-spin text-neutral-400 dark:text-neutral-500" />
    </div>
  );
}
