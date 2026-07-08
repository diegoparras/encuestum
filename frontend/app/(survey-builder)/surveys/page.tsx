"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, ExternalLink, Loader2 } from "lucide-react";
import {
  surveyApi,
  SurveySummary,
  STARTER_SCHEMA,
  SURVEY_ACCENT,
} from "../surveyApi";

const STATUS_LABEL: Record<SurveySummary["status"], string> = {
  draft: "Borrador",
  published: "Publicada",
  closed: "Cerrada",
};

const STATUS_STYLE: Record<SurveySummary["status"], string> = {
  draft: "bg-neutral-100 text-neutral-600",
  published: "bg-green-100 text-green-700",
  closed: "bg-amber-100 text-amber-700",
};

export default function SurveysListPage() {
  const [surveys, setSurveys] = useState<SurveySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      setSurveys(await surveyApi.list());
      setError(null);
    } catch (e: any) {
      setError(e?.message || "No se pudo cargar la lista de encuestas.");
    }
  }

  useEffect(() => {
    load();
  }, []);

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
      setError(e?.message || "No se pudo crear la encuesta.");
      setCreating(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Encuestas</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Creá formularios tipo Typeform, publicalos y recolectá respuestas.
          </p>
        </div>
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

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {surveys === null && !error && (
        <div className="flex items-center gap-2 text-neutral-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        </div>
      )}

      {surveys && surveys.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-300 py-16 text-center text-neutral-500">
          Todavía no hay encuestas. Creá la primera.
        </div>
      )}

      {surveys && surveys.length > 0 && (
        <div className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
          {surveys.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
            >
              <div className="min-w-0">
                <Link
                  href={`/surveys/${s.id}/edit`}
                  className="font-medium hover:underline truncate block"
                >
                  {s.title || "(sin título)"}
                </Link>
                <div className="mt-1 flex items-center gap-3 text-xs text-neutral-500">
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[s.status]}`}
                  >
                    {STATUS_LABEL[s.status]}
                  </span>
                  <span>{s.response_count} respuestas</span>
                  {s.is_evaluation && (
                    <span className="rounded-full bg-neutral-900/5 px-2 py-0.5 font-medium text-neutral-500">
                      Examen
                    </span>
                  )}
                  <span className="font-mono">/s/{s.slug}</span>
                </div>
              </div>
              {s.status === "published" && (
                <a
                  href={`/s/${s.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
                >
                  Ver <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
