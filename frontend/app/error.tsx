"use client";

// Pantalla de respaldo ante un error inesperado al renderizar. Antes no había
// ninguna: un error dejaba la pantalla en blanco. Ver la convención en
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md
// (en esta versión de Next la prop para reintentar es `retry`).

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export default function ErrorScreen({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="grid min-h-[60vh] place-items-center p-6" role="alert">
      <div className="max-w-md text-center">
        <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-500" aria-hidden />
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t("error.title")}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t("error.body")}</p>
        {error.digest && <p className="mt-2 font-mono text-[11px] text-neutral-400">ref: {error.digest}</p>}
        <div className="mt-5 flex justify-center gap-2">
          <button
            onClick={() => retry()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {t("common.retry")}
          </button>
          <Link
            href="/surveys"
            className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300"
          >
            {t("error.home")}
          </Link>
        </div>
      </div>
    </main>
  );
}
