"use client";

/**
 * Privacidad de la encuesta: anonimato garantizado (lo hace cumplir el
 * servidor) y retención de respuestas (anonimizar o borrar a los N días).
 */

import React, { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { surveyApi, type RetentionAction } from "../surveyApi";
import { useI18n } from "@/lib/i18n";

const DIAS = [30, 90, 180, 365, 730];

export function PrivacySettings({ surveyId }: { surveyId: string }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [days, setDays] = useState<number | null>(null);
  const [action, setAction] = useState<RetentionAction>("anonymize");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    surveyApi
      .get(surveyId, ctrl.signal)
      .then((s) => {
        setAnonymous(!!s.anonymous);
        setDays(s.retention_days ?? null);
        setAction(s.retention_action ?? "anonymize");
        setLoaded(true);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [surveyId]);

  async function save(patch: Parameters<typeof surveyApi.update>[1], undo: () => void) {
    setSaving(true);
    try {
      await surveyApi.update(surveyId, patch);
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.privacy.error"));
      undo();
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
      <div className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        <ShieldCheck className="h-3 w-3" /> {t("builder.privacy.title")}
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
        <button
          type="button"
          role="switch"
          aria-checked={anonymous}
          aria-label={t("builder.privacy.anonymous")}
          onClick={() => {
            const next = !anonymous;
            setAnonymous(next);
            save({ anonymous: next }, () => setAnonymous(!next));
          }}
          className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
            anonymous ? "bg-[#8faf0e]" : "bg-neutral-300 dark:bg-neutral-700"
          }`}
        >
          <span
            className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform ${
              anonymous ? "translate-x-[18px]" : ""
            }`}
          />
        </button>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("builder.privacy.anonymous")}
          </span>
          <span className="block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
            {t("builder.privacy.anonymousHint")}
          </span>
        </span>
      </div>

      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          {t("builder.privacy.retention")}
        </span>
        <div className="flex gap-2">
          <select
            value={days ?? 0}
            onChange={(e) => {
              const prev = days;
              const next = Number(e.target.value) || null;
              setDays(next);
              save({ retention_days: next ?? 0, retention_action: action }, () => setDays(prev));
            }}
            className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <option value={0}>{t("builder.privacy.keep")}</option>
            {[...new Set([...DIAS, ...(days ? [days] : [])])].sort((a, b) => a - b).map((d) => (
              <option key={d} value={d}>{t("builder.privacy.days", { n: d })}</option>
            ))}
          </select>
          {days ? (
            <select
              value={action}
              onChange={(e) => {
                const prev = action;
                const next = e.target.value as RetentionAction;
                setAction(next);
                save({ retention_days: days, retention_action: next }, () => setAction(prev));
              }}
              className="rounded-md border border-neutral-200 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            >
              <option value="anonymize">{t("builder.privacy.anonymize")}</option>
              <option value="delete">{t("builder.privacy.delete")}</option>
            </select>
          ) : null}
        </div>
        <span className="mt-1 block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
          {days
            ? t(action === "delete" ? "builder.privacy.deleteHint" : "builder.privacy.anonymizeHint", { n: days })
            : t("builder.privacy.keepHint")}
        </span>
      </label>
    </div>
  );
}
