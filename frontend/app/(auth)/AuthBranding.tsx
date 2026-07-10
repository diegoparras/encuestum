"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export function AuthBranding() {
  const { t } = useI18n();
  return (
    <div className="mb-8 text-center">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100"
      >
        <span
          className="inline-block h-7 w-7 rounded-lg"
          style={{ backgroundColor: "#8faf0e" }}
          aria-hidden
        />
        {t("app.name")}
      </Link>
      <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        {t("app.tagline")}
      </p>
    </div>
  );
}
