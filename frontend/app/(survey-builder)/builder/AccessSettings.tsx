"use client";

import React, { useState } from "react";
import { Globe, KeyRound, Users, Loader2, Eye, EyeOff, Settings2, Bell } from "lucide-react";
import { toast } from "sonner";
import {
  surveyApi,
  type AccessMode,
  type ResultsMode,
} from "../surveyApi";
import { readableForeground } from "./model";
import { InviteesManager } from "./InviteesManager";

interface Props {
  surveyId: string;
  accent: string;
  accessMode: AccessMode;
  accessPin: string | null;
  resultsMode: ResultsMode;
  resultsReleased: boolean;
  notifyEmails: string;
  onChange: (patch: {
    accessMode?: AccessMode;
    accessPin?: string | null;
    resultsMode?: ResultsMode;
    resultsReleased?: boolean;
    notifyEmails?: string;
  }) => void;
}

const ACCESS_OPTIONS: {
  value: AccessMode;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}[] = [
  {
    value: "public",
    label: "Pública",
    hint: "Cualquiera con el link puede responder.",
    icon: Globe,
  },
  {
    value: "pin",
    label: "Con clave (PIN)",
    hint: "Una clave compartida para todos.",
    icon: KeyRound,
  },
  {
    value: "list",
    label: "Lista de invitados",
    hint: "Solo emails admitidos, cada uno con su código.",
    icon: Users,
  },
];

const RESULTS_OPTIONS: { value: ResultsMode; label: string; hint: string }[] = [
  {
    value: "immediate",
    label: "Inmediata",
    hint: "Quien responde ve los resultados al terminar.",
  },
  {
    value: "on_release",
    label: "Al liberar",
    hint: "Los resultados se muestran recién cuando los publicás.",
  },
  {
    value: "never",
    label: "Nunca",
    hint: "Los resultados quedan solo para vos.",
  },
];

export function AccessSettings({
  surveyId,
  accent,
  accessMode,
  accessPin,
  resultsMode,
  resultsReleased,
  notifyEmails,
  onChange,
}: Props) {
  const [pin, setPin] = useState(accessPin ?? "");
  const [emails, setEmails] = useState(notifyEmails ?? "");
  const [savingMode, setSavingMode] = useState(false);
  const [savingResults, setSavingResults] = useState(false);
  const [savingPin, setSavingPin] = useState(false);
  const [savingEmails, setSavingEmails] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [inviteesOpen, setInviteesOpen] = useState(false);
  const accentFg = readableForeground(accent);

  async function changeMode(mode: AccessMode) {
    if (mode === accessMode) return;
    onChange({ accessMode: mode });
    setSavingMode(true);
    try {
      await surveyApi.update(surveyId, { access_mode: mode });
    } catch (e: any) {
      toast.error(e?.message || "No se pudo cambiar el modo de acceso.");
      onChange({ accessMode }); // revertir en pantalla
    } finally {
      setSavingMode(false);
    }
  }

  async function savePin() {
    const value = pin.trim();
    if (value === (accessPin ?? "")) return;
    setSavingPin(true);
    try {
      await surveyApi.update(surveyId, { access_pin: value || null });
      onChange({ accessPin: value || null });
      toast.success("Clave actualizada.");
    } catch (e: any) {
      toast.error(e?.message || "No se pudo guardar la clave.");
    } finally {
      setSavingPin(false);
    }
  }

  async function saveEmails() {
    const value = emails.trim();
    if (value === (notifyEmails ?? "").trim()) return;
    setSavingEmails(true);
    try {
      await surveyApi.update(surveyId, { notify_emails: value });
      onChange({ notifyEmails: value });
      toast.success(
        value ? "Avisos por email actualizados." : "Avisos por email desactivados."
      );
    } catch (e: any) {
      toast.error(e?.message || "No se pudo guardar los avisos.");
    } finally {
      setSavingEmails(false);
    }
  }

  async function changeResultsMode(mode: ResultsMode) {
    if (mode === resultsMode) return;
    onChange({ resultsMode: mode });
    setSavingResults(true);
    try {
      await surveyApi.update(surveyId, { results_mode: mode });
    } catch (e: any) {
      toast.error(e?.message || "No se pudo cambiar la visibilidad de resultados.");
      onChange({ resultsMode }); // revertir en pantalla
    } finally {
      setSavingResults(false);
    }
  }

  async function toggleRelease() {
    const next = !resultsReleased;
    setReleasing(true);
    try {
      const updated = await surveyApi.releaseResults(surveyId, next);
      onChange({ resultsReleased: updated.results_released });
      toast.success(next ? "Resultados publicados." : "Resultados ocultados.");
    } catch (e: any) {
      toast.error(e?.message || "No se pudo cambiar la publicación de resultados.");
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="mt-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
      <div className="mb-4 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        Acceso
        {savingMode && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>

      {/* Modo de acceso */}
      <div className="space-y-2">
        {ACCESS_OPTIONS.map((opt) => {
          const active = accessMode === opt.value;
          const Icon = opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => changeMode(opt.value)}
              className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                active
                  ? "border-[#8faf0e] bg-[#8faf0e0a]"
                  : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700"
              }`}
            >
              <Icon
                className="mt-0.5 h-4 w-4 shrink-0"
                style={{ color: active ? accent : "#a3a3a3" }}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {opt.label}
                </span>
                <span className="block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                  {opt.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Clave (PIN) */}
      {accessMode === "pin" && (
        <label className="mt-3 block">
          <span className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Clave de acceso
          </span>
          <div className="flex items-center gap-2">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onBlur={savePin}
              placeholder="Ej. otoño2026"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            {savingPin && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400 dark:text-neutral-500" />
            )}
          </div>
          <span className="mt-1 block text-[11px] text-neutral-400 dark:text-neutral-500">
            Compartila con quienes puedan responder.
          </span>
        </label>
      )}

      {/* Gestor de invitados */}
      {accessMode === "list" && (
        <button
          type="button"
          onClick={() => setInviteesOpen(true)}
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold"
          style={{ backgroundColor: accent, color: accentFg }}
        >
          <Settings2 className="h-4 w-4" /> Gestionar invitados
        </button>
      )}

      {/* Visibilidad de resultados */}
      <div className="mt-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
        <div className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          Resultados
          {savingResults && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Cuándo se ven los resultados
          </span>
          <select
            value={resultsMode}
            onChange={(e) => changeResultsMode(e.target.value as ResultsMode)}
            className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          >
            {RESULTS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
            {RESULTS_OPTIONS.find((o) => o.value === resultsMode)?.hint}
          </span>
        </label>

        {resultsMode === "on_release" && (
          <button
            type="button"
            onClick={toggleRelease}
            disabled={releasing}
            className={`mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-60 ${
              resultsReleased
                ? "border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                : "border-transparent text-white"
            }`}
            style={
              resultsReleased ? undefined : { backgroundColor: accent, color: accentFg }
            }
          >
            {releasing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : resultsReleased ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            {resultsReleased ? "Ocultar resultados" : "Publicar resultados"}
          </button>
        )}
        {resultsMode === "on_release" && (
          <span className="mt-1.5 block text-[11px] text-neutral-400 dark:text-neutral-500">
            {resultsReleased
              ? "Los resultados están publicados y visibles."
              : "Los resultados aún no son visibles para quienes respondieron."}
          </span>
        )}
      </div>

      {/* Notificaciones por email */}
      <div className="mt-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
        <div className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          <Bell className="h-3 w-3" /> Notificaciones
          {savingEmails && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Avisarme por email cuando alguien responde
          </span>
          <input
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            onBlur={saveEmails}
            placeholder="vos@ejemplo.com, equipo@ejemplo.com"
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <span className="mt-1 block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
            Emails separados por coma. Necesita SMTP configurado; si no, queda
            registrado igual.
          </span>
        </label>
      </div>

      <InviteesManager
        open={inviteesOpen}
        surveyId={surveyId}
        accent={accent}
        onClose={() => setInviteesOpen(false)}
      />
    </div>
  );
}
