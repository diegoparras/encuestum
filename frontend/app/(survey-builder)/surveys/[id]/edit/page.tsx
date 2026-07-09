"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  Save,
  Send,
  Lock,
  ExternalLink,
  ListChecks,
  Check,
} from "lucide-react";
import { GraduationCap, Sparkles, Palette } from "lucide-react";
import {
  surveyApi,
  type UsageInfo,
  type AccessMode,
  type ResultsMode,
} from "../../../surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError } from "@/components/LoadError";
import { AccessSettings } from "../../../builder/AccessSettings";
import { UsageModal } from "../../../builder/UsageModal";
import {
  BuilderQuestion,
  BuilderState,
  DesignSettings,
  EvaluationSettings,
  QuestionType,
  builderToEvaluation,
  builderToSchema,
  createQuestion,
  designToTheme,
  generatedToQuestion,
  newChoice,
  readableForeground,
  schemaToBuilder,
  themeToAccent,
  themeToDesign,
} from "../../../builder/model";
import { QuestionListPanel } from "../../../builder/QuestionListPanel";
import { PropertiesPanel } from "../../../builder/PropertiesPanel";
import { LivePreview } from "../../../builder/LivePreview";
import { AccentPicker } from "../../../builder/AccentPicker";
import { DesignPanel } from "../../../builder/DesignPanel";
import { GenerateDialog } from "../../../builder/GenerateDialog";

export default function SurveyEditorPage() {
  const { id } = useParams<{ id: string }>();

  const [state, setState] = useState<BuilderState | null>(null);
  const [status, setStatus] = useState<"draft" | "published" | "closed">("draft");
  const [slug, setSlug] = useState("");
  const [language, setLanguage] = useState<string | null>("es");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Control de acceso y visibilidad de resultados (se persisten al vuelo).
  const [accessMode, setAccessMode] = useState<AccessMode>("public");
  const [accessPin, setAccessPin] = useState<string | null>(null);
  const [resultsMode, setResultsMode] = useState<ResultsMode>("immediate");
  const [resultsReleased, setResultsReleased] = useState(false);
  const [notifyEmails, setNotifyEmails] = useState("");

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);

  // Carga la encuesta y arma el estado del builder dentro del fetcher, para que
  // cualquier fallo (conexión o parseo) quede capturado como estado de error.
  const {
    data: loaded,
    status: loadStatus,
    error: loadError,
    reload,
  } = useAsyncData(async () => {
    const s = await surveyApi.get(id);
    const accent = themeToAccent(s.theme);
    const built = schemaToBuilder(s.json_schema, s.title || "", accent, s.evaluation);
    built.design = themeToDesign(s.theme);
    built.closesAt = s.closes_at;
    built.maxResponses = s.max_responses;
    return { survey: s, built };
  }, [id]);

  // Inicializa el estado editable cuando llega (o se recarga) la encuesta.
  useEffect(() => {
    if (!loaded) return;
    const s = loaded.survey;
    setState(loaded.built);
    setStatus(s.status);
    setSlug(s.slug);
    setLanguage(s.language ?? "es");
    setAccessMode(s.access_mode ?? "public");
    setAccessPin(s.access_pin ?? null);
    setResultsMode(s.results_mode ?? "immediate");
    setResultsReleased(s.results_released ?? false);
    setNotifyEmails(s.notify_emails ?? "");
    setDirty(false);
  }, [loaded]);

  // Mutations ---------------------------------------------------------------
  const mutate = useCallback((fn: (prev: BuilderState) => BuilderState) => {
    setState((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
  }, []);

  const addQuestion = useCallback(
    (type: QuestionType) => {
      setState((prev) => {
        if (!prev) return prev;
        const q = createQuestion(type, prev.questions.length);
        setSelectedId(q.id);
        return { ...prev, questions: [...prev.questions, q] };
      });
      setDirty(true);
    },
    []
  );

  const patchQuestion = useCallback(
    (patch: Partial<BuilderQuestion>) => {
      if (!selectedId) return;
      mutate((prev) => ({
        ...prev,
        questions: prev.questions.map((q) =>
          q.id === selectedId ? { ...q, ...patch } : q
        ),
      }));
    },
    [selectedId, mutate]
  );

  const duplicateQuestion = useCallback(
    (qid: string) => {
      setState((prev) => {
        if (!prev) return prev;
        const idx = prev.questions.findIndex((q) => q.id === qid);
        if (idx < 0) return prev;
        const src = prev.questions[idx];
        const copy: BuilderQuestion = {
          ...src,
          id: createQuestion(src.type, prev.questions.length).id,
          name: `${src.name}_copia`,
          choices: src.choices?.map((c) => newChoice(c.text)),
        };
        const next = [...prev.questions];
        next.splice(idx + 1, 0, copy);
        setSelectedId(copy.id);
        return { ...prev, questions: next };
      });
      setDirty(true);
    },
    []
  );

  const deleteQuestion = useCallback(
    (qid: string) => {
      setState((prev) =>
        prev
          ? { ...prev, questions: prev.questions.filter((q) => q.id !== qid) }
          : prev
      );
      setSelectedId((cur) => (cur === qid ? null : cur));
      setDirty(true);
    },
    []
  );

  const reorder = useCallback(
    (questions: BuilderQuestion[]) => mutate((prev) => ({ ...prev, questions })),
    [mutate]
  );

  const setEvaluation = useCallback(
    (evaluation: EvaluationSettings) => mutate((prev) => ({ ...prev, evaluation })),
    [mutate]
  );

  const setDesign = useCallback(
    (design: DesignSettings) => mutate((prev) => ({ ...prev, design })),
    [mutate]
  );

  const toggleEvaluation = useCallback(() => {
    mutate((prev) => ({
      ...prev,
      evaluation: { ...prev.evaluation, enabled: !prev.evaluation.enabled },
    }));
  }, [mutate]);

  const insertGenerated = useCallback((gens: any[]) => {
    setState((prev) => {
      if (!prev) return prev;
      const created = gens.map((g, i) =>
        generatedToQuestion(g, prev.questions.length + i)
      );
      return {
        ...prev,
        evaluation: { ...prev.evaluation, enabled: true },
        questions: [...prev.questions, ...created],
      };
    });
    setDirty(true);
  }, []);

  // Derived -----------------------------------------------------------------
  const schema = useMemo(
    () => (state ? builderToSchema(state) : {}),
    [state]
  );
  const selectedQuestion =
    state?.questions.find((q) => q.id === selectedId) ?? null;

  // Actions -----------------------------------------------------------------
  async function save() {
    if (!state) return;
    setSaving(true);
    try {
      await surveyApi.update(id, {
        title: state.title,
        json_schema: builderToSchema(state),
        theme: designToTheme(state.accent, state.design),
        evaluation: builderToEvaluation(state),
        closes_at: state.closesAt,
        max_responses: state.maxResponses,
        language,
      });
      setDirty(false);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
    } catch (e: any) {
      alert(e?.message || "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    setPublishing(true);
    try {
      if (dirty) await save();
      const updated =
        status === "published"
          ? await surveyApi.close(id)
          : await surveyApi.publish(id);
      setStatus(updated.status);
    } catch (e: any) {
      alert(e?.message || "No se pudo cambiar el estado.");
    } finally {
      setPublishing(false);
    }
  }

  // Warn on unload with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (loadStatus === "error") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link
          href="/surveys"
          className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft className="w-4 h-4" /> Encuestas
        </Link>
        <div className="mt-6">
          <LoadError message={loadError} onRetry={reload} />
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="h-screen grid place-items-center text-neutral-400 text-sm">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando editor…
        </span>
      </div>
    );
  }

  const isPublished = status === "published";
  const accentFg = readableForeground(state.accent);

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 h-14 border-b border-neutral-200 bg-white shrink-0">
        <Link
          href="/surveys"
          className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <input
          value={state.title}
          onChange={(e) => mutate((prev) => ({ ...prev, title: e.target.value }))}
          placeholder="Título de la encuesta"
          className="min-w-0 flex-1 text-sm font-semibold bg-transparent outline-none border-b border-transparent focus:border-neutral-300 py-1"
        />

        <StatusBadge status={status} />

        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/surveys/${id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            title="Respuestas y JSON avanzado"
          >
            <ListChecks className="w-4 h-4" /> Respuestas
          </Link>

          <button
            onClick={toggleEvaluation}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              state.evaluation.enabled
                ? "border-transparent text-white"
                : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"
            }`}
            style={
              state.evaluation.enabled
                ? { backgroundColor: state.accent, color: accentFg }
                : undefined
            }
            title="Modo evaluación (examen con corrección)"
          >
            <GraduationCap className="w-4 h-4" /> Examen
          </button>

          <button
            onClick={() => setGenOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            title="Generar preguntas con IA"
          >
            <Sparkles className="w-4 h-4" /> IA
          </button>

          <button
            onClick={() => setDesignOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            title="Tipografía, imágenes y música"
          >
            <Palette className="w-4 h-4" /> Diseño
          </button>

          <AccentPicker
            value={state.accent}
            onChange={(accent) => mutate((prev) => ({ ...prev, accent }))}
          />

          {isPublished && (
            <a
              href={`/s/${slug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Ver <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

          <button
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : savedTick ? (
              <Check className="w-4 h-4 text-green-600" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {savedTick ? "Guardado" : dirty ? "Guardar" : "Al día"}
          </button>

          <button
            onClick={togglePublish}
            disabled={publishing}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
            style={{ backgroundColor: state.accent, color: accentFg }}
          >
            {publishing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isPublished ? (
              <Lock className="w-4 h-4" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            {isPublished ? "Cerrar" : "Publicar"}
          </button>
        </div>
      </header>

      {state.passthrough.length > 0 && (
        <div className="shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-800">
          Esta encuesta tiene {state.passthrough.length} elemento(s) avanzado(s)
          que no se editan visualmente. Se conservan intactos; ajustalos desde{" "}
          <Link href={`/surveys/${id}`} className="underline font-medium">
            JSON avanzado
          </Link>
          .
        </div>
      )}

      {/* Three-pane editor */}
      <div className="flex flex-1 min-h-0">
        <aside className="w-[300px] shrink-0 border-r border-neutral-200 bg-neutral-50">
          <QuestionListPanel
            questions={state.questions}
            selectedId={selectedId}
            accent={state.accent}
            onAdd={addQuestion}
            onReorder={reorder}
            onSelect={setSelectedId}
            onDuplicate={duplicateQuestion}
            onDelete={deleteQuestion}
          />
        </aside>

        <main className="flex-1 min-w-0">
          <LivePreview
            schema={schema}
            accent={state.accent}
            design={state.design}
            language={language}
          />
        </main>

        <aside className="w-[340px] shrink-0 border-l border-neutral-200 bg-white overflow-y-auto">
          <PropertiesPanel
            question={selectedQuestion}
            questions={state.questions}
            onQuestionChange={patchQuestion}
            description={state.description}
            onePerPage={state.onePerPage}
            showProgress={state.showProgress}
            closesAt={state.closesAt}
            maxResponses={state.maxResponses}
            onSurveyChange={(patch) => mutate((prev) => ({ ...prev, ...patch }))}
            evaluation={state.evaluation}
            onEvaluationChange={setEvaluation}
            accent={state.accent}
          />
          {!selectedQuestion && (
            <div className="px-5 pb-6">
              <AccessSettings
                surveyId={id}
                accent={state.accent}
                accessMode={accessMode}
                accessPin={accessPin}
                resultsMode={resultsMode}
                resultsReleased={resultsReleased}
                notifyEmails={notifyEmails}
                onChange={(patch) => {
                  if (patch.accessMode !== undefined) setAccessMode(patch.accessMode);
                  if (patch.accessPin !== undefined) setAccessPin(patch.accessPin);
                  if (patch.resultsMode !== undefined) setResultsMode(patch.resultsMode);
                  if (patch.resultsReleased !== undefined)
                    setResultsReleased(patch.resultsReleased);
                  if (patch.notifyEmails !== undefined)
                    setNotifyEmails(patch.notifyEmails);
                }}
              />
            </div>
          )}
        </aside>
      </div>

      <DesignPanel
        open={designOpen}
        onClose={() => setDesignOpen(false)}
        design={state.design}
        onChange={setDesign}
        accent={state.accent}
        onAccentChange={(accent) => mutate((prev) => ({ ...prev, accent }))}
      />

      <GenerateDialog
        open={genOpen}
        accent={state.accent}
        language={language || "es"}
        onClose={() => setGenOpen(false)}
        onGenerate={async (body) => {
          const res = await surveyApi.generateQuestions(id, body);
          insertGenerated(res.questions || []);
          if (res.usage) setLastUsage(res.usage);
        }}
      />

      {lastUsage && (
        <UsageModal usage={lastUsage} onClose={() => setLastUsage(null)} />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "draft" | "published" | "closed" }) {
  const map = {
    draft: { label: "Borrador", cls: "bg-neutral-100 text-neutral-600" },
    published: { label: "Publicada", cls: "bg-green-100 text-green-700" },
    closed: { label: "Cerrada", cls: "bg-amber-100 text-amber-700" },
  } as const;
  const { label, cls } = map[status];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}
