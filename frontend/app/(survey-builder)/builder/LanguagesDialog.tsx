"use client";

/**
 * Idiomas de la encuesta: traducir con IA, revisar/corregir a mano y quitar.
 * Las traducciones se guardan aparte del contenido (ver app/translation.py):
 * si se edita una pregunta, su texto nuevo queda sin traducir hasta volver a
 * traducir, y quien responde lo ve en el idioma original.
 */

import React, { useEffect, useState } from "react";
import { Languages, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { surveyApi, type TranslationCoverage, type UsageInfo } from "../surveyApi";
import { useDialogA11y } from "@/lib/useDialogA11y";
import { useI18n } from "@/lib/i18n";

const IDIOMAS = ["es", "en", "pt", "fr", "it", "de", "zh", "ja", "ca", "gl", "eu", "nl", "pl", "ru", "ar", "ko"];

function nombreIdioma(code: string, ui: string): string {
  try {
    const n = new Intl.DisplayNames([ui], { type: "language" }).of(code);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : code;
  } catch {
    return code;
  }
}

export function LanguagesDialog({
  surveyId,
  accent,
  beforeTranslate,
  onClose,
  onUsage,
}: {
  surveyId: string;
  accent: string;
  /** Guarda lo pendiente: se traduce lo que está guardado. */
  beforeTranslate: () => Promise<unknown>;
  onClose: () => void;
  onUsage?: (u: UsageInfo) => void;
}) {
  const { t, lang: ui } = useI18n();
  const panelRef = useDialogA11y(onClose);
  const [origen, setOrigen] = useState("es");
  const [cobertura, setCobertura] = useState<TranslationCoverage[] | null>(null);
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [trabajando, setTrabajando] = useState(false);
  const [revisando, setRevisando] = useState<string | null>(null);
  const [filas, setFilas] = useState<{ source: string; text: string | null }[]>([]);
  const [cambios, setCambios] = useState<Record<string, string>>({});

  useEffect(() => {
    surveyApi
      .translations(surveyId)
      .then((r) => {
        setOrigen(r.source_language);
        setCobertura(r.languages);
      })
      .catch((e) => toast.error((e as Error).message));
  }, [surveyId]);

  async function traducir(langs: string[]) {
    setTrabajando(true);
    try {
      await beforeTranslate();
      const r = await surveyApi.translate(surveyId, langs);
      setCobertura(r.languages);
      setElegidos([]);
      if (r.usage) onUsage?.(r.usage);
      toast.success(t("builder.lang.done"));
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.lang.error"));
    } finally {
      setTrabajando(false);
    }
  }

  async function abrirRevision(lang: string) {
    setRevisando(lang);
    setCambios({});
    setFilas(await surveyApi.translationTexts(surveyId, lang).catch(() => []));
  }

  async function guardarRevision() {
    if (!revisando) return;
    try {
      setCobertura(await surveyApi.editTranslation(surveyId, revisando, cambios));
      setRevisando(null);
      toast.success(t("builder.lang.saved"));
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.lang.error"));
    }
  }

  async function quitar(lang: string) {
    if (!window.confirm(t("builder.lang.confirmRemove", { lang: nombreIdioma(lang, ui) }))) return;
    await surveyApi.deleteTranslation(surveyId, lang).catch(() => {});
    setCobertura((c) => (c ?? []).filter((x) => x.language !== lang));
  }

  const yaEstan = new Set((cobertura ?? []).map((c) => c.language));
  const disponibles = IDIOMAS.filter((l) => l !== origen && !yaEstan.has(l));

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t("builder.lang.title")}>
      <div ref={panelRef} className="flex max-h-[86vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold dark:text-neutral-100">
            <Languages className="h-5 w-5" style={{ color: accent }} /> {t("builder.lang.title")}
          </h2>
          <button onClick={onClose} aria-label={t("builder.inv.close")} className="text-neutral-400 hover:text-neutral-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-5 text-sm">
          <p className="text-neutral-500 dark:text-neutral-400">
            {t("builder.lang.intro", { lang: nombreIdioma(origen, ui) })}
          </p>

          {cobertura === null ? (
            <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
          ) : revisando ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-medium text-neutral-800 dark:text-neutral-200">
                  {t("builder.lang.review", { lang: nombreIdioma(revisando, ui) })}
                </h3>
                <div className="flex gap-2">
                  <button onClick={() => setRevisando(null)} className="rounded-md border border-neutral-200 px-3 py-1 text-xs dark:border-neutral-700">
                    {t("builder.lang.back")}
                  </button>
                  <button
                    onClick={guardarRevision}
                    disabled={!Object.keys(cambios).length}
                    className="rounded-md px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: accent }}
                  >
                    {t("builder.lang.saveReview")}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {filas.map((f) => (
                  <label key={f.source} className="grid grid-cols-2 gap-2">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">{f.source}</span>
                    <textarea
                      rows={Math.min(4, Math.ceil(f.source.length / 50))}
                      defaultValue={f.text ?? ""}
                      placeholder={t("builder.lang.untranslated")}
                      onChange={(e) => setCambios((c) => ({ ...c, [f.source]: e.target.value }))}
                      className="rounded-md border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <>
              {cobertura.length > 0 && (
                <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                  {cobertura.map((c) => (
                    <li key={c.language} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="font-medium text-neutral-800 dark:text-neutral-200">{nombreIdioma(c.language, ui)}</span>
                      <span className={`text-xs ${c.missing ? "text-amber-600" : "text-emerald-600"}`}>
                        {c.missing
                          ? t("builder.lang.missing", { n: c.missing, total: c.total })
                          : t("builder.lang.complete")}
                      </span>
                      <span className="ml-auto flex gap-2">
                        {c.missing > 0 && (
                          <button
                            onClick={() => traducir([c.language])}
                            disabled={trabajando}
                            className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-neutral-700"
                          >
                            {t("builder.lang.complete_missing")}
                          </button>
                        )}
                        <button onClick={() => abrirRevision(c.language)} className="rounded-md border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700">
                          {t("builder.lang.reviewBtn")}
                        </button>
                        <button
                          onClick={() => quitar(c.language)}
                          aria-label={t("builder.lang.remove")}
                          title={t("builder.lang.remove")}
                          className="text-neutral-400 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div>
                <div className="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{t("builder.lang.add")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {disponibles.map((l) => {
                    const on = elegidos.includes(l);
                    return (
                      <button
                        key={l}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setElegidos((x) => (on ? x.filter((y) => y !== l) : [...x, l]))}
                        className={`rounded-full border px-2.5 py-1 text-xs ${on ? "text-white" : "border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"}`}
                        style={on ? { backgroundColor: accent, borderColor: accent } : undefined}
                      >
                        {nombreIdioma(l, ui)}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => traducir(elegidos)}
                  disabled={trabajando || !elegidos.length}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: accent }}
                >
                  {trabajando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
                  {t("builder.lang.translate", { n: elegidos.length })}
                </button>
                <p className="mt-2 text-[11px] text-neutral-400">{t("builder.lang.hint")}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
