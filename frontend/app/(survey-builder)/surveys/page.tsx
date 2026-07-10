"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, ExternalLink, Loader2, LayoutTemplate, X, Copy } from "lucide-react";
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

const STATUS_LABEL: Record<SurveySummary["status"], string> = {
  draft: "Borrador",
  published: "Publicada",
  closed: "Cerrada",
};

const STATUS_STYLE: Record<SurveySummary["status"], string> = {
  draft: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  published: "bg-green-100 text-green-700 dark:bg-green-950/40",
  closed: "bg-amber-100 text-amber-700 dark:bg-amber-950/40",
};

export default function SurveysListPage() {
  const router = useRouter();
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

  async function createSurvey() {
    setCreating(true);
    try {
      const created = await surveyApi.create({
        title: "Nueva encuesta",
        json_schema: STARTER_SCHEMA,
        language: "es",
      });
      window.location.href = `/surveys/${created.id}/edit`;
    } catch (e: any) {
      toast.error(e?.message || "No se pudo crear la encuesta.");
      setCreating(false);
    }
  }

  async function duplicate(id: string) {
    if (duplicatingId) return;
    setDuplicatingId(id);
    try {
      const copy = await surveyApi.duplicateSurvey(id);
      toast.success("Encuesta duplicada.");
      router.push(`/surveys/${copy.id}/edit`);
    } catch (e: any) {
      toast.error(e?.message || "No se pudo duplicar la encuesta.");
      setDuplicatingId(null);
    }
  }

  async function createFromTemplate(t: SurveyTemplate) {
    if (creatingId) return;
    setCreatingId(t.id);
    try {
      const created = await surveyApi.create(templatePayload(t));
      router.push(`/surveys/${created.id}/edit`);
    } catch (e: any) {
      toast.error(e?.message || "No se pudo crear la encuesta desde la plantilla.");
      setCreatingId(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Encuestas</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Creá formularios tipo Typeform, publicalos y recolectá respuestas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGalleryOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            <LayoutTemplate className="w-4 h-4" />
            Desde plantilla
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
            Nueva encuesta
          </button>
        </div>
      </div>

      {status === "loading" && (
        <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        </div>
      )}

      {status === "error" && (
        <LoadError message={error} onRetry={reload} compact />
      )}

      {surveys && surveys.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 py-16 text-center text-neutral-500 dark:text-neutral-400">
          Todavía no hay encuestas. Creá la primera{" "}
          <button
            onClick={() => setGalleryOpen(true)}
            className="font-medium underline hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            desde una plantilla
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
                  {s.title || "(sin título)"}
                </Link>
                <div className="mt-1 flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[s.status]}`}
                  >
                    {STATUS_LABEL[s.status]}
                  </span>
                  <span>{s.response_count} respuestas</span>
                  {s.is_evaluation && (
                    <span className="rounded-full bg-neutral-900/5 dark:bg-white/10 px-2 py-0.5 font-medium text-neutral-500 dark:text-neutral-400">
                      Examen
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
                    Ver <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <button
                  onClick={() => duplicate(s.id)}
                  disabled={!!duplicatingId}
                  title="Duplicar encuesta"
                  className="inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50"
                >
                  {duplicatingId === s.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  Duplicar
                </button>
              </div>
            </div>
          ))}
        </div>
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

function TemplateGallery({
  creatingId,
  onClose,
  onPick,
}: {
  creatingId: string | null;
  onClose: () => void;
  onPick: (t: SurveyTemplate) => void;
}) {
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
            <h2 className="text-lg font-semibold">Elegí una plantilla</h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
              Empezá con una estructura lista y ajustala en el editor.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={!!creatingId}
            className="rounded-md p-1 text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-40"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 p-6 sm:grid-cols-2">
          {SURVEY_TEMPLATES.map((t) => {
            const isLoading = creatingId === t.id;
            const disabled = !!creatingId && !isLoading;
            return (
              <button
                key={t.id}
                onClick={() => onPick(t)}
                disabled={!!creatingId}
                className={`group relative flex flex-col items-start rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 text-left transition hover:border-neutral-300 dark:hover:border-neutral-700 hover:shadow-sm ${
                  disabled ? "opacity-50" : ""
                }`}
              >
                <div className="mb-2 flex w-full items-center justify-between gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: t.accent }}
                  />
                  <span className="ml-auto rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                    {t.category}
                  </span>
                </div>
                <div className="font-medium text-neutral-900 dark:text-neutral-100">{t.name}</div>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-snug">
                  {t.description}
                </p>
                {isLoading && (
                  <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Creando…
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
