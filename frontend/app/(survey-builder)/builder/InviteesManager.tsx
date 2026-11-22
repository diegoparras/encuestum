"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  X,
  Upload,
  Send,
  Download,
  Trash2,
  Users,
  Mail,
  CheckCircle2,
  BellRing,
} from "lucide-react";
import { toast } from "sonner";
import { surveyApi, type Invitee, type InviteTracking, type ReminderConfig } from "../surveyApi";
import { readableForeground } from "./model";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  surveyId: string;
  accent: string;
  onClose: () => void;
}

// Regex simple para validar emails "razonables" (no busca ser exhaustivo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Parsea un pegote de texto con emails (uno por línea, o separados por coma / punto y coma).
// Devuelve pares {email, name?} deduplicados y con emails válidos.
function parseEmails(raw: string): { email: string; name?: string }[] {
  const seen = new Set<string>();
  const out: { email: string; name?: string }[] = [];
  const tokens = raw
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const email = token.toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email });
  }
  return out;
}

// Parseo simple de CSV: primera columna = email, segunda = nombre.
// Ignora una posible fila de encabezado ("email,nombre").
function parseCsv(text: string): { email: string; name?: string }[] {
  const seen = new Set<string>();
  const out: { email: string; name?: string }[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cols = line.split(/[;,]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const email = (cols[0] || "").toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    const name = cols[1] && cols[1].trim() ? cols[1].trim() : undefined;
    out.push({ email, name });
  }
  return out;
}

export function InviteesManager({ open, surveyId, accent, onClose }: Props) {
  const { t } = useI18n();
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState("");
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [tracking, setTracking] = useState<InviteTracking | null>(null);
  const [reminding, setReminding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const accentFg = readableForeground(accent);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, tr] = await Promise.all([
        surveyApi.listInvitees(surveyId),
        surveyApi.inviteTracking(surveyId).catch(() => null),
      ]);
      setInvitees(list);
      setTracking(tr);
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.inv.loadError"));
    } finally {
      setLoading(false);
    }
  }, [surveyId, t]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return null;

  async function add(pairs: { email: string; name?: string }[]) {
    if (pairs.length === 0) {
      toast.error(t("builder.inv.noValidEmails"));
      return;
    }
    setAdding(true);
    try {
      const created = await surveyApi.addInvitees(surveyId, pairs);
      setRaw("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
      const dup = pairs.length - created.length;
      toast.success(
        created.length > 0
          ? dup > 0
            ? t("builder.inv.addedWithDup", { created: created.length, dup })
            : t("builder.inv.added", { created: created.length })
          : t("builder.inv.alreadyThere")
      );
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.inv.addError"));
    } finally {
      setAdding(false);
    }
  }

  function onAddFromTextarea() {
    add(parseEmails(raw));
  }

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      await add(parseCsv(text));
    } catch {
      toast.error(t("builder.inv.readCsvError"));
    }
  }

  async function remove(iid: string) {
    setDeletingId(iid);
    try {
      await surveyApi.deleteInvitee(surveyId, iid);
      setInvitees((cur) => cur.filter((x) => x.id !== iid));
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.inv.deleteError"));
    } finally {
      setDeletingId(null);
    }
  }

  async function sendLinks() {
    setSending(true);
    try {
      const { sent, total } = await surveyApi.sendInviteeLinks(surveyId);
      await load();
      toast.success(t("builder.inv.sentLinks", { sent, total }));
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.inv.sendError"));
    } finally {
      setSending(false);
    }
  }

  async function remindNow() {
    setReminding(true);
    try {
      const { sent } = await surveyApi.remindInvitees(surveyId);
      await load();
      toast.success(t("builder.inv.reminded", { sent }));
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.inv.sendError"));
    } finally {
      setReminding(false);
    }
  }

  async function saveReminders(cfg: ReminderConfig) {
    setTracking((cur) => (cur ? { ...cur, reminders_config: cfg } : cur));
    try {
      await surveyApi.update(surveyId, { reminders: cfg });
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.inv.remindersError"));
      load();
    }
  }

  // Genera el CSV en el cliente (email, nombre, código) y lo descarga vía Blob.
  function downloadCsv() {
    if (invitees.length === 0) {
      toast.error(t("builder.inv.noExport"));
      return;
    }
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [
      ["email", "nombre", "codigo", "enviada", "abierta", "entro", "respondio", "recordatorios"],
      ...invitees.map((i) => [
        i.email, i.name || "", i.code, i.sent_at || "", i.opened_at || "", i.used_at || "",
        i.responded_at || "", String(i.reminders_sent ?? 0),
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => escape(c)).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "invitados.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const usedCount = invitees.filter((i) => i.used_at).length;
  const sentCount = invitees.filter((i) => i.sent_at).length;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5" style={{ color: accent }} />
            <h2 className="text-sm font-semibold dark:text-neutral-100">{t("builder.inv.title")}</h2>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {t("builder.inv.summary", { total: invitees.length, sent: sentCount, used: usedCount })}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
            aria-label={t("builder.inv.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-5">
          {/* Alta de invitados */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
            <div className="mb-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
              {t("builder.inv.addInvitees")}
            </div>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={3}
              placeholder={t("builder.inv.pastePlaceholder")}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={onAddFromTextarea}
                disabled={adding || !raw.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ backgroundColor: accent, color: accentFg }}
              >
                {adding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {t("builder.inv.add")}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={adding}
                className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <Upload className="h-4 w-4" /> {t("builder.inv.uploadCsv")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={onFilePick}
                className="hidden"
              />
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {t("builder.inv.csvHint")}
              </span>
            </div>
          </div>

          {/* Acciones sobre la lista */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={sendLinks}
              disabled={sending || invitees.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {t("builder.inv.sendLinks")}
            </button>
            <button
              onClick={downloadCsv}
              disabled={invitees.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Download className="h-4 w-4" /> {t("builder.inv.downloadCsv")}
            </button>
            <button
              onClick={remindNow}
              disabled={reminding || !tracking || tracking.sent - tracking.responded <= 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {reminding ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
              {t("builder.inv.remindNow")}
            </button>
          </div>

          {tracking && tracking.total > 0 && (
            <TrackingFunnel tracking={tracking} accent={accent} onReminders={saveReminders} />
          )}

          {/* Tabla de invitados */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800">
            {loading ? (
              <div className="grid place-items-center py-10 text-sm text-neutral-400 dark:text-neutral-500">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("builder.inv.loading")}
                </span>
              </div>
            ) : invitees.length === 0 ? (
              <div className="grid place-items-center py-10 text-sm text-neutral-400 dark:text-neutral-500">
                {t("builder.inv.empty")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100 dark:border-neutral-800 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      <th className="px-3 py-2 font-semibold">{t("builder.inv.colEmail")}</th>
                      <th className="px-3 py-2 font-semibold">{t("builder.inv.colName")}</th>
                      <th className="px-3 py-2 font-semibold">{t("builder.inv.colCode")}</th>
                      <th className="px-3 py-2 font-semibold">{t("builder.inv.colStatus")}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {invitees.map((i) => (
                      <tr key={i.id} className="border-b border-neutral-50 dark:border-neutral-800 last:border-0">
                        <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{i.email}</td>
                        <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{i.name || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          {i.code}
                        </td>
                        <td className="px-3 py-2">
                          <InviteeStatus i={i} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => remove(i.id)}
                            disabled={deletingId === i.id}
                            className="text-neutral-300 hover:text-red-600 disabled:opacity-50 dark:text-neutral-600 dark:hover:text-red-400"
                            aria-label={t("builder.inv.deleteInvitee")}
                            title={t("builder.inv.delete")}
                          >
                            {deletingId === i.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const BADGE = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium";

function fecha(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString() : "";
}

/** Estado de una invitación: el paso más avanzado al que llegó. */
function InviteeStatus({ i }: { i: Invitee }) {
  const { t } = useI18n();
  const extra = i.reminders_sent ? (
    <span className="ml-1 text-[10px] text-neutral-400 dark:text-neutral-500" title={fecha(i.last_reminded_at)}>
      {t("builder.inv.remindersCount", { n: i.reminders_sent })}
    </span>
  ) : null;
  if (i.responded_at)
    return (
      <span title={fecha(i.responded_at)} className={`${BADGE} bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300`}>
        <CheckCircle2 className="h-3 w-3" /> {t("builder.inv.statusResponded")}
      </span>
    );
  const [cls, key, when] = i.used_at
    ? ["bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300", "builder.inv.statusUsed", i.used_at]
    : i.opened_at
      ? ["bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300", "builder.inv.statusOpened", i.opened_at]
      : i.sent_at
        ? ["bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300", "builder.inv.statusSent", i.sent_at]
        : ["bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400", "builder.inv.statusPending", null];
  return (
    <span className="whitespace-nowrap">
      <span title={fecha(when)} className={`${BADGE} ${cls}`}>{t(key)}</span>
      {extra}
    </span>
  );
}

/** Enviadas → abiertas → entraron → respondieron, y los recordatorios automáticos. */
function TrackingFunnel({
  tracking,
  accent,
  onReminders,
}: {
  tracking: InviteTracking;
  accent: string;
  onReminders: (cfg: ReminderConfig) => void;
}) {
  const { t } = useI18n();
  const cfg = tracking.reminders_config ?? { enabled: false, every_days: 3, max: 2 };
  const pasos = [
    { key: "sent", n: tracking.sent },
    { key: "opened", n: tracking.opened },
    { key: "clicked", n: tracking.clicked },
    { key: "responded", n: tracking.responded },
  ];
  const base = Math.max(1, tracking.sent);
  return (
    <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">{t("builder.inv.funnel")}</div>
      <div className="grid grid-cols-4 gap-2">
        {pasos.map((p) => (
          <div key={p.key}>
            <div className="text-lg font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">{p.n}</div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{t(`builder.inv.funnel.${p.key}`)}</div>
            <div className="mt-1 h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800">
              <div className="h-1.5 rounded-full" style={{ width: `${Math.round((100 * p.n) / base)}%`, backgroundColor: accent }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">{t("builder.inv.openedHint")}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => onReminders({ ...cfg, enabled: e.target.checked })}
          />
          {t("builder.inv.autoReminders")}
        </label>
        {cfg.enabled && (
          <>
            <label className="inline-flex items-center gap-1">
              {t("builder.inv.every")}
              <select
                value={cfg.every_days}
                onChange={(e) => onReminders({ ...cfg, every_days: Number(e.target.value) })}
                className="rounded border border-neutral-200 bg-white px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-800"
              >
                {[1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {t("builder.inv.days")}
            </label>
            <label className="inline-flex items-center gap-1">
              {t("builder.inv.upTo")}
              <select
                value={cfg.max}
                onChange={(e) => onReminders({ ...cfg, max: Number(e.target.value) })}
                className="rounded border border-neutral-200 bg-white px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-800"
              >
                {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {t("builder.inv.times")}
            </label>
          </>
        )}
      </div>
    </div>
  );
}
