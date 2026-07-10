import React from "react";
import Link from "next/link";

export const metadata = {
  title: "Acceder · Encuestum",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-100 px-4 py-12 dark:bg-neutral-950">
      <div className="w-full max-w-md">
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
            Encuestum
          </Link>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Encuestas y evaluaciones con corrección por IA
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
