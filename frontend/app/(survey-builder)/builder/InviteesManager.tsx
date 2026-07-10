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
} from "lucide-react";
import { toast } from "sonner";
import { surveyApi, type Invitee } from "../surveyApi";
import { readableForeground } from "./model";

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
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState("");
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const accentFg = readableForeground(accent);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await surveyApi.listInvitees(surveyId);
      setInvitees(list);
    } catch (e: any) {
      toast.error(e?.message || "No se pudieron cargar los invitados.");
    } finally {
      setLoading(false);
    }
  }, [surveyId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return null;

  async function add(pairs: { email: string; name?: string }[]) {
    if (pairs.length === 0) {
      toast.error("No se encontraron emails válidos.");
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
          ? `Se agregaron ${created.length} invitado(s)${dup > 0 ? ` (${dup} ya existían)` : ""}.`
          : "Esos invitados ya estaban en la lista."
      );
    } catch (e: any) {
      toast.error(e?.message || "No se pudieron agregar los invitados.");
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
      toast.error("No se pudo leer el archivo CSV.");
    }
  }

  async function remove(iid: string) {
    setDeletingId(iid);
    try {
      await surveyApi.deleteInvitee(surveyId, iid);
      setInvitees((cur) => cur.filter((x) => x.id !== iid));
    } catch (e: any) {
      toast.error(e?.message || "No se pudo eliminar el invitado.");
    } finally {
      setDeletingId(null);
    }
  }

  async function sendLinks() {
    setSending(true);
    try {
      const { sent, total } = await surveyApi.sendInviteeLinks(surveyId);
      await load();
      toast.success(`Se enviaron ${sent} de ${total} link(s) por email.`);
    } catch (e: any) {
      toast.error(e?.message || "No se pudieron enviar los links.");
    } finally {
      setSending(false);
    }
  }

  // Genera el CSV en el cliente (email, nombre, código) y lo descarga vía Blob.
  function downloadCsv() {
    if (invitees.length === 0) {
      toast.error("No hay invitados para exportar.");
      return;
    }
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [
      ["email", "nombre", "codigo"],
      ...invitees.map((i) => [i.email, i.name || "", i.code]),
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
            <h2 className="text-sm font-semibold dark:text-neutral-100">Invitados</h2>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {invitees.length} en total · {sentCount} enviados · {usedCount} usados
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-5">
          {/* Alta de invitados */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
            <div className="mb-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
              Agregar invitados
            </div>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={3}
              placeholder="Pegá los emails, uno por línea o separados por coma…"
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
                Agregar
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={adding}
                className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <Upload className="h-4 w-4" /> Subir CSV
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={onFilePick}
                className="hidden"
              />
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                CSV: 1ª columna email, 2ª nombre (opcional).
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
              Enviar links por email
            </button>
            <button
              onClick={downloadCsv}
              disabled={invitees.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Download className="h-4 w-4" /> Descargar CSV
            </button>
          </div>

          {/* Tabla de invitados */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800">
            {loading ? (
              <div className="grid place-items-center py-10 text-sm text-neutral-400 dark:text-neutral-500">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
                </span>
              </div>
            ) : invitees.length === 0 ? (
              <div className="grid place-items-center py-10 text-sm text-neutral-400 dark:text-neutral-500">
                Todavía no agregaste invitados.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100 dark:border-neutral-800 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Nombre</th>
                      <th className="px-3 py-2 font-semibold">Código</th>
                      <th className="px-3 py-2 font-semibold">Estado</th>
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
                          {i.used_at ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-950/40 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-300">
                              <CheckCircle2 className="h-3 w-3" /> Usado
                            </span>
                          ) : i.sent_at ? (
                            <span className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-950/40 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                              Enviado
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                              Pendiente
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => remove(i.id)}
                            disabled={deletingId === i.id}
                            className="text-neutral-300 hover:text-red-600 disabled:opacity-50 dark:text-neutral-600 dark:hover:text-red-400"
                            aria-label="Eliminar invitado"
                            title="Eliminar"
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
