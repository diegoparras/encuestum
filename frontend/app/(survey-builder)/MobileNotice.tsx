"use client";

import { useEffect, useState } from "react";
import { Monitor, X, ZoomOut } from "lucide-react";
import { EncuestumLogo } from "@/components/EncuestumLogo";
import { useI18n } from "@/lib/i18n";

// Aviso para móviles: el builder de Encuestum es una interfaz de tres paneles
// pensada para pantalla grande. En teléfonos recomendamos usar un ordenador o,
// en su defecto, reducir el zoom del navegador. Se muestra una sola vez por
// sesión y SOLO dentro del shell autenticado (AppShell) — nunca al responder una
// encuesta pública, que no monta este componente.
const SESSION_KEY = "encuestum.mobileNotice.seen";
const MOBILE_QUERY = "(max-width: 820px)";

export function MobileNotice() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Nada de esto corre en SSR. Solo abrimos en pantallas chicas y una vez por
    // sesión, para no molestar en cada navegación dentro del panel.
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
    } catch {
      /* storage no disponible: mostramos igual */
    }
    if (typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches) {
      setOpen(true);
    }
  }, []);

  function dismiss() {
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-neutral-950/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enc-mobile-notice-title"
      onClick={dismiss}
    >
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera con el acento oliva de Encuestum y el logo en un halo. */}
        <div
          className="relative flex flex-col items-center gap-3 px-6 pb-6 pt-8 text-center"
          style={{
            background:
              "radial-gradient(120% 100% at 50% 0%, rgba(143,175,14,0.18), rgba(143,175,14,0.04) 60%, transparent)",
          }}
        >
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("common.cancel")}
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white shadow-md ring-1 ring-black/5 dark:bg-neutral-800 dark:ring-white/10">
            <EncuestumLogo size={40} />
          </div>

          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6d850b] dark:text-[#a8ca2a]">
            {t("mobileNotice.eyebrow")}
          </p>
          <h2
            id="enc-mobile-notice-title"
            className="text-lg font-bold leading-tight text-neutral-900 dark:text-neutral-50"
          >
            {t("mobileNotice.title")}
          </h2>
        </div>

        {/* Cuerpo */}
        <div className="space-y-4 px-6 pb-6">
          <p className="flex gap-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-[#8faf0e]" />
            <span>{t("mobileNotice.body")}</span>
          </p>

          <div className="flex gap-3 rounded-2xl bg-[#8faf0e]/10 p-3.5 text-sm leading-relaxed text-neutral-700 dark:bg-[#8faf0e]/10 dark:text-neutral-200">
            <ZoomOut className="mt-0.5 h-5 w-5 shrink-0 text-[#8faf0e]" />
            <span>{t("mobileNotice.zoomTip")}</span>
          </div>

          <button
            type="button"
            onClick={dismiss}
            className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-[#1e2a06] transition-opacity hover:opacity-90"
          >
            {t("mobileNotice.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
