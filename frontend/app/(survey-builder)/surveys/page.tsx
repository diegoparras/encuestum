"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  ExternalLink,
  Loader2,
  LayoutTemplate,
  X,
  Copy,
  Trash2,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import {
  surveyApi,
  SurveySummary,
  STARTER_SCHEMA,
  SURVEY_ACCENT,
} from "../surveyApi";
import {
  SURVEY_TEMPLATES,
  SurveyTemplate,
  templatePayload,
} from "../builder/templates";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError } from "@/components/LoadError";
import { useI18n } from "@/lib/i18n";

const STATUS_STYLE: Record<SurveySummary["status"], string> = {
  draft: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  published: "bg-green-100 text-green-700 dark:bg-green-950/40",
  closed: "bg-amber-100 text-amber-700 dark:bg-amber-950/40",
};

export default function SurveysListPage() {
  const router = useRouter();
  const { t } = useI18n();
  const {
    data: surveys,
    status,
    error,
    reload,
  } = useAsyncData(() => surveyApi.list(), []);
  const [creating, setCreating] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashingId, setTrashingId] = useState<string | null>(null);

  // Borrar manda a la papelera (nada se destruye). Ofrecemos deshacer en el
  // toast, que es el momento en que el usuario se da cuenta del error.
  async function trashSurvey(id: string) {
    if (trashingId) return;
    setTrashingId(id);
    try {
      await surveyApi.remove(id);
      reload();
      toast.success(t("surveys.toast.trashed"), {
        action: {
          label: t("surveys.undo"),
          onClick: async () => {
            try {
              await surveyApi.restore(id);
              reload();
              toast.success(t("surveys.toast.restored"));
            } catch (e: any) {
              toast.error(e?.message || t("surveys.toast.restoreError"));
            }
          },
        },
      });
    } catch (e: any) {
      toast.error(e?.message || t("surveys.toast.trashError"));
    } finally {
      setTrashingId(null);
    }
  }

  async function createSurvey() {
    setCreating(true);
    try {
      const created = await surveyApi.create({
        title: t("surveys.newSurveyDefaultTitle"),
        json_schema: STARTER_SCHEMA,
        language: "es",
      });
      window.location.href = `/surveys/${created.id}/edit`;
    } catch (e: any) {
      toast.error(e?.message || t("surveys.toast.createError"));
      setCreating(false);
    }
  }

  async function duplicate(id: string) {
    if (duplicatingId) return;
    setDuplicatingId(id);
    try {
      const copy = await surveyApi.duplicateSurvey(id);
      toast.success(t("surveys.toast.duplicated"));
      router.push(`/surveys/${copy.id}/edit`);
    } catch (e: any) {
      toast.error(e?.message || t("surveys.toast.duplicateError"));
      setDuplicatingId(null);
    }
  }

  async function createFromTemplate(tpl: SurveyTemplate) {
    if (creatingId) return;
    setCreatingId(tpl.id);
    try {
      const created = await surveyApi.create(templatePayload(tpl));
      router.push(`/surveys/${created.id}/edit`);
    } catch (e: any) {
      toast.error(e?.message || t("surveys.toast.templateCreateError"));
      setCreatingId(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">{t("surveys.title")}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t("surveys.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTrashOpen(true)}
            title={t("surveys.trash")}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            <Trash2 className="w-4 h-4" />
            {t("surveys.trash")}
          </button>
          <button
            onClick={() => setGalleryOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            <LayoutTemplate className="w-4 h-4" />
            {t("surveys.fromTemplate")}
          </button>
          <button
            onClick={createSurvey}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-white text-sm font-medium disabled:opacity-60"
            style={{ backgroundColor: SURVEY_ACCENT }}
          >
            {creating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {t("surveys.newSurvey")}
          </button>
        </div>
      </div>

      {status === "loading" && (
        <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> {t("surveys.loading")}
        </div>
      )}

      {status === "error" && (
        <LoadError message={error} onRetry={reload} compact />
      )}

      {surveys && surveys.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 py-16 text-center text-neutral-500 dark:text-neutral-400">
          {t("surveys.empty.lead")}{" "}
          <button
            onClick={() => setGalleryOpen(true)}
            className="font-medium underline hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            {t("surveys.empty.link")}
          </button>
          .
        </div>
      )}

      {surveys && surveys.length > 0 && (
        <div className="divide-y divide-neutral-200 dark:divide-neutral-800 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          {surveys.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              <div className="min-w-0">
                <Link
                  href={`/surveys/${s.id}/edit`}
                  className="font-medium hover:underline truncate block"
                >
                  {s.title || t("surveys.untitled")}
                </Link>
                <div className="mt-1 flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[s.status]}`}
                  >
                    {t(`surveys.status.${s.status}`)}
                  </span>
                  <span>{t("surveys.responsesCount", { n: s.response_count })}</span>
                  {s.is_evaluation && (
                    <span className="rounded-full bg-neutral-900/5 dark:bg-white/10 px-2 py-0.5 font-medium text-neutral-500 dark:text-neutral-400">
                      {t("surveys.exam")}
                    </span>
                  )}
                  <span className="font-mono">/s/{s.slug}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {s.status === "published" && (
                  <a
                    href={`/s/${s.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    {t("surveys.view")} <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <button
                  onClick={() => duplicate(s.id)}
                  disabled={!!duplicatingId}
                  title={t("surveys.duplicateTitle")}
                  className="inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50"
                >
                  {duplicatingId === s.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {t("surveys.duplicate")}
                </button>
                <button
                  onClick={() => trashSurvey(s.id)}
                  disabled={!!trashingId}
                  title={t("surveys.deleteTitle")}
                  className="inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                >
                  {trashingId === s.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  {t("surveys.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {trashOpen && (
        <TrashPanel
          onClose={() => setTrashOpen(false)}
          onRestored={reload}
        />
      )}

      {galleryOpen && (
        <TemplateGallery
          creatingId={creatingId}
          onClose={() => {
            if (!creatingId) setGalleryOpen(false);
          }}
          onPick={createFromTemplate}
        />
      )}
    </div>
  );
}

// Papelera: restaurar es de un click; eliminar del todo pide una segunda
// confirmación en el propio botón (sin un confirm() nativo que se acepta sin
// leer), porque ahí sí se destruyen la encuesta y todas sus respuestas.
function TrashPanel({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t, lang } = useI18n();
  const { data: trashed, status, error, reload } = useAsyncData(
    () => surveyApi.listTrash(),
    []
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  async function restore(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      await surveyApi.restore(id);
      toast.success(t("surveys.toast.restored"));
      reload();
      onRestored();
    } catch (e: any) {
      toast.error(e?.message || t("surveys.toast.restoreError"));
    } finally {
      setBusyId(null);
    }
  }

  async function purge(id: string) {
    if (confirmId !== id) {
      setConfirmId(id); // primer click: pedir confirmación
      return;
    }
    if (busyId) return;
    setBusyId(id);
    try {
      await surveyApi.purge(id);
      toast.success(t("surveys.toast.purged"));
      setConfirmId(null);
      reload();
    } catch (e: any) {
      toast.error(e?.message || t("surveys.toast.purgeError"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-200 dark:border-neutral-800 px-6 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Trash2 className="h-5 w-5 text-neutral-400" />
              {t("surveys.trash.title")}
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              {t("surveys.trash.subtitle")}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            aria-label={t("surveys.closeModal")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          {status === "loading" && (
            <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("surveys.loading")}
            </div>
          )}

          {status === "error" && <LoadError message={error} onRetry={reload} compact />}

          {trashed && trashed.length === 0 && (
            <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {t("surveys.trash.empty")}
            </p>
          )}

          {trashed && trashed.length > 0 && (
            <div className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {trashed.map((s) => (
                <div key={s.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {s.title || t("surveys.untitled")}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                        <span>{t("surveys.responsesCount", { n: s.response_count })}</span>
                        {s.deleted_at && (
                          <span>
                            {t("surveys.trash.deletedAt", {
                              d: new Date(s.deleted_at).toLocaleDateString(lang, {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              }),
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        onClick={() => restore(s.id)}
                        disabled={!!busyId}
                        className="inline-flex items-center gap-1 text-sm font-medium text-neutral-600 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-300 dark:hover:text-neutral-100"
                      >
                        {busyId === s.id && confirmId !== s.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        {t("surveys.trash.restore")}
                      </button>
                      <button
                        onClick={() => purge(s.id)}
                        disabled={!!busyId}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium disabled:opacity-50 ${
                          confirmId === s.id
                            ? "bg-red-600 text-white hover:bg-red-700"
                            : "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                        }`}
                      >
                        {busyId === s.id && confirmId === s.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        {confirmId === s.id
                          ? t("surveys.trash.purgeConfirm")
                          : t("surveys.trash.purge")}
                      </button>
                    </div>
                  </div>

                  {confirmId === s.id && (
                    <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t("surveys.trash.purgeWarning")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateGallery({
  creatingId,
  onClose,
  onPick,
}: {
  creatingId: string | null;
  onClose: () => void;
  onPick: (t: SurveyTemplate) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl bg-white dark:bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-200 dark:border-neutral-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t("surveys.gallery.title")}</h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
              {t("surveys.gallery.subtitle")}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={!!creatingId}
            className="rounded-md p-1 text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-40"
            aria-label={t("surveys.closeModal")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 p-6 sm:grid-cols-2">
          {SURVEY_TEMPLATES.map((tpl) => {
            const isLoading = creatingId === tpl.id;
            const disabled = !!creatingId && !isLoading;
            return (
              <button
                key={tpl.id}
                onClick={() => onPick(tpl)}
                disabled={!!creatingId}
                className={`group relative flex flex-col items-start rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 text-left transition hover:border-neutral-300 dark:hover:border-neutral-700 hover:shadow-sm ${
                  disabled ? "opacity-50" : ""
                }`}
              >
                <div className="mb-2 flex w-full items-center justify-between gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tpl.accent }}
                  />
                  <span className="ml-auto rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                    {t(`tpl.cat.${tpl.category}`)}
                  </span>
                </div>
                <div className="font-medium text-neutral-900 dark:text-neutral-100">{t(`tpl.name.${tpl.id}`)}</div>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-snug">
                  {t(`tpl.desc.${tpl.id}`)}
                </p>
                {isLoading && (
                  <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("surveys.creating")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
