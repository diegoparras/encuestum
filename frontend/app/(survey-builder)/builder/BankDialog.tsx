"use client";

/**
 * Banco de preguntas e intercambio, desde el editor:
 *  - Banco: buscar y filtrar por tema/etiqueta, ver cómo le fue a cada pregunta
 *    en otros exámenes e insertarlas (opcionalmente como grupo de sorteo).
 *  - Guardar: mandar preguntas del editor al banco con tema y etiquetas.
 *  - Importar: GIFT, Aiken o Moodle XML al editor (y, si se quiere, al banco).
 *  - Exportar: las preguntas de esta encuesta en GIFT o Moodle XML.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Library, Loader2, Search, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { useDialogA11y } from "@/lib/useDialogA11y";
import { surveyApi, type BankItem } from "../surveyApi";

type Tab = "bank" | "save" | "import" | "export";

export interface ElementsToInsert {
  elements: Record<string, unknown>[];
  evaluationQuestions: Record<string, Record<string, unknown>>;
  group?: { name: string; count: number };
}

export function BankDialog({
  surveyId,
  accent,
  editorItems,
  onInsert,
  onClose,
}: {
  surveyId: string;
  accent: string;
  /** Preguntas del editor ya serializadas: nombre, título, elemento y corrección. */
  editorItems: { name: string; title: string; element: Record<string, unknown>; grading: Record<string, unknown> | null }[];
  onInsert: (x: ElementsToInsert) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useDialogA11y(onClose);
  const [tab, setTab] = useState<Tab>("bank");

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t("builder.bank.title")}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl outline-none dark:bg-neutral-900"
      >
        <header className="flex items-center gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <Library className="h-5 w-5" style={{ color: accent }} />
          <h2 className="flex-1 text-sm font-semibold dark:text-neutral-100">{t("builder.bank.title")}</h2>
          <button onClick={onClose} aria-label={t("builder.wording.close")} className="text-neutral-400 hover:text-neutral-700">
            <X className="h-5 w-5" />
          </button>
        </header>
        <nav className="flex gap-1 border-b border-neutral-100 px-5 dark:border-neutral-800" role="tablist">
          {(["bank", "save", "import", "export"] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium ${
                tab === k ? "text-neutral-900 dark:text-neutral-100" : "border-transparent text-neutral-500"
              }`}
              style={tab === k ? { borderColor: accent } : undefined}
            >
              {t(`builder.bank.tab.${k}`)}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "bank" && <BankTab accent={accent} onInsert={(x) => { onInsert(x); onClose(); }} />}
          {tab === "save" && <SaveTab surveyId={surveyId} accent={accent} items={editorItems} />}
          {tab === "import" && <ImportTab surveyId={surveyId} accent={accent} onInsert={(x) => { onInsert(x); onClose(); }} />}
          {tab === "export" && (
            <div className="space-y-3 text-sm">
              <p className="text-neutral-600 dark:text-neutral-300">{t("builder.bank.exportHint")}</p>
              <div className="flex gap-2">
                <a href={surveyApi.exportQuestionsUrl(surveyId, "gift")} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium dark:border-neutral-700">
                  GIFT (.txt)
                </a>
                <a href={surveyApi.exportQuestionsUrl(surveyId, "moodle")} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium dark:border-neutral-700">
                  Moodle XML
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const btnCls = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50";
const inputCls =
  "w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";

function BankTab({ accent, onInsert }: { accent: string; onInsert: (x: ElementsToInsert) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("");
  const [items, setItems] = useState<BankItem[] | null>(null);
  const [facets, setFacets] = useState<{ topics: { value: string; count: number }[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [comoGrupo, setComoGrupo] = useState(false);
  const [grupo, setGrupo] = useState("");
  const [n, setN] = useState(1);
  const [stats, setStats] = useState<Record<string, string>>({});

  useEffect(() => {
    surveyApi.bankFacets().then(setFacets).catch(() => setFacets({ topics: [] }));
  }, []);
  useEffect(() => {
    const h = setTimeout(() => {
      surveyApi.listBank({ q, topic }).then(setItems).catch(() => setItems([]));
    }, 250);
    return () => clearTimeout(h);
  }, [q, topic]);

  async function verStats(i: BankItem) {
    const s = await surveyApi.bankItemStats(i.id);
    setStats((p) => ({
      ...p,
      [i.id]: s.responses
        ? t("builder.bank.statsLine", { used: s.used_in, n: s.responses, p: Math.round((s.difficulty ?? 0) * 100) })
        : t("builder.bank.statsNone"),
    }));
  }

  async function borrar(i: BankItem) {
    if (!window.confirm(t("builder.bank.deleteConfirm"))) return;
    await surveyApi.deleteBankItem(i.id);
    setItems((cur) => (cur ?? []).filter((x) => x.id !== i.id));
  }

  function insertar() {
    const elegidas = (items ?? []).filter((i) => sel.has(i.id));
    const evaluationQuestions: Record<string, Record<string, unknown>> = {};
    const elements = elegidas.map((i) => {
      const name = String(i.element.name || `banco_${i.id.slice(0, 6)}`);
      if (i.grading) evaluationQuestions[name] = i.grading;
      return { ...i.element, name, encBankId: i.id };
    });
    onInsert({
      elements,
      evaluationQuestions,
      group: comoGrupo && grupo.trim() ? { name: grupo.trim(), count: Math.min(n, elegidas.length) } : undefined,
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <label className="flex flex-1 items-center gap-2 rounded-md border border-neutral-200 px-2.5 dark:border-neutral-700">
          <Search className="h-3.5 w-3.5 text-neutral-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("builder.bank.search")} className="w-full bg-transparent py-1.5 text-sm outline-none" />
        </label>
        <select value={topic} onChange={(e) => setTopic(e.target.value)} className="rounded-md border border-neutral-200 bg-white px-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
          <option value="">{t("builder.bank.allTopics")}</option>
          {facets?.topics.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </select>
      </div>
      {items === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">{t("builder.bank.empty")}</p>
      ) : (
        <ul className="max-h-80 space-y-1.5 overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-2 rounded-lg border border-neutral-100 p-2 dark:border-neutral-800">
              <input
                type="checkbox"
                checked={sel.has(i.id)}
                onChange={() => {
                  const s = new Set(sel);
                  if (s.has(i.id)) s.delete(i.id);
                  else s.add(i.id);
                  setSel(s);
                }}
                aria-label={i.title}
                className="mt-1"
                style={{ accentColor: accent }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-neutral-800 dark:text-neutral-100">{i.title}</p>
                <p className="text-[11px] text-neutral-400">
                  {[i.type, i.topic, ...(i.tags ?? [])].filter(Boolean).join(" · ")}
                  {stats[i.id] ? ` · ${stats[i.id]}` : ""}
                </p>
              </div>
              {!stats[i.id] && (
                <button onClick={() => verStats(i)} className="text-[11px] text-neutral-500 underline">
                  {t("builder.bank.stats")}
                </button>
              )}
              <button onClick={() => borrar(i)} aria-label={t("builder.bank.delete")} className="text-neutral-300 hover:text-red-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" checked={comoGrupo} onChange={(e) => setComoGrupo(e.target.checked)} style={{ accentColor: accent }} />
        {t("builder.bank.asGroup")}
      </label>
      {comoGrupo && (
        <div className="flex items-center gap-2 text-xs">
          <input value={grupo} onChange={(e) => setGrupo(e.target.value)} placeholder={t("builder.exam.groupPlaceholder")} className={inputCls} />
          {t("builder.exam.show")}
          <input type="number" min={1} value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))} className="w-16 rounded-md border border-neutral-200 px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-800" />
          {t("builder.exam.ofN", { n: sel.size })}
        </div>
      )}
      <div className="flex justify-end">
        <button onClick={insertar} disabled={!sel.size || (comoGrupo && !grupo.trim())} className={btnCls} style={{ backgroundColor: accent }}>
          {t("builder.bank.insert", { n: sel.size })}
        </button>
      </div>
    </div>
  );
}

function SaveTab({
  surveyId,
  accent,
  items,
}: {
  surveyId: string;
  accent: string;
  items: { name: string; title: string; element: Record<string, unknown>; grading: Record<string, unknown> | null }[];
}) {
  const { t } = useI18n();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);

  async function guardar() {
    setBusy(true);
    try {
      const r = await surveyApi.saveToBank(
        items
          .filter((i) => sel.has(i.name))
          .map((i) => ({
            element: i.element,
            grading: i.grading,
            topic: topic.trim() || undefined,
            tags: tags.split(",").map((x) => x.trim()).filter(Boolean),
            source_survey_id: surveyId,
          }))
      );
      toast.success(t("builder.bank.saved", { n: r.created }));
      setSel(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {items.map((i) => (
          <li key={i.name}>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={sel.has(i.name)}
                onChange={() => {
                  const s = new Set(sel);
                  if (s.has(i.name)) s.delete(i.name);
                  else s.add(i.name);
                  setSel(s);
                }}
                style={{ accentColor: accent }}
              />
              <span className="truncate">{i.title}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("builder.bank.topic")} className={inputCls} />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("builder.bank.tags")} className={inputCls} />
      </div>
      <div className="flex justify-end">
        <button onClick={guardar} disabled={!sel.size || busy} className={btnCls} style={{ backgroundColor: accent }}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} {t("builder.bank.save", { n: sel.size })}
        </button>
      </div>
    </div>
  );
}

function ImportTab({ surveyId, accent, onInsert }: { surveyId: string; accent: string; onInsert: (x: ElementsToInsert) => void }) {
  const { t } = useI18n();
  const [texto, setTexto] = useState("");
  const [busy, setBusy] = useState(false);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [alBanco, setAlBanco] = useState(false);
  const [topic, setTopic] = useState("");
  const placeholder = useMemo(() => "::P1:: ¿Capital de Francia? {=París ~Lyon ~Niza}\n\n::P2:: El sol es una estrella {T}", []);

  async function importar(src: { file?: File; text?: string }) {
    setBusy(true);
    setAvisos([]);
    try {
      const r = await surveyApi.importQuestions(surveyId, src);
      setAvisos(r.warnings);
      if (alBanco) {
        await surveyApi.saveToBank(
          r.elements.map((el) => ({
            element: el,
            grading: r.evaluation_questions[String(el.name)] ?? null,
            topic: topic.trim() || undefined,
          }))
        );
      }
      onInsert({ elements: r.elements, evaluationQuestions: r.evaluation_questions });
      toast.success(t("builder.bank.imported", { n: r.elements.length }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">{t("builder.bank.importHint")}</p>
      <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={6} placeholder={placeholder} className={`${inputCls} font-mono text-xs`} />
      <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" checked={alBanco} onChange={(e) => setAlBanco(e.target.checked)} style={{ accentColor: accent }} />
        {t("builder.bank.alsoBank")}
      </label>
      {alBanco && <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("builder.bank.topic")} className={inputCls} />}
      {avisos.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">
          {avisos.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium dark:border-neutral-700">
          <Upload className="h-3.5 w-3.5" /> {t("builder.bank.file")}
          <input
            type="file"
            accept=".txt,.gift,.xml,text/plain,application/xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importar({ file: f });
            }}
          />
        </label>
        <button onClick={() => importar({ text: texto })} disabled={busy || !texto.trim()} className={btnCls} style={{ backgroundColor: accent }}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} {t("builder.bank.importBtn")}
        </button>
      </div>
    </div>
  );
}
