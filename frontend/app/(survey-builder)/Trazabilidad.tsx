"use client";

/**
 * Trazabilidad en el panel: el registro de actividad de la encuesta y la línea
 * de tiempo de cada respuesta (versión contestada, huella de integridad y cada
 * cambio de nota con quién, cuándo y de cuánto a cuánto).
 */

import React, { useEffect, useState } from "react";
import { useDialogA11y } from "@/lib/useDialogA11y";
import { History, Loader2, RotateCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import {
  surveyApi,
  type AuditEvent,
  type JobInfo,
  type ResponseDeletion,
  type ResponseHistory,
} from "./surveyApi";

const CAMPOS: Record<string, string> = {
  json_schema: "preguntas",
  evaluation: "corrección",
  theme: "diseño",
  status: "estado",
  title: "título",
  access_mode: "acceso",
  access_pin: "clave",
  results_mode: "publicación de resultados",
  opens_at: "apertura",
  closes_at: "cierre",
  max_responses: "cupo",
  folder_id: "carpeta",
};

const FUENTES: Record<string, string> = {
  submit: "Corrección al enviar",
  regrade: "Recorrección",
  manual: "Corrección manual",
};

function describir(e: Pick<AuditEvent, "action" | "detail">): string {
  const d = e.detail || {};
  switch (e.action) {
    case "survey.created":
      return "Creó la encuesta";
    case "survey.duplicated":
      return "Creó la encuesta como copia de otra";
    case "survey.updated": {
      const campos = (d.fields as string[] | undefined)?.map((f) => CAMPOS[f] || f) ?? [];
      return campos.length ? `Editó: ${campos.join(", ")}` : "Editó la encuesta";
    }
    case "survey.published":
      return "Publicó la encuesta";
    case "survey.closed":
      return "Cerró la encuesta";
    case "survey.trashed":
      return "Mandó la encuesta a la papelera";
    case "survey.restored":
      return "Restauró la encuesta de la papelera";
    case "survey.purged":
      return `Borró la encuesta definitivamente (${d.responses_deleted ?? 0} respuestas)`;
    case "response.deleted":
      return `Borró la respuesta de ${d.respondent || "una persona anónima"}`;
    case "response.exclude":
      return "Excluyó una respuesta de los resultados";
    case "response.include":
      return "Volvió a incluir una respuesta";
    case "response.test":
      return "Marcó una respuesta como prueba";
    case "response.untest":
      return "Desmarcó una respuesta de prueba";
    case "responses.exported":
      return `Exportó ${d.rows ?? 0} ${d.rows === 1 ? "respuesta" : "respuestas"} (${String(
        d.format || "csv"
      ).toUpperCase()})`;
    case "delivery.retried":
      return "Reintentó una entrega a mano";
    case "grades.regrade_all":
      return `Recorrigió ${d.graded ?? 0} de ${d.total ?? 0} respuestas${
        d.discard_manual ? ", descartando lo corregido a mano" : ""
      }`;
    default:
      return e.action;
  }
}

/** Los borrados anteriores al registro de actividad viven sólo en el registro
 *  viejo: se suman para que no desaparezcan del panel. */
function borradosViejos(audit: AuditEvent[], deletions: ResponseDeletion[]): AuditEvent[] {
  const ya = new Set(
    audit.filter((e) => e.action === "response.deleted").map((e) => e.response_id)
  );
  return deletions
    .filter((d) => !ya.has(d.response_id))
    .map((d) => ({
      id: `del-${d.id}`,
      action: "response.deleted",
      actor_email: d.deleted_by_email,
      response_id: d.response_id,
      detail: { respondent: d.respondent },
      created_at: d.deleted_at,
    }));
}

function Dialogo({
  accent,
  titulo,
  subtitulo,
  onClose,
  children,
}: {
  accent: string;
  titulo: string;
  subtitulo: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useDialogA11y(onClose);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `${accent}1a`, color: accent }}
          >
            <History className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">{titulo}</h2>
            <p className="text-xs text-neutral-400">{subtitulo}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** Registro de actividad de la encuesta (solo admins). */
export function ActivityLog({
  surveyId,
  accent,
  onClose,
}: {
  surveyId: string;
  accent: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    Promise.all([surveyApi.getAudit(surveyId), surveyApi.getDeletions(surveyId).catch(() => [])])
      .then(([audit, dels]) => {
        if (cancel) return;
        const todo = [...audit, ...borradosViejos(audit, dels)];
        todo.sort((a, b) => b.created_at.localeCompare(a.created_at));
        setRows(todo);
      })
      .catch((e) => !cancel && setError(e?.message || "No se pudo cargar el registro."));
    return () => {
      cancel = true;
    };
  }, [surveyId]);

  return (
    <Dialogo
      accent={accent}
      titulo="Registro de actividad"
      subtitulo="Quién hizo qué y cuándo: ediciones, exportaciones, exclusiones y borrados."
      onClose={onClose}
    >
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : rows === null ? (
        <p className="flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-400">
          Todavía no hay actividad registrada en esta encuesta.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map((e) => (
            <li key={e.id} className="py-2.5">
              <p className="text-sm text-neutral-800 dark:text-neutral-200">{describir(e)}</p>
              <p className="text-xs text-neutral-400">
                {e.actor_email || "Sistema"} · {new Date(e.created_at).toLocaleString()}
                {e.action === "responses.exported" && e.detail?.sha256 ? (
                  <span title={`SHA-256 del archivo: ${e.detail.sha256}`}>
                    {" "}
                    · huella {String(e.detail.sha256).slice(0, 10)}…
                  </span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Dialogo>
  );
}

function puntos(v: number | null | undefined): string {
  return v == null ? "—" : String(Math.round(Number(v) * 1000) / 1000);
}

/** Sello de integridad de una respuesta, para la ficha. */
export function IntegrityBadge({ ok }: { ok: boolean | null | undefined }) {
  if (ok == null) return null;
  return ok ? (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      title="Las respuestas coinciden con la huella registrada al enviarse."
    >
      <ShieldCheck className="h-3 w-3" /> Íntegra
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300"
      title="Las respuestas no coinciden con la huella registrada: se modificaron después de enviarse."
    >
      <ShieldAlert className="h-3 w-3" /> Modificada
    </span>
  );
}

/** Línea de tiempo de la nota de una respuesta, para la ficha de la persona. */
export function ResponseHistoryPanel({ surveyId, responseId }: { surveyId: string; responseId: string }) {
  const [h, setH] = useState<ResponseHistory | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    // Sin resetear acá: la ficha monta este panel con `key` por respuesta, así
    // que cambiar de persona arranca con el estado vacío.
    let cancel = false;
    surveyApi
      .getResponseHistory(surveyId, responseId)
      .then((d) => !cancel && setH(d))
      .catch(() => !cancel && setError(true));
    return () => {
      cancel = true;
    };
  }, [surveyId, responseId]);

  if (error) return null;
  if (!h) {
    return (
      <p className="flex items-center gap-2 text-xs text-neutral-400">
        <Loader2 className="h-3 w-3 animate-spin" /> Cargando historial…
      </p>
    );
  }
  const hayAlgo =
    h.grade_revisions.length > 0 ||
    h.events.length > 0 ||
    h.answered_version != null ||
    (h.deliveries?.length ?? 0) > 0;
  if (!hayAlgo) return null;

  type Item = { at: string; titulo: string; detalle: string };
  const items: Item[] = [
    ...h.grade_revisions.map((g) => ({
      at: g.created_at,
      titulo: `${FUENTES[g.source] || g.source}: ${puntos(g.score_before)} → ${puntos(g.score_after)}${
        g.max_score ? ` / ${puntos(g.max_score)}` : ""
      }`,
      detalle: [
        g.actor_email || (g.source === "submit" ? "Automática" : "Sistema"),
        g.graded_with_version != null ? `versión ${g.graded_with_version}` : null,
        g.model ? `modelo ${g.model}` : null,
        g.note,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...h.events.map((e) => ({
      at: e.created_at,
      titulo: describir(e),
      detalle: e.actor_email || "Sistema",
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="rounded-xl border border-neutral-100 p-3 dark:border-neutral-800">
      <div className="mb-2 flex items-center gap-2">
        <History className="h-3.5 w-3.5 text-neutral-400" />
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Historial</p>
        {h.answered_version != null && (
          <span className="text-[11px] text-neutral-400">· contestó la versión {h.answered_version}</span>
        )}
        <span className="ml-auto">
          <IntegrityBadge ok={h.integrity} />
        </span>
      </div>
      <ol className="space-y-2 border-l border-neutral-200 pl-3 dark:border-neutral-700">
        {items.map((it, i) => (
          <li key={i}>
            <p className="text-sm text-neutral-800 dark:text-neutral-200">{it.titulo}</p>
            <p className="text-xs text-neutral-400">
              {new Date(it.at).toLocaleString()} · {it.detalle}
            </p>
          </li>
        ))}
      </ol>
      {(h.deliveries?.length ?? 0) > 0 && (
        <Entregas surveyId={surveyId} inicial={h.deliveries!} />
      )}
    </section>
  );
}

const TIPOS_ENTREGA: Record<string, string> = {
  "lms.grade": "Nota al LMS",
  "webhook.deliver": "Webhook",
  "grade.response": "Corrección automática",
};

function estadoEntrega(j: JobInfo): { texto: string; clase: string } {
  if (j.status === "done")
    return { texto: "Enviada", clase: "text-emerald-700 dark:text-emerald-300" };
  if (j.status === "failed")
    return { texto: `Falló tras ${j.attempts} intentos`, clase: "text-red-600 dark:text-red-400" };
  if (j.status === "running") return { texto: "Enviando…", clase: "text-neutral-500" };
  return j.attempts > 0
    ? {
        texto: `Reintentará ${j.run_after ? new Date(j.run_after).toLocaleTimeString() : "pronto"}`,
        clase: "text-amber-600 dark:text-amber-400",
      }
    : { texto: "En cola", clase: "text-neutral-500" };
}

/** Estado de lo que salió (o tiene que salir) por esta respuesta: la nota al
 *  LMS y los webhooks. Lo que falló se puede reintentar desde acá. */
function Entregas({ surveyId, inicial }: { surveyId: string; inicial: JobInfo[] }) {
  const [rows, setRows] = useState(inicial);
  const [busy, setBusy] = useState<string | null>(null);

  async function reintentar(j: JobInfo) {
    setBusy(j.id);
    try {
      const nuevo = await surveyApi.retryDelivery(surveyId, j.id);
      setRows((rs) => rs.map((x) => (x.id === j.id ? nuevo : x)));
    } catch {
      /* el estado no cambia; el botón queda para volver a probar */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 border-t border-neutral-100 pt-2 dark:border-neutral-800">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Entregas</p>
      <ul className="space-y-1.5">
        {rows.map((j) => {
          const e = estadoEntrega(j);
          const puede = j.status === "failed" || (j.status === "pending" && j.attempts > 0);
          return (
            <li key={j.id} className="flex items-start gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-neutral-800 dark:text-neutral-200">
                  {TIPOS_ENTREGA[j.kind] || j.kind}
                  {j.payload?.url ? (
                    <span className="text-xs text-neutral-400"> · {j.payload.url}</span>
                  ) : null}{" "}
                  <span className={`text-xs ${e.clase}`}>· {e.texto}</span>
                </p>
                {j.last_error && j.status !== "done" && (
                  <p className="truncate text-xs text-neutral-400" title={j.last_error}>
                    {j.last_error}
                  </p>
                )}
              </div>
              {puede && (
                <button
                  onClick={() => reintentar(j)}
                  disabled={busy === j.id}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  <RotateCw className={`h-3 w-3 ${busy === j.id ? "animate-spin" : ""}`} /> Reintentar
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
