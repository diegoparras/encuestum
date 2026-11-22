"use client";

/**
 * Colaboración sobre una encuesta: comentarios (generales o de una pregunta)
 * y el estado del pedido de publicación cuando la organización lo exige.
 */

import React, { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { surveyApi, type SurveyComment, type SurveyDetail } from "./surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";

export function CommentsPanel({
  surveyId,
  questions = [],
}: {
  surveyId: string;
  /** Para poder comentar una pregunta puntual: [nombre, título]. */
  questions?: { name: string; title: string }[];
}) {
  const { t } = useI18n();
  const { data, setData } = useAsyncData(() => surveyApi.listComments(surveyId), [surveyId]);
  const [texto, setTexto] = useState("");
  const [pregunta, setPregunta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [verResueltos, setVerResueltos] = useState(false);
  const titulos = Object.fromEntries(questions.map((q) => [q.name, q.title]));
  const lista = (data ?? []).filter((c) => verResueltos || !c.resolved);
  const resueltos = (data ?? []).filter((c) => c.resolved).length;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!texto.trim()) return;
    setEnviando(true);
    try {
      const c = await surveyApi.addComment(surveyId, texto.trim(), pregunta || undefined);
      setData((cur) => [...(cur ?? []), c]);
      setTexto("");
    } catch (err) {
      toast.error((err as Error)?.message || t("collab.error"));
    } finally {
      setEnviando(false);
    }
  }

  async function resolver(c: SurveyComment) {
    const r = await surveyApi.resolveComment(surveyId, c.id, !c.resolved).catch(() => null);
    if (r) setData((cur) => (cur ?? []).map((x) => (x.id === c.id ? r : x)));
  }

  async function borrar(c: SurveyComment) {
    try {
      await surveyApi.deleteComment(surveyId, c.id);
      setData((cur) => (cur ?? []).filter((x) => x.id !== c.id));
    } catch (err) {
      toast.error((err as Error)?.message || t("collab.error"));
    }
  }

  return (
    <div className="space-y-3">
      {lista.length === 0 ? (
        <p className="text-sm text-neutral-400">{t("collab.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {lista.map((c) => (
            <li key={c.id} className={`rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800 ${c.resolved ? "opacity-60" : ""}`}>
              <div className="mb-1 flex items-center gap-2 text-xs text-neutral-400">
                <span className="font-medium text-neutral-600 dark:text-neutral-300">{c.author}</span>
                <span>{new Date(c.created_at).toLocaleString()}</span>
                {c.question && (
                  <span className="rounded bg-neutral-100 px-1.5 dark:bg-neutral-800">{titulos[c.question] || c.question}</span>
                )}
                <span className="ml-auto flex gap-1">
                  <button type="button" onClick={() => resolver(c)} title={c.resolved ? t("collab.reopen") : t("collab.resolve")}
                    aria-label={c.resolved ? t("collab.reopen") : t("collab.resolve")} className="hover:text-emerald-600">
                    {c.resolved ? <RotateCcw className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" onClick={() => borrar(c)} title={t("collab.delete")} aria-label={t("collab.delete")} className="hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
              <p className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {resueltos > 0 && (
        <button type="button" onClick={() => setVerResueltos((v) => !v)} className="text-xs text-neutral-500 hover:underline">
          {verResueltos ? t("collab.hideResolved") : t("collab.showResolved", { n: resueltos })}
        </button>
      )}
      <form onSubmit={enviar} className="space-y-2">
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={2}
          placeholder={t("collab.placeholder")}
          aria-label={t("collab.placeholder")}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <div className="flex gap-2">
          {questions.length > 0 && (
            <select value={pregunta} onChange={(e) => setPregunta(e.target.value)} aria-label={t("collab.about")}
              className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
              <option value="">{t("collab.general")}</option>
              {questions.map((q) => <option key={q.name} value={q.name}>{q.title}</option>)}
            </select>
          )}
          <button type="submit" disabled={enviando || !texto.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {enviando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
            {t("collab.send")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Pedido de publicación: lo ve quien pidió y, con botones, un admin. */
export function ApprovalBanner({
  survey,
  isAdmin,
  onChange,
}: {
  survey: SurveyDetail;
  isAdmin: boolean;
  onChange: (s: SurveyDetail) => void;
}) {
  const { t } = useI18n();
  const [nota, setNota] = useState("");
  const [busy, setBusy] = useState(false);
  const a = survey.approval;
  if (!a || survey.status === "published") return null;

  async function decidir(ok: boolean) {
    setBusy(true);
    try {
      onChange(ok ? await surveyApi.approve(survey.id, nota) : await surveyApi.reject(survey.id, nota));
      setNota("");
    } catch (err) {
      toast.error((err as Error)?.message || t("collab.error"));
    } finally {
      setBusy(false);
    }
  }

  const pendiente = a.state === "pending";
  return (
    <div className={`mt-4 rounded-lg border p-3 text-sm ${pendiente ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30" : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"}`}>
      <p className="font-medium text-neutral-800 dark:text-neutral-100">
        {pendiente ? t("collab.approval.pending", { by: a.by }) : t("collab.approval.rejected", { by: a.decided_by ?? "" })}
      </p>
      {a.note && <p className="mt-1 text-neutral-600 dark:text-neutral-300">«{a.note}»</p>}
      {pendiente && isAdmin && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder={t("collab.approval.note")}
            aria-label={t("collab.approval.note")}
            className="min-w-0 flex-1 rounded-md border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800" />
          <button disabled={busy} onClick={() => decidir(true)} className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
            {t("collab.approval.approve")}
          </button>
          <button disabled={busy} onClick={() => decidir(false)} className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50">
            {t("collab.approval.reject")}
          </button>
        </div>
      )}
    </div>
  );
}
