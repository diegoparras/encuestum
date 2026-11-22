"use client";

/** Configuración de examen: integridad, sorteo por grupos, formas y criterios de la IA. */

import { AiCriteria, BuilderQuestion, EvaluationSettings, FeedbackTone, RevealMode, Strictness } from "./model";
import { useI18n } from "@/lib/i18n";

import { Sparkles } from "lucide-react";
import { Field, SelectRow, ToggleRow } from "./panelUi";

export function ExamSettings({
  evaluation,
  onChange,
  accent,
  questions,
}: {
  evaluation: EvaluationSettings;
  onChange: (e: EvaluationSettings) => void;
  accent: string;
  questions: BuilderQuestion[];
}) {
  const { t } = useI18n();
  if (!evaluation.enabled) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 p-3 text-xs text-neutral-400 dark:text-neutral-500">
        {t("builder.exam.disabledPre")} <span className="font-medium">{t("builder.exam.disabledBold")}</span> {t("builder.exam.disabledPost")}
      </div>
    );
  }
  const set = (patch: Partial<EvaluationSettings>) => onChange({ ...evaluation, ...patch });
  const setIntegrity = (patch: Partial<EvaluationSettings["integrity"]>) =>
    onChange({ ...evaluation, integrity: { ...evaluation.integrity, ...patch } });

  return (
    <div
      className="mt-6 rounded-xl border p-3"
      style={{ borderColor: `${accent}44`, backgroundColor: `${accent}0a` }}
    >
      <div className="text-xs font-semibold mb-3" style={{ color: accent }}>
        {t("builder.exam.evalMode")}
      </div>

      <Field label={t("builder.exam.whenResult")}>
        <select
          value={evaluation.feedbackTiming}
          onChange={(e) => set({ feedbackTiming: e.target.value as any })}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        >
          <option value="onComplete">{t("builder.exam.timing.onComplete")}</option>
          <option value="immediate">{t("builder.exam.timing.immediate")}</option>
          <option value="never">{t("builder.exam.timing.never")}</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("builder.exam.passingScore")}>
          <input
            type="number"
            min={0}
            max={100}
            value={evaluation.passingScore}
            onChange={(e) => set({ passingScore: Number(e.target.value) })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </Field>
      </div>

      <div className="mt-1 space-y-1.5">
        <ToggleRow
          label={t("builder.exam.showScore")}
          checked={evaluation.showScoreToRespondent}
          onChange={(v) => set({ showScoreToRespondent: v })}
        />
        {/* Valor por defecto: cada pregunta puede elegir otro momento. */}
        <SelectRow
          label={t("builder.exam.revealCorrect")}
          hint={t("builder.exam.revealCorrectHint")}
          value={evaluation.revealCorrect}
          onChange={(v) => set({ revealCorrect: v as RevealMode })}
          options={[
            { value: "never", label: t("builder.exam.revealNever") },
            { value: "always", label: t("builder.exam.revealAlways") },
            { value: "onClose", label: t("builder.exam.revealOnClose") },
          ]}
        />
        <SelectRow
          label={t("builder.exam.feedbackReview")}
          hint={t("builder.exam.feedbackReviewHint")}
          value={evaluation.feedbackReview}
          onChange={(v) => set({ feedbackReview: v as "off" | "on" })}
          options={[
            { value: "off", label: t("builder.exam.feedbackReviewOff") },
            { value: "on", label: t("builder.exam.feedbackReviewOn") },
          ]}
        />
        <ToggleRow
          label={t("builder.exam.doublePass")}
          hint={t("builder.exam.doublePassHint")}
          checked={evaluation.doublePass}
          onChange={(v) => set({ doublePass: v })}
        />
        <ToggleRow
          label={t("builder.exam.shuffleQuestions")}
          checked={evaluation.integrity.shuffleQuestions}
          onChange={(v) => setIntegrity({ shuffleQuestions: v })}
        />
        <ToggleRow
          label={t("builder.exam.shuffleChoices")}
          checked={evaluation.integrity.shuffleChoices}
          onChange={(v) => setIntegrity({ shuffleChoices: v })}
        />
        <Field label={t("builder.exam.timeLimit")}>
          <input
            type="number"
            min={0}
            step={5}
            value={evaluation.integrity.timeLimitSec ? Math.round(evaluation.integrity.timeLimitSec / 60) : ""}
            placeholder={t("builder.exam.noLimit")}
            onChange={(e) => {
              const min = Number(e.target.value);
              setIntegrity({ timeLimitSec: min > 0 ? Math.round(min * 60) : null });
            }}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
          />
          <p className="mt-1 text-[11px] text-neutral-400">{t("builder.exam.timeLimitHint")}</p>
        </Field>
        <ToggleRow
          label={t("builder.exam.signals")}
          hint={t("builder.exam.signalsHint")}
          checked={!!evaluation.integrity.signals}
          onChange={(v) => setIntegrity({ signals: v })}
        />
        <Field label={t("builder.exam.forms")}>
          <select
            value={evaluation.integrity.forms ?? 0}
            onChange={(e) => setIntegrity({ forms: Number(e.target.value) })}
            className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <option value={0}>{t("builder.exam.formsNone")}</option>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>{t("builder.exam.formsN", { n, letters: "ABCD".slice(0, n).split("").join(", ") })}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-neutral-400">{t("builder.exam.formsHint")}</p>
        </Field>
        <GroupsEditor
          questions={questions}
          groups={evaluation.integrity.groups ?? {}}
          onChange={(groups) => setIntegrity({ groups })}
        />
      </div>

      <AiGradingSection evaluation={evaluation} onChange={onChange} accent={accent} />
    </div>
  );
}

export const FOCUS_SUGGESTIONS = [
  "contenido",
  "claridad",
  "originalidad",
  "ortografía",
  "ejemplos",
  "estructura",
];

export function AiGradingSection({
  evaluation,
  onChange,
  accent,
}: {
  evaluation: EvaluationSettings;
  onChange: (e: EvaluationSettings) => void;
  accent: string;
}) {
  const { t } = useI18n();
  const ai = evaluation.aiCriteria;
  const setAi = (patch: Partial<AiCriteria>) =>
    onChange({ ...evaluation, aiCriteria: { ...evaluation.aiCriteria, ...patch } });

  function toggleFocus(value: string) {
    const has = ai.focus.includes(value);
    setAi({
      focus: has ? ai.focus.filter((f) => f !== value) : [...ai.focus, value],
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
      <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
        <Sparkles className="h-3.5 w-3.5" style={{ color: accent }} /> {t("builder.ai.title")}
      </div>

      <ToggleRow
        label={t("builder.ai.useCustom")}
        checked={ai.enabled}
        onChange={(v) => setAi({ enabled: v })}
      />

      {ai.enabled && (
        <div className="mt-2 space-y-3">
          <Field label={t("builder.ai.strictnessLabel")}>
            <select
              value={ai.strictness}
              onChange={(e) => setAi({ strictness: e.target.value as Strictness })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            >
              <option value="indulgente">{t("builder.ai.strictness.indulgente")}</option>
              <option value="equilibrado">{t("builder.ai.strictness.equilibrado")}</option>
              <option value="estricto">{t("builder.ai.strictness.estricto")}</option>
            </select>
          </Field>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              {t("builder.ai.prioritize")}
            </span>
            <div className="flex flex-wrap gap-2">
              {FOCUS_SUGGESTIONS.map((f) => {
                const active = ai.focus.includes(f);
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => toggleFocus(f)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      active
                        ? "text-white border-transparent"
                        : "border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    }`}
                    style={active ? { backgroundColor: accent } : undefined}
                  >
                    {t(`builder.focus.${f}`)}
                  </button>
                );
              })}
            </div>
          </div>

          <Field label={t("builder.ai.tone")}>
            <select
              value={ai.tone}
              onChange={(e) => setAi({ tone: e.target.value as FeedbackTone })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            >
              <option value="motivador">{t("builder.ai.tone.motivador")}</option>
              <option value="neutral">{t("builder.ai.tone.neutral")}</option>
              <option value="directo">{t("builder.ai.tone.directo")}</option>
            </select>
          </Field>

          <Field label={t("builder.ai.instructions")}>
            <textarea
              value={ai.instructions}
              onChange={(e) => setAi({ instructions: e.target.value })}
              rows={3}
              placeholder={t("builder.ai.instructionsPlaceholder")}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("builder.ai.footer")}
      </p>
    </div>
  );
}

/** Cuántas preguntas sortear de cada grupo (los grupos se ponen en cada
 *  pregunta: "Grupo de sorteo"). Vacío = se muestran todas las del grupo. */
export function GroupsEditor({
  questions,
  groups,
  onChange,
}: {
  questions: BuilderQuestion[];
  groups: Record<string, number>;
  onChange: (g: Record<string, number>) => void;
}) {
  const { t } = useI18n();
  const conteo: Record<string, number> = {};
  for (const q of questions) if (q.group?.trim()) conteo[q.group.trim()] = (conteo[q.group.trim()] ?? 0) + 1;
  const nombres = Object.keys(conteo).sort();
  if (!nombres.length) return <p className="text-[11px] text-neutral-400">{t("builder.exam.groupsEmpty")}</p>;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{t("builder.exam.groups")}</p>
      <div className="space-y-1.5">
        {nombres.map((g) => (
          <label key={g} className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
            <span className="min-w-0 flex-1 truncate font-medium">{g}</span>
            {t("builder.exam.show")}
            <input
              type="number"
              min={1}
              max={conteo[g]}
              value={groups[g] ?? ""}
              placeholder={String(conteo[g])}
              onChange={(e) => {
                const n = Number(e.target.value);
                const next = { ...groups };
                if (n > 0 && n < conteo[g]) next[g] = n;
                else delete next[g];
                onChange(next);
              }}
              className="w-14 rounded-md border border-neutral-200 px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800"
            />
            {t("builder.exam.ofN", { n: conteo[g] })}
          </label>
        ))}
      </div>
    </div>
  );
}
