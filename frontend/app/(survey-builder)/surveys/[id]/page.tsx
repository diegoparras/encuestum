"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Save,
  Send,
  Lock,
  Copy,
  Check,
  Pencil,
  Download,
  QrCode,
  Code2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  surveyApi,
  SurveyDetail,
  ResponseItem,
  SURVEY_ACCENT,
  downloadResponses,
} from "../../surveyApi";
import { getMe, type Me } from "@/utils/auth";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError } from "@/components/LoadError";
import { GradesPanel } from "../../GradesPanel";
import { GradebookPanel } from "../../GradebookPanel";
import { InsightsPanel } from "../../InsightsPanel";
import { FunnelCard, SummaryPanel } from "../../SummaryPanel";
import { themeToAccent } from "../../builder/model";

export default function SurveyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, status, error, reload, setData } = useAsyncData(async () => {
    const s = await surveyApi.get(id);
    const r = await surveyApi.responses(id);
    return { survey: s, responses: r };
  }, [id]);
  const survey = data?.survey ?? null;
  const responses = data?.responses ?? null;

  const [title, setTitle] = useState("");
  const [schemaText, setSchemaText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedBranded, setCopiedBranded] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showEmbed, setShowEmbed] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [resultsTab, setResultsTab] = useState<"summary" | "responses">("summary");
  const [evalTab, setEvalTab] = useState<"gradebook" | "grading">("gradebook");

  // Inicializa el título y el JSON editables cuando llega (o se recarga) la encuesta.
  useEffect(() => {
    if (survey) {
      setTitle(survey.title || "");
      setSchemaText(JSON.stringify(survey.json_schema, null, 2));
    }
  }, [survey]);

  // Reemplaza la encuesta cargada tras guardar / publicar / cerrar.
  const setSurvey = useCallback(
    (updated: SurveyDetail) => {
      setData((prev) => (prev ? { ...prev, survey: updated } : prev!));
    },
    [setData]
  );

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(schemaText) as Record<string, any>, error: null };
    } catch (e: any) {
      return { value: null, error: e?.message as string };
    }
  }, [schemaText]);

  const publicUrl = survey
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/s/${survey.slug}`
    : "";

  // Snippet de iframe para insertar la encuesta en un sitio externo.
  const embedSnippet = publicUrl
    ? `<iframe src="${publicUrl}" width="100%" height="700" frameborder="0" style="border:0"></iframe>`
    : "";

  const activeOrg = me?.orgs.find((o) => o.id === me.active_org_id) ?? me?.orgs[0];
  const brandedUrl =
    survey && activeOrg?.subdomain && me?.base_domain
      ? `https://${activeOrg.subdomain}.${me.base_domain}/s/${survey.slug}`
      : "";

  async function save() {
    if (!parsed.value) {
      setActionError("El JSON del formulario no es válido.");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const updated = await surveyApi.update(id, {
        title,
        json_schema: parsed.value,
      });
      setSurvey(updated);
      setNotice("Cambios guardados.");
      setTimeout(() => setNotice(null), 2500);
    } catch (e: any) {
      setActionError(e?.message || "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    if (!survey) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated =
        survey.status === "published"
          ? await surveyApi.close(id)
          : await surveyApi.publish(id);
      setSurvey(updated);
    } catch (e: any) {
      setActionError(e?.message || "No se pudo cambiar el estado.");
    } finally {
      setBusy(false);
    }
  }

  async function exportResponses(format: "csv" | "xlsx") {
    if (exporting) return;
    setExporting(format);
    try {
      await downloadResponses(id, format);
    } catch (e: any) {
      toast.error(e?.message || "No se pudo exportar las respuestas.");
    } finally {
      setExporting(null);
    }
  }

  async function duplicate() {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const copy = await surveyApi.duplicateSurvey(id);
      toast.success("Encuesta duplicada. Abriendo la copia…");
      router.push(`/surveys/${copy.id}/edit`);
    } catch (e: any) {
      toast.error(e?.message || "No se pudo duplicar la encuesta.");
      setDuplicating(false);
    }
  }

  function copyLink() {
    navigator.clipboard?.writeText(publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function copyBranded() {
    navigator.clipboard?.writeText(brandedUrl).then(() => {
      setCopiedBranded(true);
      setTimeout(() => setCopiedBranded(false), 1800);
    });
  }

  function copyEmbed() {
    navigator.clipboard?.writeText(embedSnippet).then(() => {
      setCopiedEmbed(true);
      toast.success("Snippet copiado. Pegalo en tu sitio.");
      setTimeout(() => setCopiedEmbed(false), 1800);
    });
  }

  if (status === "error") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10">
        <BackLink />
        <div className="mt-6">
          <LoadError message={error} onRetry={reload} />
        </div>
      </div>
    );
  }

  if (status === "loading" || !survey) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10 flex items-center gap-2 text-neutral-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
      </div>
    );
  }

  const isPublished = survey.status === "published";

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <BackLink />

      <div className="mt-4 flex items-start justify-between gap-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Título de la encuesta"
          className="text-2xl font-semibold bg-transparent outline-none w-full border-b border-transparent focus:border-neutral-300 pb-1"
        />
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
            isPublished
              ? "bg-green-100 text-green-700"
              : survey.status === "closed"
              ? "bg-amber-100 text-amber-700"
              : "bg-neutral-100 text-neutral-600"
          }`}
        >
          {isPublished ? "Publicada" : survey.status === "closed" ? "Cerrada" : "Borrador"}
        </span>
      </div>

      {/* Public link */}
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm">
        <span className="font-mono text-neutral-600 truncate">{publicUrl}</span>
        <button
          onClick={copyLink}
          className="ml-auto inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-900"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? "Copiado" : "Copiar"}
        </button>
        <button
          onClick={() => setShowQr((v) => !v)}
          className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-900"
          title="Código QR"
        >
          <QrCode className="w-4 h-4" /> QR
        </button>
        <button
          onClick={() => setShowEmbed((v) => !v)}
          className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-900"
          title="Insertar en un sitio (iframe)"
        >
          <Code2 className="w-4 h-4" /> Insertar
        </button>
        {isPublished && (
          <a
            href={`/s/${survey.slug}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-900"
          >
            Abrir <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>

      {/* Branded (own subdomain) link */}
      {brandedUrl && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm">
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium"
            style={{ backgroundColor: `${SURVEY_ACCENT}1a`, color: SURVEY_ACCENT }}
          >
            Tu dominio
          </span>
          <span className="font-mono text-neutral-600 truncate">{brandedUrl}</span>
          <button
            onClick={copyBranded}
            className="ml-auto inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-900"
          >
            {copiedBranded ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedBranded ? "Copiado" : "Copiar"}
          </button>
        </div>
      )}

      {showQr && (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-lg border border-neutral-200 bg-white p-5">
          <QRCodeSVG value={publicUrl} size={168} level="M" includeMargin />
          <p className="text-xs text-neutral-500">Escaneá para abrir la encuesta</p>
        </div>
      )}

      {showEmbed && (
        <div className="mt-3 rounded-lg border border-neutral-200 bg-white p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-neutral-700">
              Insertar en un sitio
            </h3>
            <button
              onClick={copyEmbed}
              className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
            >
              {copiedEmbed ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedEmbed ? "Copiado" : "Copiar"}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-700 ring-1 ring-neutral-200">
            {embedSnippet}
          </pre>
          <p className="mt-2 text-xs text-neutral-400">
            Pegá este código en el HTML de tu sitio para mostrar la encuesta
            embebida. Ajustá <span className="font-mono">height</span> a gusto.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex items-center gap-3">
        <Link
          href={`/surveys/${id}/edit`}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
        >
          <Pencil className="w-4 h-4" /> Editor visual
        </Link>
        <button
          onClick={save}
          disabled={saving || !!parsed.error}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-white text-sm font-medium disabled:opacity-60"
          style={{ backgroundColor: SURVEY_ACCENT }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Guardar
        </button>
        <button
          onClick={togglePublish}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isPublished ? (
            <Lock className="w-4 h-4" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          {isPublished ? "Cerrar" : "Publicar"}
        </button>
        <button
          onClick={duplicate}
          disabled={duplicating}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60"
          title="Crear una copia en borrador"
        >
          {duplicating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
          Duplicar
        </button>
      </div>

      {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}
      {actionError && <p className="mt-3 text-sm text-red-700">{actionError}</p>}

      {/* Schema editor */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-neutral-700">
            Definición del formulario (SurveyJS JSON)
          </h2>
          {parsed.error ? (
            <span className="text-xs text-red-600">JSON inválido: {parsed.error}</span>
          ) : (
            <span className="text-xs text-green-600">JSON válido</span>
          )}
        </div>
        <textarea
          value={schemaText}
          onChange={(e) => setSchemaText(e.target.value)}
          spellCheck={false}
          className="w-full h-80 font-mono text-xs rounded-lg border border-neutral-300 bg-white p-3 outline-none focus:border-neutral-400"
        />
        <p className="mt-2 text-xs text-neutral-400">
          Edición avanzada del modelo SurveyJS. Para la mayoría de los casos usá
          el <Link href={`/surveys/${id}/edit`} className="underline">editor visual</Link>;
          acá podés pegar cualquier modelo válido o ajustar detalles finos.
        </p>
      </div>

      {/* Responses / grades */}
      <div className="mt-10">
        {survey.evaluation?.enabled ? (
          <>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
                {(
                  [
                    ["gradebook", "Notas"],
                    ["grading", "Correcciones"],
                  ] as const
                ).map(([key, label]) => {
                  const active = evalTab === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setEvalTab(key)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-white text-neutral-900 shadow-sm"
                          : "text-neutral-500 hover:text-neutral-800"
                      }`}
                      style={active ? { color: SURVEY_ACCENT } : undefined}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <ExportButtons
                exporting={exporting}
                disabled={!responses || responses.length === 0}
                onExport={exportResponses}
              />
            </div>
            {evalTab === "gradebook" ? (
              <GradebookPanel surveyId={id} accent={themeToAccent(survey.theme)} />
            ) : (
              <GradesPanel surveyId={id} accent={themeToAccent(survey.theme)} />
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
                {(
                  [
                    ["summary", "Resumen"],
                    ["responses", `Respuestas${responses ? ` (${responses.length})` : ""}`],
                  ] as const
                ).map(([key, label]) => {
                  const active = resultsTab === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setResultsTab(key)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-white text-neutral-900 shadow-sm"
                          : "text-neutral-500 hover:text-neutral-800"
                      }`}
                      style={active ? { color: SURVEY_ACCENT } : undefined}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {resultsTab === "responses" && (
                <ExportButtons
                  exporting={exporting}
                  disabled={!responses || responses.length === 0}
                  onExport={exportResponses}
                />
              )}
            </div>
            {resultsTab === "summary" ? (
              <div className="space-y-4">
                {/* Embudo de conversión: vistas → comenzaron → completaron */}
                <FunnelCard surveyId={id} accent={themeToAccent(survey.theme)} />
                <SummaryPanel surveyId={id} accent={themeToAccent(survey.theme)} />
              </div>
            ) : responses === null ? (
              <div className="text-sm text-neutral-400">Cargando…</div>
            ) : responses.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-300 py-10 text-center text-neutral-400 text-sm">
                Todavía no hay respuestas.
              </div>
            ) : (
              <ResponsesTable responses={responses} />
            )}
          </>
        )}
      </div>

      {hasOpenText(survey.json_schema) && (
        <div className="mt-12">
          <InsightsPanel surveyId={id} accent={themeToAccent(survey.theme)} />
        </div>
      )}
    </div>
  );
}

function ExportButtons({
  exporting,
  disabled,
  onExport,
}: {
  exporting: "csv" | "xlsx" | null;
  disabled: boolean;
  onExport: (format: "csv" | "xlsx") => void;
}) {
  const btn =
    "inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        onClick={() => onExport("csv")}
        disabled={disabled || !!exporting}
        className={btn}
        title={disabled ? "No hay respuestas para exportar" : "Descargar CSV"}
      >
        {exporting === "csv" ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Download className="w-3.5 h-3.5" />
        )}
        CSV
      </button>
      <button
        onClick={() => onExport("xlsx")}
        disabled={disabled || !!exporting}
        className={btn}
        title={disabled ? "No hay respuestas para exportar" : "Descargar Excel"}
      >
        {exporting === "xlsx" ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Download className="w-3.5 h-3.5" />
        )}
        Excel
      </button>
    </div>
  );
}

function hasOpenText(schema: Record<string, any> | null | undefined): boolean {
  for (const p of schema?.pages ?? []) {
    for (const el of p?.elements ?? []) {
      if (el?.type === "comment") return true;
      if (el?.type === "text" && el?.inputType !== "email") return true;
    }
  }
  return false;
}

function ResponsesTable({ responses }: { responses: ResponseItem[] }) {
  // Union of all answer keys across responses, preserving first-seen order.
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const r of responses) {
      for (const k of Object.keys(r.answers || {})) {
        if (!seen.includes(k)) seen.push(k);
      }
    }
    return seen;
  }, [responses]);

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Fecha</th>
            {columns.map((c) => (
              <th key={c} className="text-left font-medium px-3 py-2 whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {responses.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 whitespace-nowrap text-neutral-400">
                {new Date(r.submitted_at).toLocaleString()}
              </td>
              {columns.map((c) => (
                <td key={c} className="px-3 py-2 align-top">
                  {formatCell(r.answers?.[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: any): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function BackLink() {
  return (
    <Link
      href="/surveys"
      className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
    >
      <ArrowLeft className="w-4 h-4" /> Encuestas
    </Link>
  );
}
