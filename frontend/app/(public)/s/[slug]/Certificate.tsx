"use client";

import React, { useEffect, useState } from "react";
import { Loader2, Printer, X, Award } from "lucide-react";

// Datos del certificado que devuelve el backend.
interface CertificateData {
  name: string;
  survey_title: string;
  org_name: string;
  percent: number;
  passing_score: number;
  date: string;
  code: string;
}

// Formatea la fecha (ISO o similar) en español; si no parsea, la devuelve tal cual.
function formatDate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("es", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Certificado imprimible para un respondiente que aprobó una evaluación.
 * Se muestra como una capa a pantalla completa; al imprimir, los estilos
 * `@media print` ocultan todo menos el certificado (papel siempre claro).
 * Si el endpoint devuelve 403/404, se muestra el `detail` del backend.
 */
export function Certificate({
  slug,
  email,
  code,
  accent,
  apiBase,
  onClose,
}: {
  slug: string;
  email: string;
  code: string;
  accent: string;
  apiBase: () => string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CertificateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/certificate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, code }),
          }
        );
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(
            (body && body.detail) ||
              "No pudimos emitir el certificado. Probá de nuevo."
          );
          return;
        }
        setData(body as CertificateData);
      } catch {
        if (!cancelled) setError("No pudimos conectar. Probá de nuevo.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, email, code, apiBase]);

  return (
    <div className="enc-cert-overlay fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-neutral-900/60 p-4 sm:p-8">
      {/* Estilos de impresión: sólo el certificado se imprime. */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .enc-cert-print, .enc-cert-print * { visibility: visible !important; }
          .enc-cert-overlay {
            position: absolute !important;
            inset: 0 !important;
            background: #ffffff !important;
            padding: 0 !important;
            overflow: visible !important;
          }
          .enc-cert-print {
            position: absolute !important;
            left: 0; top: 0;
            width: 100% !important;
            max-width: none !important;
            box-shadow: none !important;
            margin: 0 !important;
          }
          .enc-print-hide { display: none !important; }
        }
      `}</style>

      <div className="w-full max-w-2xl">
        {/* Barra de acciones (no se imprime). En móvil envuelve y mantiene
            alto táctil (≥44px) en los dos botones. */}
        <div className="enc-print-hide mb-3 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-white/90 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-white"
          >
            <X className="h-4 w-4" /> Cerrar
          </button>
          {data && (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: accent }}
            >
              <Printer className="h-4 w-4" /> Imprimir / Guardar PDF
            </button>
          )}
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-16 text-sm text-neutral-500 shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin" /> Emitiendo tu
            certificado…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-2xl bg-white px-6 py-12 text-center shadow-sm">
            <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-red-50 text-red-500">
              <Award className="h-5 w-5" />
            </div>
            <p className="text-sm font-semibold text-neutral-800">
              No se pudo emitir el certificado
            </p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-500">
              {error}
            </p>
          </div>
        )}

        {data && !loading && (
          <div
            // Padding compacto en móvil para que el contenido no toque el
            // marco decorativo y el certificado entre completo en 360px.
            className="enc-cert-print relative overflow-hidden rounded-2xl bg-white p-6 shadow-xl sm:p-12"
            style={{ color: "#1f2937" }}
          >
            {/* Marco decorativo */}
            <div
              className="pointer-events-none absolute inset-3 rounded-xl"
              style={{ border: `2px solid ${accent}` }}
            />
            <div
              className="pointer-events-none absolute inset-4 rounded-lg"
              style={{ border: "1px solid #e5e7eb" }}
            />

            <div className="relative flex flex-col items-center text-center">
              <div
                className="mb-4 grid h-14 w-14 place-items-center rounded-full"
                style={{ backgroundColor: `${accent}1a`, color: accent }}
              >
                <Award className="h-7 w-7" />
              </div>

              {data.org_name && (
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
                  {data.org_name}
                </p>
              )}

              <h1
                // Tipografía y tracking más chicos en móvil para que el título
                // espaciado no desborde en 360px.
                className="mt-4 text-xl font-bold uppercase tracking-[0.2em] sm:text-3xl sm:tracking-[0.25em]"
                style={{ color: accent }}
              >
                Certificado
              </h1>
              <p className="mt-1 text-sm text-neutral-500">
                de aprobación
              </p>

              <p className="mt-8 text-sm text-neutral-500">
                Se certifica que
              </p>
              {/* break-words: nombres largos no deben desbordar en móvil. */}
              <p className="mt-2 max-w-full break-words text-2xl font-semibold text-neutral-900 sm:text-4xl">
                {data.name}
              </p>

              <p className="mt-6 max-w-lg text-base leading-relaxed text-neutral-700">
                aprobó{" "}
                <span className="font-semibold">{data.survey_title}</span> con
                una calificación de{" "}
                <span className="font-bold" style={{ color: accent }}>
                  {data.percent}%
                </span>
                .
              </p>

              <p className="mt-2 text-xs text-neutral-400">
                Nota mínima de aprobación: {data.passing_score}%
              </p>

              {/* flex-wrap: en 360px la fecha y el código pueden apilarse. */}
              <div className="mt-8 sm:mt-10 flex w-full flex-wrap items-end justify-between gap-4 sm:gap-6 text-left">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-neutral-400">
                    Fecha
                  </p>
                  <p className="text-sm font-medium text-neutral-700">
                    {formatDate(data.date)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] uppercase tracking-wide text-neutral-400">
                    Código de verificación
                  </p>
                  <p className="break-all font-mono text-sm font-medium text-neutral-700">
                    {data.code}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
