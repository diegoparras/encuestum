"use client";

/**
 * Generación de preguntas con IA, en dos pasos:
 *  1. Configurar: tema, cantidad, dificultad, tipos, niveles de Bloom,
 *     objetivos y material (texto pegado, archivo PDF/Word/texto o página web).
 *  2. Revisar: cada pregunta con su clave, su nivel y la cita del material que
 *     la respalda (verificada por el servidor). Se puede destildar, regenerar
 *     una sola o pedir variantes, y recién ahí se insertan las elegidas.
 */

import React, { useRef, useState } from "react";
import {
  Sparkles,
  Loader2,
  X,
  Upload,
  FileText,
  Globe,
  RefreshCw,
  Copy,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  Check,
} from "lucide-react";
import { readableForeground } from "./model";
import { useI18n } from "@/lib/i18n";
import {
  surveyApi,
  type GenerateBody,
  type GeneratedQuestion,
  type UsageInfo,
} from "../surveyApi";

interface Props {
  open: boolean;
  accent: string;
  language: string;
  surveyId: string;
  /** Títulos de las preguntas que ya están en el editor (no repetirlas). */
  existingTitles: string[];
  onClose: () => void;
  onInsert: (questions: GeneratedQuestion[]) => void;
  onUsage?: (usage: UsageInfo) => void;
}

const TYPE_OPTIONS = ["radiogroup", "checkbox", "dropdown", "boolean", "text", "comment"];
const BLOOM = ["recordar", "comprender", "aplicar", "analizar", "evaluar", "crear"];

type Item = { q: GeneratedQuestion; selected: boolean; busy?: boolean };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "");

const inputCls =
  "w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500";
const labelCls = "block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1.5";

export function GenerateDialog({
  open,
  accent,
  language,
  surveyId,
  existingTitles,
  onClose,
  onInsert,
  onUsage,
}: Props) {
  const { t } = useI18n();
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState("media");
  const [types, setTypes] = useState<string[]>(["radiogroup", "comment"]);
  const [bloom, setBloom] = useState<string[]>([]);
  const [objectives, setObjectives] = useState("");
  const [context, setContext] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [notes, setNotes] = useState<{ dropped: number; truncated: boolean }>({ dropped: 0, truncated: false });
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  function body(extra: Partial<GenerateBody> = {}): GenerateBody {
    const yaGeneradas = (items ?? []).map((i) => i.q.title);
    return {
      topic: topic.trim(),
      count,
      types,
      language,
      difficulty,
      context: context.trim() || undefined,
      bloom: bloom.length ? bloom : undefined,
      objectives: objectives.trim() || undefined,
      existing_titles: [...existingTitles, ...yaGeneradas],
      ...extra,
    };
  }

  async function leerMaterial(src: { file?: File; url?: string }) {
    setReading(true);
    setError(null);
    try {
      const r = await surveyApi.extractMaterial(surveyId, src);
      setContext((prev) => (prev.trim() ? `${prev.trim()}\n\n${r.text}` : r.text));
      setSource(r.source);
      setUrl("");
    } catch (e) {
      setError(errMsg(e) || t("builder.gen.readFileError"));
    } finally {
      setReading(false);
    }
  }

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await leerMaterial({ file });
  }

  async function generar() {
    if (!topic.trim() || types.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await surveyApi.generateQuestions(surveyId, body({ existing_titles: existingTitles }));
      setItems(res.questions.map((q) => ({ q, selected: true })));
      setNotes({ dropped: res.dropped_duplicates ?? 0, truncated: !!res.material?.truncated });
      if (res.usage) onUsage?.(res.usage);
    } catch (e) {
      setError(errMsg(e) || t("builder.gen.genericError"));
    } finally {
      setLoading(false);
    }
  }

  async function regenerar(idx: number) {
    if (!items) return;
    const actual = items[idx].q;
    setItems(items.map((it, i) => (i === idx ? { ...it, busy: true } : it)));
    try {
      const res = await surveyApi.generateQuestions(
        surveyId,
        body({ count: 1, types: [actual.type], existing_titles: [...existingTitles, ...items.map((i) => i.q.title)] })
      );
      const nueva = res.questions[0];
      setItems((cur) =>
        (cur ?? []).map((it, i) => (i === idx ? { q: nueva ?? it.q, selected: true } : it))
      );
      if (res.usage) onUsage?.(res.usage);
    } catch (e) {
      setError(errMsg(e) || t("builder.gen.genericError"));
      setItems((cur) => (cur ?? []).map((it, i) => (i === idx ? { ...it, busy: false } : it)));
    }
  }

  async function variantes(idx: number) {
    if (!items) return;
    const base = items[idx].q;
    setItems(items.map((it, i) => (i === idx ? { ...it, busy: true } : it)));
    try {
      const res = await surveyApi.generateQuestions(
        surveyId,
        body({ count: 2, types: [base.type], variant_of: base })
      );
      setItems((cur) => {
        const lista = [...(cur ?? [])];
        lista[idx] = { ...lista[idx], busy: false };
        lista.splice(idx + 1, 0, ...res.questions.map((q) => ({ q, selected: true })));
        return lista;
      });
      if (res.usage) onUsage?.(res.usage);
    } catch (e) {
      setError(errMsg(e) || t("builder.gen.genericError"));
      setItems((cur) => (cur ?? []).map((it, i) => (i === idx ? { ...it, busy: false } : it)));
    }
  }

  function insertar() {
    const elegidas = (items ?? []).filter((i) => i.selected).map((i) => i.q);
    if (!elegidas.length) return;
    onInsert(elegidas);
    setItems(null);
    onClose();
  }

  const seleccionadas = (items ?? []).filter((i) => i.selected).length;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className={`w-full ${items ? "max-w-2xl" : "max-w-lg"} rounded-2xl bg-white shadow-2xl dark:bg-neutral-900`}>
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" style={{ color: accent }} />
            <h2 className="text-sm font-semibold dark:text-neutral-100">
              {items ? t("builder.gen.review.title") : t("builder.gen.title")}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t("builder.gen.cancel")}
            className="text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {items ? (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("builder.gen.review.subtitle", { n: items.length })}
              {notes.dropped > 0 && <> {t("builder.gen.review.dropped", { n: notes.dropped })}</>}
              {notes.truncated && <> {t("builder.gen.review.truncated")}</>}
            </p>
            {items.map((it, idx) => (
              <ReviewCard
                key={`${idx}-${it.q.title}`}
                item={it}
                accent={accent}
                onToggle={() =>
                  setItems(items.map((x, i) => (i === idx ? { ...x, selected: !x.selected } : x)))
                }
                onRegenerate={() => regenerar(idx)}
                onVariants={() => variantes(idx)}
              />
            ))}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
            <label className="block">
              <span className={labelCls}>{t("builder.gen.topic")}</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("builder.gen.topicPlaceholder")}
                className={inputCls}
                autoFocus
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelCls}>{t("builder.gen.count")}</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>{t("builder.gen.difficulty")}</span>
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className={`${inputCls} bg-white`}>
                  <option value="fácil">{t("builder.gen.diff.easy")}</option>
                  <option value="media">{t("builder.gen.diff.medium")}</option>
                  <option value="difícil">{t("builder.gen.diff.hard")}</option>
                </select>
              </label>
            </div>

            <Chips
              label={t("builder.gen.types")}
              options={TYPE_OPTIONS.map((v) => ({ value: v, label: t(`builder.gen.type.${v}`) }))}
              selected={types}
              accent={accent}
              onToggle={(v) => toggle(types, setTypes, v)}
            />
            <Chips
              label={t("builder.gen.bloom")}
              options={BLOOM.map((v) => ({ value: v, label: t(`builder.gen.bloom.${v}`) }))}
              selected={bloom}
              accent={accent}
              onToggle={(v) => toggle(bloom, setBloom, v)}
            />

            <label className="block">
              <span className={labelCls}>{t("builder.gen.objectives")}</span>
              <textarea
                value={objectives}
                onChange={(e) => setObjectives(e.target.value)}
                rows={2}
                placeholder={t("builder.gen.objectivesPlaceholder")}
                className={inputCls}
              />
            </label>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  {t("builder.gen.baseMaterial")}
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={reading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  {reading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {reading ? t("builder.gen.reading") : t("builder.gen.uploadDoc")}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,application/pdf,text/plain,text/markdown"
                  onChange={onFilePick}
                  className="hidden"
                />
              </div>
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={3}
                placeholder={t("builder.gen.contextPlaceholder")}
                className={inputCls}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <Globe className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={`${t("builder.gen.url")} (https://…)`}
                  className="min-w-0 flex-1 rounded-md border border-neutral-200 px-2 py-1 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
                <button
                  type="button"
                  onClick={() => url.trim() && leerMaterial({ url: url.trim() })}
                  disabled={reading || !/^https?:\/\//i.test(url.trim())}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {t("builder.gen.fetch")}
                </button>
              </div>
              {(source || context.trim()) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {source && (
                    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-neutral-100 px-2 py-1 dark:bg-neutral-800">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      <span className="truncate">{source}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setSource(null);
                          setContext("");
                        }}
                        className="shrink-0 text-neutral-400 hover:text-neutral-700"
                        aria-label={t("builder.gen.removeFile")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                  <span>{t("builder.gen.materialChars", { n: context.trim().length.toLocaleString() })}</span>
                </div>
              )}
              <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">{t("builder.gen.materialHint")}</p>
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          {items ? (
            <>
              <button
                onClick={() => setItems(null)}
                className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <ArrowLeft className="h-4 w-4" /> {t("builder.gen.review.back")}
              </button>
              <button
                onClick={insertar}
                disabled={!seleccionadas}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ backgroundColor: accent, color: readableForeground(accent) }}
              >
                <Check className="h-4 w-4" />
                {seleccionadas ? t("builder.gen.review.insert", { n: seleccionadas }) : t("builder.gen.review.none")}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                {t("builder.gen.cancel")}
              </button>
              <button
                onClick={generar}
                disabled={loading || reading || !topic.trim() || types.length === 0}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ backgroundColor: accent, color: readableForeground(accent) }}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {t("builder.gen.generate")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Chips({
  label,
  options,
  selected,
  accent,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  accent: string;
  onToggle: (v: string) => void;
}) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const active = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(o.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "border-transparent text-white"
                  : "border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
              }`}
              style={active ? { backgroundColor: accent } : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReviewCard({
  item,
  accent,
  onToggle,
  onRegenerate,
  onVariants,
}: {
  item: Item;
  accent: string;
  onToggle: () => void;
  onRegenerate: () => void;
  onVariants: () => void;
}) {
  const { t } = useI18n();
  const q = item.q;
  const correctas = new Set(q.correctIndices ?? []);
  const porQue = new Map((q.explanations ?? []).map((e) => [e.option, e.why_wrong]));
  return (
    <div
      className={`rounded-xl border p-3 transition-opacity ${
        item.selected ? "border-neutral-200 dark:border-neutral-700" : "border-dashed border-neutral-200 opacity-50 dark:border-neutral-800"
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={item.selected}
          onChange={onToggle}
          className="mt-1 h-4 w-4 shrink-0"
          style={{ accentColor: accent }}
          aria-label={q.title}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{q.title}</p>
          <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {t(`builder.gen.type.${q.type}`)}
            </span>
            {q.bloom && (
              <span className="rounded-full px-2 py-0.5" style={{ backgroundColor: `${accent}1a`, color: accent }}>
                Bloom: {t(`builder.gen.bloom.${q.bloom}`)}
              </span>
            )}
            {q.objective && (
              <span className="truncate rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-500 dark:bg-neutral-800" title={q.objective}>
                {q.objective}
              </span>
            )}
          </div>

          {q.choices?.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm">
              {q.choices.map((c, i) => (
                <li
                  key={i}
                  className={correctas.has(i) ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-neutral-600 dark:text-neutral-300"}
                  title={porQue.get(c) || undefined}
                >
                  {correctas.has(i) ? "✓ " : "· "}
                  {c}
                  {porQue.get(c) && <span className="ml-1 text-[11px] font-normal text-neutral-400">— {porQue.get(c)}</span>}
                </li>
              ))}
            </ul>
          )}
          {q.type === "text" && !!q.acceptableAnswers?.length && (
            <p className="mt-2 text-xs text-neutral-500">
              {t("builder.gen.review.accepts", { list: q.acceptableAnswers.join(" · ") })}
            </p>
          )}
          {(q.type === "comment" || q.type === "boolean") && q.modelAnswer && (
            <p className="mt-2 text-xs text-neutral-500">
              <span className="font-medium">{t("builder.gen.review.modelAnswer")}:</span> {q.modelAnswer}
            </p>
          )}
          {q.sourceQuote && (
            <p
              className={`mt-2 flex items-start gap-1 rounded-md px-2 py-1 text-xs ${
                q.sourceVerified === false
                  ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  : "bg-neutral-50 text-neutral-500 dark:bg-neutral-950"
              }`}
              title={
                q.sourceVerified === false ? t("builder.gen.review.quoteMissing") : t("builder.gen.review.quoteOk")
              }
            >
              {q.sourceVerified === false ? (
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
              )}
              <span>
                “{q.sourceQuote}”
                {q.sourceVerified === false && <> — {t("builder.gen.review.quoteMissing")}</>}
              </span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            onClick={onRegenerate}
            disabled={item.busy}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
          >
            {item.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {t("builder.gen.review.regenerate")}
          </button>
          <button
            onClick={onVariants}
            disabled={item.busy}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
          >
            <Copy className="h-3 w-3" /> {t("builder.gen.review.variants")}
          </button>
        </div>
      </div>
    </div>
  );
}
