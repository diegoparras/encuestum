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
        <svg
          className="h-7 w-7"
          viewBox="0 0 64 64"
          role="img"
          aria-label={t("app.name")}
        >
          <rect width="64" height="64" rx="15" fill="#8faf0e" />
          <rect x="14" y="32" width="7" height="18" rx="1.6" fill="#ffffff" />
          <rect x="26" y="24" width="7" height="26" rx="1.6" fill="#ffffff" />
          <rect x="38" y="16" width="7" height="34" rx="1.6" fill="#ffffff" />
          <path d="M35 24 l6 6 l8 -10" fill="none" stroke="#8faf0e" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M35 24 l6 6 l8 -10" fill="none" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("app.name")}
      </Link>
      <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        {t("app.tagline")}
      </p>
    </div>
  );
}
