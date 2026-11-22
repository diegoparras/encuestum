"use client";

/**
 * Piezas del panel para exámenes: las señales de integridad de una respuesta
 * y la bandeja de reclamos de nota.
 */

import React, { useEffect, useState } from "react";
import { AlertTriangle, Loader2, MessageSquareWarning } from "lucide-react";
import { toast } from "sonner";
import { surveyApi, type GradeAppeal } from "./surveyApi";

type Flag = { code: string; detail: string };

type Meta = { server?: { flags?: unknown; exam_seconds?: unknown } } | null | undefined;

export function flagsOf(meta: Meta): Flag[] {
  const f = meta?.server?.flags;
  return Array.isArray(f) ? (f as Flag[]) : [];
}

/** Señales de integridad (indicios, no veredictos) de una respuesta. */
export function IntegrityFlags({ meta: raw, compact = false }: { meta: Meta | Record<string, unknown>; compact?: boolean }) {
  const meta = raw as Meta;
  const flags = flagsOf(meta);
  if (!flags.length) return null;
  if (compact)
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
        title={flags.map((f) => f.detail).join("\n")}
      >
        <AlertTriangle className="h-3 w-3" /> {flags.length} {flags.length === 1 ? "señal" : "señales"}
      </span>
    );
  const segundos = meta?.server?.exam_seconds;
  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-3 text-xs text-orange-900 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-200">
      <p className="mb-1 font-medium">Señales de integridad</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {flags.map((f, i) => (
          <li key={i}>{f.detail}</li>
        ))}
      </ul>
      {typeof segundos === "number" && (
        <p className="mt-1 opacity-70">Tiempo en el examen: {Math.round(segundos / 60)} min.</p>
      )}
      <p className="mt-1 opacity-70">Son indicios para mirar, no prueban nada por sí solos.</p>
    </div>
  );
}

/** Bandeja de reclamos: los abiertos arriba, con aceptar (puntaje nuevo) o rechazar. */
export function AppealsPanel({ surveyId, accent, onResolved }: { surveyId: string; accent: string; onResolved: () => void }) {
  const [rows, setRows] = useState<GradeAppeal[] | null>(null);
  const cargar = () => surveyApi.listAppeals(surveyId).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);
  if (!rows || rows.length === 0) return null;
  const abiertos = rows.filter((r) => r.status === "open").length;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
        <MessageSquareWarning className="h-4 w-4" style={{ color: accent }} />
        Reclamos de nota
        {abiertos > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40">
            {abiertos} {abiertos === 1 ? "abierto" : "abiertos"}
          </span>
        )}
      </h3>
      <ul className="space-y-3">
        {rows.map((a) => (
          <AppealRow key={a.id} a={a} surveyId={surveyId} accent={accent} onDone={() => { cargar(); onResolved(); }} />
        ))}
      </ul>
    </div>
  );
}

function AppealRow({ a, surveyId, accent, onDone }: { a: GradeAppeal; surveyId: string; accent: string; onDone: () => void }) {
  const [reply, setReply] = useState("");
  const [award, setAward] = useState<string>(a.awarded != null ? String(a.awarded) : "");
  const [busy, setBusy] = useState(false);
  const respuesta = Array.isArray(a.answer) ? a.answer.join(", ") : a.answer == null ? "—" : String(a.answer);

  async function resolver(decision: "accept" | "reject") {
    setBusy(true);
    try {
      await surveyApi.resolveAppeal(surveyId, a.id, {
        decision,
        reply: reply.trim() || (decision === "accept" ? "Aceptado." : "Se mantiene la corrección."),
        ...(decision === "accept" && award !== "" ? { award: Number(award) } : {}),
      });
      toast.success(decision === "accept" ? "Reclamo aceptado" : "Reclamo rechazado");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-neutral-100 p-3 text-sm dark:border-neutral-800">
      <p className="text-xs text-neutral-400">
        {a.respondent || "Alumno"} · {new Date(a.created_at).toLocaleString()} · «{a.question_title}»
      </p>
      <p className="mt-1 text-neutral-800 dark:text-neutral-100">“{a.message}”</p>
      <p className="mt-1 text-xs text-neutral-500">
        Respondió: <span className="font-medium">{respuesta}</span> · puntaje {a.awarded ?? "—"}/{a.points ?? "—"}
      </p>
      {a.status === "open" ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            placeholder="Respuesta para el alumno"
            className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-800"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="inline-flex items-center gap-1">
              Nuevo puntaje
              <input
                type="number"
                min={0}
                max={a.points ?? undefined}
                step={0.5}
                value={award}
                onChange={(e) => setAward(e.target.value)}
                className="w-16 rounded-md border border-neutral-200 px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-800"
              />
              / {a.points ?? "—"}
            </label>
            <button
              onClick={() => resolver("accept")}
              disabled={busy}
              className="rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Aceptar"}
            </button>
            <button
              onClick={() => resolver("reject")}
              disabled={busy}
              className="rounded-md border border-neutral-200 px-2.5 py-1 font-medium text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
            >
              Rechazar
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-neutral-500">
          {a.status === "accepted" ? "Aceptado" : "Rechazado"}
          {a.award_after != null ? ` (${a.award_before ?? "—"} → ${a.award_after})` : ""} por {a.resolved_by_email}: “{a.reply}”
        </p>
      )}
    </li>
  );
}
