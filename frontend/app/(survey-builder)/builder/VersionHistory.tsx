"use client";

/**
 * Historial de versiones de la encuesta (preguntas + corrección): cuándo, quién
 * y por qué se guardó cada una, cuántas respuestas se dieron sobre ella, qué
 * cambia respecto de lo que hay ahora en el editor, y restaurarla. Restaurar
 * guarda antes lo actual como versión, así que también se puede deshacer.
 */

import React, { useEffect, useMemo, useState } from "react";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useDialogA11y } from "@/lib/useDialogA11y";
import { surveyApi, type SurveyVersionInfo } from "../surveyApi";

type El = { name?: string; title?: string; type?: string; choices?: unknown[] };
type SchemaLike = { pages?: { elements?: El[] }[] } | null | undefined;

function elementos(schema: SchemaLike): El[] {
  return (schema?.pages ?? [])
    .flatMap((p) => p?.elements ?? [])
    .filter((e) => e?.name && !String(e.name).endsWith("__img") && !String(e.name).endsWith("__vid") && e.type !== "html" && e.type !== "image");
}

const choiceText = (c: unknown) => {
  if (typeof c === "object" && c) {
    const o = c as { text?: unknown; value?: unknown };
    return String(o.text ?? o.value);
  }
  return String(c);
};

/** Qué cambia si se restaura `antes` sobre `ahora`. */
export function diffSchemas(ahora: SchemaLike, antes: SchemaLike) {
  const a = new Map(elementos(ahora).map((e) => [e.name!, e]));
  const b = new Map(elementos(antes).map((e) => [e.name!, e]));
  const vuelven: string[] = [];
  const seVan: string[] = [];
  const cambian: string[] = [];
  for (const [n, e] of b) {
    const actual = a.get(n);
    if (!actual) vuelven.push(e.title || n);
    else if (
      (actual.title ?? "") !== (e.title ?? "") ||
      actual.type !== e.type ||
      JSON.stringify((actual.choices ?? []).map(choiceText)) !== JSON.stringify((e.choices ?? []).map(choiceText))
    )
      cambian.push(e.title || n);
  }
  for (const [n, e] of a) if (!b.has(n)) seVan.push(e.title || n);
  return { vuelven, seVan, cambian };
}

export function VersionHistoryDialog({
  surveyId,
  currentSchema,
  accent,
  onRestored,
  onClose,
}: {
  surveyId: string;
  currentSchema: SchemaLike;
  accent: string;
  onRestored: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useDialogA11y(onClose);
  const [rows, setRows] = useState<SurveyVersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [schemaSel, setSchemaSel] = useState<SchemaLike>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    surveyApi
      .listVersions(surveyId)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [surveyId]);

  useEffect(() => {
    if (!sel) return;
    let cancel = false;
    surveyApi.getVersion(surveyId, sel).then((v) => !cancel && setSchemaSel(v.json_schema));
    return () => {
      cancel = true;
    };
  }, [surveyId, sel]);

  const diff = useMemo(() => (schemaSel ? diffSchemas(currentSchema, schemaSel) : null), [schemaSel, currentSchema]);

  async function restaurar(v: SurveyVersionInfo) {
    if (!window.confirm(t("builder.versions.confirm", { n: v.number }))) return;
    setBusy(true);
    try {
      await surveyApi.restoreVersion(surveyId, v.id);
      onRestored();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const etiqueta = (l: string | null) => (l ? t(`builder.versions.label.${l.replace(/ /g, "_")}`) : "");

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t("builder.versions.title")}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl outline-none dark:bg-neutral-900"
      >
        <header className="flex items-center gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <History className="h-5 w-5" style={{ color: accent }} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold dark:text-neutral-100">{t("builder.versions.title")}</h2>
            <p className="text-xs text-neutral-400">{t("builder.versions.subtitle")}</p>
          </div>
          <button onClick={onClose} aria-label={t("builder.wording.close")} className="text-neutral-400 hover:text-neutral-700">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {rows === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-500">{t("builder.versions.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((v) => {
                const abierta = sel === v.id;
                return (
                  <li key={v.id} className="rounded-xl border border-neutral-200 dark:border-neutral-700">
                    <button
                      onClick={() => {
                        setSchemaSel(null);
                        setSel(abierta ? null : v.id);
                      }}
                      aria-expanded={abierta}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                    >
                      <span className="w-10 shrink-0 font-mono text-xs text-neutral-400">v{v.number}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-neutral-800 dark:text-neutral-100">
                          {new Date(v.created_at).toLocaleString()}
                          {v.label && (
                            <span className="ml-2 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800">
                              {etiqueta(v.label)}
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-neutral-400">
                          {[v.created_by_email, t("builder.versions.counts", { q: v.questions, r: v.responses })]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </button>
                    {abierta && (
                      <div className="border-t border-neutral-100 px-3 py-2.5 text-sm dark:border-neutral-800">
                        {!diff ? (
                          <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
                        ) : !diff.vuelven.length && !diff.seVan.length && !diff.cambian.length ? (
                          <p className="text-xs text-neutral-500">{t("builder.versions.same")}</p>
                        ) : (
                          <div className="space-y-1 text-xs">
                            {diff.vuelven.length > 0 && (
                              <p className="text-emerald-700 dark:text-emerald-400">
                                + {t("builder.versions.back")}: {diff.vuelven.join(" · ")}
                              </p>
                            )}
                            {diff.seVan.length > 0 && (
                              <p className="text-red-600 dark:text-red-400">
                                − {t("builder.versions.gone")}: {diff.seVan.join(" · ")}
                              </p>
                            )}
                            {diff.cambian.length > 0 && (
                              <p className="text-amber-700 dark:text-amber-400">
                                ~ {t("builder.versions.changed")}: {diff.cambian.join(" · ")}
                              </p>
                            )}
                          </div>
                        )}
                        <button
                          onClick={() => restaurar(v)}
                          disabled={busy}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60"
                          style={{ backgroundColor: accent }}
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                          {t("builder.versions.restore")}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
