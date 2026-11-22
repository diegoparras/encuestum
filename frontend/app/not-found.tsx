"use client";

import Link from "next/link";
import { SearchX } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <main className="grid min-h-[60vh] place-items-center p-6">
      <div className="max-w-md text-center">
        <SearchX className="mx-auto mb-3 h-8 w-8 text-neutral-400" aria-hidden />
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t("notFound.title")}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t("notFound.body")}</p>
        <Link
          href="/surveys"
          className="mt-5 inline-block rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300"
        >
          {t("error.home")}
        </Link>
      </div>
    </main>
  );
}
