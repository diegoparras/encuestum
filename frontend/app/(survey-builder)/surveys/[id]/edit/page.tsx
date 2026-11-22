"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
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
import { GraduationCap, Sparkles, Palette, SpellCheck2, Undo2, Redo2, Keyboard, History, Library } from "lucide-react";
import { useUndoHistory } from "@/lib/useUndoHistory";
import {
  surveyApi,
  type UsageInfo,
  type AccessMode,
  type ResultsMode,
} from "../../../surveyApi";
import { toast } from "sonner";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError } from "@/components/LoadError";
import { useI18n } from "@/lib/i18n";
import { useDialogA11y } from "@/lib/useDialogA11y";
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
import { AccentPicker } from "../../../builder/AccentPicker";
import { DesignPanel } from "../../../builder/DesignPanel";
import { GenerateDialog } from "../../../builder/GenerateDialog";
import { WordingReviewDialog } from "../../../builder/WordingReview";
import { VersionHistoryDialog } from "../../../builder/VersionHistory";
import { BankDialog, type ElementsToInsert } from "../../../builder/BankDialog";

// SurveyJS es pesado: diferimos la vista previa a un chunk perezoso (ssr:false)
// para que no entre en el bundle inicial del editor. El registro del tipo de
// pregunta "videoresponse" vive dentro de LivePreview y corre al cargar el chunk.
const LivePreview = dynamic(
  () => import("../../../builder/LivePreview").then((m) => m.LivePreview),
  {
    ssr: false,
    loading: () => <PreviewLoading />,
  }
);

function PreviewLoading() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t("builder.page.loadingPreview")}
    </div>
  );
}

export default function SurveyEditorPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();

  const [state, setState] = useState<BuilderState | null>(null);
  const [status, setStatus] = useState<"draft" | "published" | "closed">("draft");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [language, setLanguage] = useState<string | null>("es");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Control de acceso y visibilidad de resultados (se persisten al vuelo).
  const [accessMode, setAccessMode] = useState<AccessMode>("public");
  const [accessPin, setAccessPin] = useState<string | null>(null);
  const [resultsMode, setResultsMode] = useState<ResultsMode>("immediate");
  const [resultsReleased, setResultsReleased] = useState(false);
  const [notifyEmails, setNotifyEmails] = useState("");
  const [requireCaptcha, setRequireCaptcha] = useState(false);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  // Estado del autosave: alimenta el indicador junto al botón Guardar.
  const [autoStatus, setAutoStatus] = useState<"idle" | "saving" | "saved" | "error" | "conflict">(
    "idle"
  );
  // Huella del contenido tal como lo vio este editor (al cargar o al último
  // guardado). Viaja en cada guardado: si no coincide con la del servidor,
  // otra pestaña u otra persona cambió la encuesta y no se pisa sin avisar.
  const contentHashRef = useRef<string | null>(null);
  // Evita autosaves concurrentes (si hay un save en vuelo, se espera al próximo tick).
  const savingRef = useRef(false);
  // Secuencia de cambios: si el usuario editó mientras se guardaba, no marcamos "limpio".
  const changeSeqRef = useRef(0);
  const [genOpen, setGenOpen] = useState(false);
  const [wordingOpen, setWordingOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);
  const sumarUso = useCallback(
    (u: UsageInfo) =>
      setLastUsage((prev) =>
        prev
          ? {
              ...u,
              prompt_tokens: (prev.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
              completion_tokens: (prev.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
              total_tokens: (prev.total_tokens ?? 0) + (u.total_tokens ?? 0),
              cost_usd:
                prev.cost_usd == null && u.cost_usd == null ? null : (prev.cost_usd ?? 0) + (u.cost_usd ?? 0),
            }
          : u
      ),
    []
  );

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
    built.opensAt = s.opens_at ?? null;
    built.closesAt = s.closes_at;
    built.maxResponses = s.max_responses;
    built.maxAttempts = s.max_attempts ?? null;
    built.thankyouMessage = s.thankyou_message ?? "";
    built.gradingMessage = s.grading_message ?? "";
    built.redirectUrl = s.redirect_url ?? "";
    return { survey: s, built };
  }, [id]);


  // Mutations ---------------------------------------------------------------
  // Marca cambios pendientes e incrementa la secuencia (para que un save en
  // vuelo no marque "limpio" si el usuario siguió editando mientras tanto).
  const markDirty = useCallback(() => {
    changeSeqRef.current += 1;
    setDirty(true);
  }, []);

  const mutate = useCallback(
    (fn: (prev: BuilderState) => BuilderState) => {
      setState((prev) => (prev ? fn(prev) : prev));
      markDirty();
    },
    [markDirty]
  );

  const addQuestion = useCallback(
    (type: QuestionType) => {
      setState((prev) => {
        if (!prev) return prev;
        const q = createQuestion(type, prev.questions.length);
        setSelectedId(q.id);
        return { ...prev, questions: [...prev.questions, q] };
      });
      markDirty();
    },
    [markDirty]
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
      markDirty();
    },
    [markDirty]
  );

  const deleteQuestion = useCallback(
    (qid: string) => {
      setState((prev) =>
        prev
          ? { ...prev, questions: prev.questions.filter((q) => q.id !== qid) }
          : prev
      );
      setSelectedId((cur) => (cur === qid ? null : cur));
      markDirty();
    },
    [markDirty]
  );

  // Deshacer / rehacer (Ctrl+Z / Ctrl+Shift+Z): observa los cambios de
  // `state`, así no hace falta tocar cada mutación.
  const historia = useUndoHistory(state, setState as (s: BuilderState) => void, {
    onChange: markDirty,
    // Se agrupa sólo lo que no cambia la estructura (escribir en un campo):
    // agregar, borrar o mover una pregunta es siempre un paso propio.
    canCoalesce: (a, b) =>
      a.questions.length === b.questions.length &&
      a.questions.every((q, i) => q.id === b.questions[i]?.id),
  });
  const resetHistoria = historia.reset;

  // Inicializa el estado editable cuando llega (o se recarga) la encuesta.
  useEffect(() => {
    if (!loaded) return;
    const s = loaded.survey;
    contentHashRef.current = s.content_hash ?? null;
    setAutoStatus((a) => (a === "conflict" ? "idle" : a));
    resetHistoria();
    setState(loaded.built);
    setStatus(s.status);
    setSlug(s.slug);
    setTimezone(s.timezone ?? "UTC");
    setLanguage(s.language ?? "es");
    setAccessMode(s.access_mode ?? "public");
    setAccessPin(s.access_pin ?? null);
    setResultsMode(s.results_mode ?? "immediate");
    setResultsReleased(s.results_released ?? false);
    setNotifyEmails(s.notify_emails ?? "");
    setRequireCaptcha(s.require_captcha ?? false);
    setDirty(false);
  }, [loaded, resetHistoria]);

  const moveSelected = useCallback(
    (delta: number) => {
      if (!selectedId) return;
      mutate((prev) => {
        const i = prev.questions.findIndex((q) => q.id === selectedId);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= prev.questions.length) return prev;
        const qs = [...prev.questions];
        [qs[i], qs[j]] = [qs[j], qs[i]];
        return { ...prev, questions: qs };
      });
    },
    [selectedId, mutate]
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

  // Preguntas que llegan como elementos de SurveyJS + su corrección (banco de
  // preguntas, importación GIFT/Aiken/Moodle). Los nombres se renombran si
  // chocan con los del editor; con `group`, quedan como grupo de sorteo.
  const insertElements = useCallback(
    (x: ElementsToInsert) => {
      setState((prev) => {
        if (!prev) return prev;
        const usados = new Set(prev.questions.map((q) => q.name));
        const renombre: Record<string, string> = {};
        const els = x.elements.map((el) => {
          const base = String(el.name || "pregunta");
          let nombre = base;
          for (let i = 2; usados.has(nombre); i++) nombre = `${base}_${i}`;
          usados.add(nombre);
          renombre[base] = nombre;
          return { ...el, name: nombre, ...(x.group ? { encGroup: x.group.name } : {}) };
        });
        const ev: Record<string, Record<string, unknown>> = {};
        for (const [k, v] of Object.entries(x.evaluationQuestions)) ev[renombre[k] ?? k] = v;
        const built = schemaToBuilder({ pages: [{ name: "p", elements: els }] }, "", prev.accent, {
          enabled: true,
          questions: ev,
        });
        const conCorreccion = Object.keys(ev).length > 0;
        return {
          ...prev,
          questions: [...prev.questions, ...built.questions],
          evaluation: {
            ...prev.evaluation,
            enabled: prev.evaluation.enabled || conCorreccion,
            integrity: x.group
              ? {
                  ...prev.evaluation.integrity,
                  groups: { ...(prev.evaluation.integrity.groups ?? {}), [x.group.name]: x.group.count },
                }
              : prev.evaluation.integrity,
          },
        };
      });
      markDirty();
    },
    [markDirty]
  );

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
    markDirty();
  }, [markDirty]);

  // Derived -----------------------------------------------------------------
  const schema = useMemo(
    () => (state ? builderToSchema(state) : {}),
    [state]
  );
  const selectedQuestion =
    state?.questions.find((q) => q.id === selectedId) ?? null;

  // Actions -----------------------------------------------------------------
  // Guarda la encuesta. Con `silent: true` (autosave) no molesta al usuario:
  // sin alert de error (solo el indicador "Sin guardar") y sin tilde del botón.
  async function save(opts: { silent?: boolean; force?: boolean } = {}) {
    if (!state || savingRef.current) return;
    savingRef.current = true;
    const seqAtStart = changeSeqRef.current;
    setSaving(true);
    // El botón manual ya muestra su propio spinner; el indicador "Guardando…"
    // es para el autosave.
    if (opts.silent) setAutoStatus("saving");
    let forzar = false;
    try {
      const updated = await surveyApi.update(id, {
        base_content_hash: opts.force ? null : contentHashRef.current,
        // Guardado a mano: deja una versión en el historial.
        snapshot: !opts.silent,
        title: state.title,
        json_schema: builderToSchema(state),
        theme: designToTheme(state.accent, state.design),
        evaluation: builderToEvaluation(state),
        opens_at: state.opensAt,
        closes_at: state.closesAt,
        max_responses: state.maxResponses,
        max_attempts: state.maxAttempts,
        thankyou_message: state.thankyouMessage,
        grading_message: state.gradingMessage,
        redirect_url: state.redirectUrl,
        language,
      });
      contentHashRef.current = updated?.content_hash ?? null;
      // Solo marcamos "limpio" si no hubo ediciones mientras viajaba el request.
      if (changeSeqRef.current === seqAtStart) setDirty(false);
      if (opts.silent) {
        setAutoStatus("saved");
        setTimeout(
          () => setAutoStatus((s) => (s === "saved" ? "idle" : s)),
          2500
        );
      } else {
        setAutoStatus("idle"); // limpia un "Sin guardar" previo
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1800);
      }
    } catch (e: any) {
      if (e?.status === 409) {
        // Conflicto de edición: el autosave se detiene (seguir guardando
        // pisaría el trabajo ajeno). Se decide a mano: recargar o sobrescribir.
        setAutoStatus("conflict");
        if (!opts.silent) forzar = window.confirm(t("builder.page.conflictConfirm"));
        return;
      }
      // El autosave no spamea toasts: deja el indicador rojo y reintenta con
      // el próximo cambio. El aviso ruidoso queda para el guardado manual.
      setAutoStatus("error");
      if (!opts.silent) alert(e?.message || t("builder.page.saveError"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    // Recién acá, con el guardado anterior cerrado: "sobrescribir" vuelve a
    // guardar sin la huella, a sabiendas de que pisa el cambio ajeno.
    if (forzar) await save({ force: true });
  }

  // El autosave siempre reutiliza el MISMO save() de arriba (última versión,
  // vía ref, para que el timer no capture estado viejo).
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  // Atajos de teclado del editor. Ctrl+Z / Ctrl+Shift+Z también dentro de los
  // campos de texto: la historia agrupa lo tipeado en ráfagas, así que deshacer
  // vuelve atrás la palabra (y además lo hace sobre TODO el editor, no sólo el
  // campo). Duplicar/borrar/mover sólo con una pregunta elegida y fuera de un
  // campo de texto, para no pelear con la edición.
  const [atajosOpen, setAtajosOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const el = e.target as HTMLElement | null;
      const escribiendo =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) historia.redo();
        else historia.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        historia.redo();
      } else if (mod && k === "s") {
        e.preventDefault();
        void saveRef.current();
      } else if (mod && k === "d" && selectedId && !escribiendo) {
        e.preventDefault();
        duplicateQuestion(selectedId);
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && selectedId) {
        e.preventDefault();
        moveSelected(e.key === "ArrowUp" ? -1 : 1);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !escribiendo && !mod) {
        e.preventDefault();
        deleteQuestion(selectedId); // se puede deshacer con Ctrl+Z
      } else if (e.key === "?" && !escribiendo) {
        setAtajosOpen((o) => !o);
      } else if (e.key === "Escape" && atajosOpen) {
        setAtajosOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historia, selectedId, duplicateQuestion, deleteQuestion, moveSelected, atajosOpen]);

  // Autosave con debounce: ~2.5s después del último cambio. Cada edición
  // reinicia el timer (el efecto depende de `state`). Se pausa mientras el
  // diálogo de IA está abierto (generación en curso) o durante publicar.
  useEffect(() => {
    if (!dirty || genOpen || publishing || autoStatus === "conflict") return;
    const timer = setTimeout(() => {
      // Si ya hay un save en vuelo, no encimamos: el próximo cambio (o el
      // propio save al no limpiar `dirty`) volverá a programar el autosave.
      if (savingRef.current) return;
      void saveRef.current({ silent: true });
    }, 2500);
    return () => clearTimeout(timer);
  }, [dirty, state, language, genOpen, publishing, autoStatus]);

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
      alert(e?.message || t("builder.page.statusError"));
    } finally {
      setPublishing(false);
    }
  }

  // Link personalizado: guardado dedicado (fuera del autosave) para dar feedback
  // claro si el link ya está en uso o es inválido.
  const commitSlug = useCallback(
    async (newSlug: string) => {
      try {
        const updated = await surveyApi.update(id, { slug: newSlug });
        setSlug(updated.slug);
        toast.success(t("builder.page.linkUpdated"));
      } catch (e: any) {
        toast.error(e?.message || t("builder.page.linkError"));
      }
    },
    [id, t]
  );

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
          className="inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ArrowLeft className="w-4 h-4" /> {t("builder.page.surveys")}
        </Link>
        <div className="mt-6">
          <LoadError message={loadError} onRetry={reload} />
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="h-screen grid place-items-center text-neutral-400 dark:text-neutral-500 text-sm">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> {t("builder.page.loadingEditor")}
        </span>
      </div>
    );
  }

  const isPublished = status === "published";
  const accentFg = readableForeground(state.accent);

  return (
    <div className="flex h-screen flex-col bg-neutral-50 dark:bg-neutral-950">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 h-14 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shrink-0">
        <Link
          href="/surveys"
          className="inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <input
          value={state.title}
          onChange={(e) => mutate((prev) => ({ ...prev, title: e.target.value }))}
          placeholder={t("builder.page.titlePlaceholder")}
          className="min-w-0 flex-1 text-sm font-semibold bg-transparent outline-none border-b border-transparent focus:border-neutral-300 dark:focus:border-neutral-600 py-1"
        />

        <StatusBadge status={status} />

        <div className="flex items-center gap-2 shrink-0">
          <div className="inline-flex items-center rounded-lg border border-neutral-200 dark:border-neutral-800">
            <button
              onClick={historia.undo}
              disabled={!historia.canUndo}
              title={`${t("builder.page.undo")} (Ctrl+Z)`}
              aria-label={t("builder.page.undo")}
              className="p-1.5 text-neutral-600 hover:bg-neutral-50 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              onClick={historia.redo}
              disabled={!historia.canRedo}
              title={`${t("builder.page.redo")} (Ctrl+Shift+Z)`}
              aria-label={t("builder.page.redo")}
              className="p-1.5 text-neutral-600 hover:bg-neutral-50 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Redo2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setVersionsOpen(true)}
              title={t("builder.versions.title")}
              aria-label={t("builder.versions.title")}
              className="p-1.5 text-neutral-500 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <History className="w-4 h-4" />
            </button>
            <button
              onClick={() => setAtajosOpen(true)}
              title={`${t("builder.page.shortcuts")} (?)`}
              aria-label={t("builder.page.shortcuts")}
              className="p-1.5 text-neutral-500 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <Keyboard className="w-4 h-4" />
            </button>
          </div>
          <Link
            href={`/surveys/${id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            title={t("builder.page.responsesTitle")}
          >
            <ListChecks className="w-4 h-4" /> {t("builder.page.responses")}
          </Link>

          <button
            onClick={toggleEvaluation}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              state.evaluation.enabled
                ? "border-transparent text-white"
                : "border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            }`}
            style={
              state.evaluation.enabled
                ? { backgroundColor: state.accent, color: accentFg }
                : undefined
            }
            title={t("builder.page.examTitle")}
          >
            <GraduationCap className="w-4 h-4" /> {t("builder.page.exam")}
          </button>

          <button
            onClick={() => setGenOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            title={t("builder.page.aiTitle")}
          >
            <Sparkles className="w-4 h-4" /> {t("builder.page.ai")}
          </button>

          <button
            onClick={() => setBankOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            title={t("builder.bank.title")}
          >
            <Library className="w-4 h-4" /> {t("builder.page.bank")}
          </button>

          <button
            onClick={() => setWordingOpen(true)}
            disabled={!state.questions.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={t("builder.page.wordingTitle")}
          >
            <SpellCheck2 className="w-4 h-4" /> {t("builder.page.wording")}
          </button>

          <button
            onClick={() => setDesignOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            title={t("builder.page.designTitle")}
          >
            <Palette className="w-4 h-4" /> {t("builder.page.design")}
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              {t("builder.page.view")} <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

          {/* Indicador de autosave: guardando / guardado / sin guardar */}
          {autoStatus === "saving" ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              <Loader2 className="w-3 h-3 animate-spin" /> {t("builder.page.saving")}
            </span>
          ) : autoStatus === "saved" ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              <Check className="w-3 h-3" /> {t("builder.page.saved")}
            </span>
          ) : autoStatus === "conflict" ? (
            <button
              onClick={() => reload()}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 underline"
              title={t("builder.page.conflictTitle")}
            >
              {t("builder.page.conflict")}
            </button>
          ) : autoStatus === "error" ? (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600"
              title={t("builder.page.unsavedTitle")}
            >
              {t("builder.page.unsaved")}
            </span>
          ) : null}

          <button
            onClick={() => save()}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : savedTick ? (
              <Check className="w-4 h-4 text-green-600" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {savedTick ? t("builder.page.saved") : dirty ? t("builder.page.save") : t("builder.page.upToDate")}
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
            {isPublished
              ? t("builder.page.close")
              : status === "closed"
                ? t("builder.page.reopen")
                : t("builder.page.publish")}
          </button>
        </div>
      </header>

      {state.passthrough.length > 0 && (
        <div className="shrink-0 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-xs text-amber-800 dark:text-amber-300">
          {t("builder.page.passthroughPre", { n: state.passthrough.length })}{" "}
          <Link href={`/surveys/${id}`} className="underline font-medium">
            {t("builder.page.passthroughLink")}
          </Link>
          .
        </div>
      )}

      {/* Three-pane editor. En pantallas chicas mantenemos un ancho mínimo y
          dejamos scroll horizontal: así, al reducir el zoom del navegador, los
          tres paneles conservan su tamaño y la vista previa sigue siendo legible
          (en vez de que el panel central se aplaste a una franja). */}
      <div className="flex flex-1 min-h-0 overflow-x-auto">
        <div className="flex h-full w-full min-w-[900px]">
        <aside className="w-[300px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
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

        <aside className="w-[340px] shrink-0 border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-y-auto">
          <PropertiesPanel
            question={selectedQuestion}
            questions={state.questions}
            onQuestionChange={patchQuestion}
            onBack={() => setSelectedId(null)}
            description={state.description}
            onePerPage={state.onePerPage}
            showProgress={state.showProgress}
            opensAt={state.opensAt}
            closesAt={state.closesAt}
            maxResponses={state.maxResponses}
            maxAttempts={state.maxAttempts}
            thankyouMessage={state.thankyouMessage}
            gradingMessage={state.gradingMessage}
            redirectUrl={state.redirectUrl}
            slug={slug}
            onSlugCommit={commitSlug}
            timezone={timezone}
            onSurveyChange={(patch) => mutate((prev) => ({ ...prev, ...patch }))}
            evaluation={state.evaluation}
            onEvaluationChange={setEvaluation}
            accent={state.accent}
            surveyId={id}
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
                requireCaptcha={requireCaptcha}
                onChange={(patch) => {
                  if (patch.accessMode !== undefined) setAccessMode(patch.accessMode);
                  if (patch.accessPin !== undefined) setAccessPin(patch.accessPin);
                  if (patch.resultsMode !== undefined) setResultsMode(patch.resultsMode);
                  if (patch.resultsReleased !== undefined)
                    setResultsReleased(patch.resultsReleased);
                  if (patch.notifyEmails !== undefined)
                    setNotifyEmails(patch.notifyEmails);
                  if (patch.requireCaptcha !== undefined)
                    setRequireCaptcha(patch.requireCaptcha);
                }}
              />
            </div>
          )}
        </aside>
        </div>
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
        surveyId={id}
        existingTitles={state.questions.map((q) => q.title).filter(Boolean)}
        onClose={() => setGenOpen(false)}
        onInsert={insertGenerated}
        onUsage={sumarUso}
      />

      {atajosOpen && <ShortcutsDialog onClose={() => setAtajosOpen(false)} />}

      {bankOpen && (
        <BankDialog
          surveyId={id}
          accent={state.accent}
          onClose={() => setBankOpen(false)}
          onInsert={insertElements}
          editorItems={(() => {
            const els = ((schema as { pages?: { elements?: Record<string, unknown>[] }[] }).pages ?? []).flatMap(
              (p) => p.elements ?? []
            );
            const ev = (builderToEvaluation(state)?.questions ?? {}) as Record<string, Record<string, unknown>>;
            return state.questions
              .map((q) => {
                const el = els.find((e) => e.name === q.name);
                return el ? { name: q.name, title: q.title, element: el, grading: ev[q.name] ?? null } : null;
              })
              .filter((x): x is NonNullable<typeof x> => x !== null);
          })()}
        />
      )}

      {versionsOpen && (
        <VersionHistoryDialog
          surveyId={id}
          currentSchema={schema}
          accent={state.accent}
          onClose={() => setVersionsOpen(false)}
          // Recarga la encuesta restaurada (y limpia deshacer: lo anterior
          // quedó guardado como versión).
          onRestored={reload}
        />
      )}

      {wordingOpen && (
        <WordingReviewDialog
          surveyId={id}
          questions={state.questions}
          accent={state.accent}
          onClose={() => setWordingOpen(false)}
          onUsage={sumarUso}
          onApply={(qid, title) =>
            mutate((prev) => ({
              ...prev,
              questions: prev.questions.map((q) => (q.id === qid ? { ...q, title } : q)),
            }))
          }
        />
      )}

      {/* Se muestra al cerrar el generador o la revisión (encima los taparía),
          con el consumo sumado de todas las llamadas de esa sesión. */}
      {lastUsage && !genOpen && !wordingOpen && (
        <UsageModal usage={lastUsage} onClose={() => setLastUsage(null)} />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "draft" | "published" | "closed" }) {
  const { t } = useI18n();
  const map = {
    draft: { key: "builder.page.status.draft", cls: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" },
    published: { key: "builder.page.status.published", cls: "bg-green-100 text-green-700 dark:bg-green-950/40" },
    closed: { key: "builder.page.status.closed", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/40" },
  } as const;
  const { key, cls } = map[status];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}>
      {t(key)}
    </span>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const panelRef = useDialogA11y(onClose);
  const filas: [string, string][] = [
    ["Ctrl + Z", t("builder.page.undo")],
    ["Ctrl + Shift + Z", t("builder.page.redo")],
    ["Ctrl + S", t("builder.page.save")],
    ["Ctrl + D", t("builder.keys.duplicate")],
    ["Alt + ↑ / ↓", t("builder.keys.move")],
    ["Supr", t("builder.keys.delete")],
    ["?", t("builder.page.shortcuts")],
  ];
  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("builder.page.shortcuts")}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl outline-none dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold dark:text-neutral-100">{t("builder.page.shortcuts")}</h2>
        <dl className="space-y-1.5 text-sm">
          {filas.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <dt className="text-neutral-600 dark:text-neutral-300">{v}</dt>
              <dd>
                <kbd className="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-800">
                  {k}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-neutral-400">{t("builder.keys.hint")}</p>
      </div>
    </div>
  );
}
