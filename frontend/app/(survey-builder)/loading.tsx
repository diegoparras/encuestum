// Mientras carga una pantalla del panel: un indicador en vez de nada.
export default function Loading() {
  return (
    <div className="grid min-h-[40vh] place-items-center" role="status" aria-live="polite">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 dark:border-neutral-700 dark:border-t-neutral-200" />
      <span className="sr-only">Cargando…</span>
    </div>
  );
}
