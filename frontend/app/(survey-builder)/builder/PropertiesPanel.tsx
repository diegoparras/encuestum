"use client";

import React from "react";
import { Switch } from "@/components/ui/switch";
import {
  AiCriteria,
  BRANCH_END,
  BranchRule,
  BuilderQuestion,
  EvaluationSettings,
  FeedbackTone,
  LogicOperator,
  RATE_PRESENTATIONS,
  Strictness,
  typeHasChoices,
  VisibilityRule,
} from "./model";
import { useI18n } from "@/lib/i18n";
import { ChoicesEditor } from "./ChoicesEditor";
import { ImageChoicesEditor } from "./ImageChoicesEditor";
import { GradingSection } from "./GradingSection";
import { AssetPicker } from "./AssetPicker";
import { Film, GitBranch, Plus, Sparkles, Trash2 } from "lucide-react";

interface Props {
  question: BuilderQuestion | null;
  questions: BuilderQuestion[];
  onQuestionChange: (patch: Partial<BuilderQuestion>) => void;
  // Survey-level settings (shown when no question is selected).
  description: string;
  onePerPage: boolean;
  showProgress: boolean;
  closesAt: string | null;
  maxResponses: number | null;
  thankyouMessage: string;
  redirectUrl: string;
  onSurveyChange: (patch: {
    description?: string;
    onePerPage?: boolean;
    showProgress?: boolean;
    closesAt?: string | null;
    maxResponses?: number | null;
    thankyouMessage?: string;
    redirectUrl?: string;
  }) => void;
  evaluation: EvaluationSettings;
  onEvaluationChange: (evaluation: EvaluationSettings) => void;
  accent: string;
}

export function PropertiesPanel({
  question,
  questions,
  onQuestionChange,
  description,
  onePerPage,
  showProgress,
  closesAt,
  maxResponses,
  thankyouMessage,
  redirectUrl,
  onSurveyChange,
  evaluation,
  onEvaluationChange,
  accent,
}: Props) {
  const { t } = useI18n();
  const toDateInput = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  if (!question) {
    return (
      <div className="p-5">
        <SectionTitle>{t("builder.props.surveySettings")}</SectionTitle>
        <Field label={t("builder.props.descriptionOptional")}>
          <textarea
            value={description}
            onChange={(e) => onSurveyChange({ description: e.target.value })}
            rows={3}
            placeholder={t("builder.props.descriptionPlaceholder")}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </Field>
        <ToggleRow
          label={t("builder.props.onePerPage")}
          hint={t("builder.props.onePerPageHint")}
          checked={onePerPage}
          onChange={(v) => onSurveyChange({ onePerPage: v })}
        />
        {onePerPage && (
          <ToggleRow
            label={t("builder.props.showProgress")}
            hint={t("builder.props.showProgressHint")}
            checked={showProgress}
            onChange={(v) => onSurveyChange({ showProgress: v })}
          />
        )}

        <div className="mt-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <SectionTitle>{t("builder.props.autoClose")}</SectionTitle>
          <Field label={t("builder.props.closeOnDate")}>
            <input
              type="datetime-local"
              value={toDateInput(closesAt)}
              onChange={(e) =>
                onSurveyChange({
                  closesAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <Field label={t("builder.props.maxResponses")}>
            <input
              type="number"
              min={1}
              value={maxResponses ?? ""}
              placeholder={t("builder.props.noLimit")}
              onChange={(e) =>
                onSurveyChange({
                  maxResponses: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 1) : null,
                })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.autoCloseHint")}
          </p>
        </div>

        <div className="mt-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <SectionTitle>{t("builder.props.onFinish")}</SectionTitle>
          <Field label={t("builder.props.thankYouMessage")}>
            <textarea
              value={thankyouMessage}
              onChange={(e) => onSurveyChange({ thankyouMessage: e.target.value })}
              rows={3}
              placeholder={t("builder.props.thankYouPlaceholder")}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <p className="-mt-2 mb-4 text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.thankYouHint")}
          </p>
          <Field label={t("builder.props.redirectOptional")}>
            <input
              type="url"
              value={redirectUrl}
              onChange={(e) => onSurveyChange({ redirectUrl: e.target.value })}
              placeholder={t("builder.props.redirectPlaceholder")}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.redirectHint")}
          </p>
        </div>

        <ExamSettings
          evaluation={evaluation}
          onChange={onEvaluationChange}
          accent={accent}
        />

        <p className="mt-6 text-xs text-neutral-400 dark:text-neutral-500 leading-relaxed">
          {t("builder.props.selectQuestionHint")}
        </p>
      </div>
    );
  }

  const q = question;

  // Las secciones no son preguntas: solo título, descripción y una nota.
  if (q.type === "section") {
    return (
      <div className="p-5">
        <SectionTitle>{t("builder.props.section")}</SectionTitle>

        <Field label={t("builder.props.sectionTitle")}>
          <input
            value={q.title}
            onChange={(e) => onQuestionChange({ title: e.target.value })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </Field>

        <Field label={t("builder.props.descriptionOptional")}>
          <textarea
            value={q.description ?? ""}
            onChange={(e) => onQuestionChange({ description: e.target.value })}
            rows={3}
            placeholder={t("builder.props.sectionDescPlaceholder")}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </Field>

        <p className="rounded-lg border border-neutral-100 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/60 p-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {t("builder.props.sectionNote")}
        </p>
      </div>
    );
  }

  const showPlaceholder = q.type === "text" || q.type === "email" || q.type === "comment";

  return (
    <div className="p-5">
      <SectionTitle>{t(`builder.qtype.${q.type}`)}</SectionTitle>

      <Field label={t("builder.props.question")}>
        <input
          value={q.title}
          onChange={(e) => onQuestionChange({ title: e.target.value })}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
      </Field>

      <Field label={t("builder.props.descriptionOptional")}>
        <textarea
          value={q.description ?? ""}
          onChange={(e) => onQuestionChange({ description: e.target.value })}
          rows={2}
          placeholder={t("builder.props.questionDescPlaceholder")}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
      </Field>

      <Field label={t("builder.props.questionImage")}>
        <AssetPicker
          kind="image"
          value={q.imageUrl}
          onChange={(url) => onQuestionChange({ imageUrl: url })}
        />
      </Field>

      <VideoSection
        videoUrl={q.videoUrl}
        onChange={(videoUrl) => onQuestionChange({ videoUrl })}
      />

      {/* Estilo SOLO de esta pregunta (pisa el diseño general) */}
      <div className="mt-1 mb-4 rounded-lg border border-neutral-100 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/60 p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t("builder.props.styleThisQuestion")}
        </p>

        <Field label={t("builder.props.alignment")}>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { value: undefined, label: t("builder.props.alignGeneral") },
                { value: "left", label: t("builder.props.alignLeft") },
                { value: "center", label: t("builder.props.alignCenter") },
              ] as const
            ).map((opt) => {
              const active = q.align === opt.value;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => onQuestionChange({ align: opt.value })}
                  className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-200"
                      : "border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 hover:border-neutral-300 dark:hover:border-neutral-700"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </Field>

        <ToggleRow
          label={t("builder.props.customTransparency")}
          hint={t("builder.props.customTransparencyHint")}
          checked={q.boxOpacity != null}
          onChange={(v) => onQuestionChange({ boxOpacity: v ? 0 : undefined })}
        />
        {q.boxOpacity != null && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-300">
              <span>{t("builder.props.boxOpacity")}</span>
              <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
                {Math.round((q.boxOpacity ?? 0) * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((q.boxOpacity ?? 0) * 100)}
              onChange={(e) =>
                onQuestionChange({ boxOpacity: Number(e.target.value) / 100 })
              }
              className="w-full accent-[#8faf0e]"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {t("builder.props.boxOpacityHint")}
            </p>
          </div>
        )}
      </div>

      {showPlaceholder && (
        <Field label={t("builder.props.placeholderExample")}>
          <input
            value={q.placeholder ?? ""}
            onChange={(e) => onQuestionChange({ placeholder: e.target.value })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </Field>
      )}

      {(q.type === "text" || q.type === "comment") && (
        <Field label={t("builder.props.maxChars")}>
          <input
            type="number"
            min={1}
            value={q.maxLength ?? ""}
            placeholder={t("builder.props.noLimit")}
            onChange={(e) =>
              onQuestionChange({
                maxLength: e.target.value
                  ? Math.max(1, parseInt(e.target.value, 10) || 1)
                  : undefined,
              })
            }
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.maxCharsHint")}
          </p>
        </Field>
      )}

      {q.type === "imagepicker" ? (
        <>
          <Field label={t("builder.props.optionsImage")}>
            <ImageChoicesEditor
              choices={q.choices ?? []}
              onChange={(choices) => onQuestionChange({ choices })}
            />
          </Field>
          <ToggleRow
            label={t("builder.props.allowMultiple")}
            hint={t("builder.props.allowMultipleHint")}
            checked={!!q.multiSelect}
            onChange={(v) => onQuestionChange({ multiSelect: v })}
          />
        </>
      ) : (
        typeHasChoices(q.type) && (
          <Field label={t("builder.props.options")}>
            <ChoicesEditor
              choices={q.choices ?? []}
              onChange={(choices) => onQuestionChange({ choices })}
            />
          </Field>
        )
      )}

      {q.type === "rating" && (
        <>
          <Field label={t("builder.props.presentation")}>
            <div className="grid grid-cols-2 gap-2">
              {RATE_PRESENTATIONS.map((p) => {
                const active = (q.ratePresentation ?? "numbers") === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onQuestionChange({ ratePresentation: p.id })}
                    className={`rounded-md border px-2.5 py-2 text-xs font-medium transition-colors ${
                      active
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-200"
                        : "border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 hover:border-neutral-300 dark:hover:border-neutral-700"
                    }`}
                  >
                    {t(`builder.rate.${p.id}`)}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("builder.props.min")}>
              <input
                type="number"
                value={q.rateMin ?? 0}
                onChange={(e) =>
                  onQuestionChange({ rateMin: Number(e.target.value) })
                }
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
            </Field>
            <Field label={t("builder.props.max")}>
              <input
                type="number"
                value={q.rateMax ?? 10}
                onChange={(e) =>
                  onQuestionChange({ rateMax: Number(e.target.value) })
                }
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
            </Field>
          </div>
          <Field label={t("builder.props.minLabel")}>
            <input
              value={q.minRateDescription ?? ""}
              onChange={(e) =>
                onQuestionChange({ minRateDescription: e.target.value })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <Field label={t("builder.props.maxLabel")}>
            <input
              value={q.maxRateDescription ?? ""}
              onChange={(e) =>
                onQuestionChange({ maxRateDescription: e.target.value })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
        </>
      )}

      {q.type === "boolean" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("builder.props.labelYes")}>
            <input
              value={q.labelTrue ?? ""}
              onChange={(e) => onQuestionChange({ labelTrue: e.target.value })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <Field label={t("builder.props.labelNo")}>
            <input
              value={q.labelFalse ?? ""}
              onChange={(e) => onQuestionChange({ labelFalse: e.target.value })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
        </div>
      )}

      {q.type === "matrix" && (
        <>
          <Field label={t("builder.props.matrixRows")}>
            <ChoicesEditor
              choices={q.matrixRows ?? []}
              onChange={(matrixRows) => onQuestionChange({ matrixRows })}
            />
          </Field>
          <Field label={t("builder.props.matrixColumns")}>
            <ChoicesEditor
              choices={q.matrixColumns ?? []}
              onChange={(matrixColumns) => onQuestionChange({ matrixColumns })}
            />
          </Field>
        </>
      )}

      {q.type === "date" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("builder.props.dateMin")}>
            <input
              type="date"
              value={q.dateMin ?? ""}
              onChange={(e) => onQuestionChange({ dateMin: e.target.value || undefined })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <Field label={t("builder.props.dateMax")}>
            <input
              type="date"
              value={q.dateMax ?? ""}
              onChange={(e) => onQuestionChange({ dateMax: e.target.value || undefined })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
        </div>
      )}

      {q.type === "fileupload" && (
        <>
          <ToggleRow
            label={t("builder.props.allowMultipleFiles")}
            hint={t("builder.props.allowMultipleFilesHint")}
            checked={!!q.fileMultiple}
            onChange={(v) => onQuestionChange({ fileMultiple: v })}
          />
          <Field label={t("builder.props.acceptedTypes")}>
            <input
              value={q.fileAccept ?? ""}
              onChange={(e) => onQuestionChange({ fileAccept: e.target.value })}
              placeholder={t("builder.props.acceptedTypesPlaceholder")}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
        </>
      )}

      <ToggleRow
        label={t("builder.props.required")}
        hint={t("builder.props.requiredHint")}
        checked={q.isRequired}
        onChange={(v) => onQuestionChange({ isRequired: v })}
      />

      {evaluation.enabled && (
        <GradingSection question={q} accent={accent} onChange={onQuestionChange} />
      )}

      <VisibilitySection
        question={q}
        questions={questions}
        onQuestionChange={onQuestionChange}
      />

      <BranchingSection
        question={q}
        questions={questions}
        onQuestionChange={onQuestionChange}
      />

      <details className="mt-4 group">
        <summary className="cursor-pointer text-xs font-medium text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 select-none">
          {t("builder.props.advanced")}
        </summary>
        <Field label={t("builder.props.keyVariable")}>
          <input
            value={q.name}
            onChange={(e) =>
              onQuestionChange({
                name: e.target.value.replace(/\s+/g, "_"),
              })
            }
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm font-mono outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </Field>
      </details>
    </div>
  );
}

const OPERATOR_OPTIONS: { value: LogicOperator; key: string }[] = [
  { value: "=", key: "builder.op.eq" },
  { value: "<>", key: "builder.op.neq" },
  { value: "contains", key: "builder.op.contains" },
  { value: ">", key: "builder.op.gt" },
  { value: "<", key: "builder.op.lt" },
  { value: "empty", key: "builder.op.empty" },
  { value: "notempty", key: "builder.op.notempty" },
];

function VisibilitySection({
  question,
  questions,
  onQuestionChange,
}: {
  question: BuilderQuestion;
  questions: BuilderQuestion[];
  onQuestionChange: (patch: Partial<BuilderQuestion>) => void;
}) {
  const { t } = useI18n();
  // Other questions that can be referenced (exclude the current one).
  const others = questions.filter((x) => x.id !== question.id);
  const rule = question.visibilityRule;
  const enabled = !!rule;

  function toggle(on: boolean) {
    if (on) {
      const first = others[0];
      if (!first) return;
      onQuestionChange({
        visibilityRule: { questionName: first.name, operator: "=", value: "" },
      });
    } else {
      onQuestionChange({ visibilityRule: undefined });
    }
  }

  function patchRule(patch: Partial<VisibilityRule>) {
    if (!rule) return;
    onQuestionChange({ visibilityRule: { ...rule, ...patch } });
  }

  const referenced = rule
    ? others.find((x) => x.name === rule.questionName)
    : undefined;
  const referencedChoices = referenced?.choices ?? [];
  const needsValue = rule
    ? rule.operator !== "empty" && rule.operator !== "notempty"
    : false;

  return (
    <div className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
      <ToggleRow
        label={t("builder.props.visibilityLogic")}
        hint={t("builder.props.visibilityHint")}
        checked={enabled}
        onChange={toggle}
      />

      {others.length === 0 && !enabled && (
        <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
          {t("builder.props.needPriorQuestion")}
        </p>
      )}

      {enabled && rule && (
        <div className="mt-2 space-y-3">
          <Field label={t("builder.props.question")}>
            <select
              value={rule.questionName}
              onChange={(e) => patchRule({ questionName: e.target.value })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            >
              {others.map((x) => (
                <option key={x.id} value={x.name}>
                  {x.title || x.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("builder.props.condition")}>
            <select
              value={rule.operator}
              onChange={(e) =>
                patchRule({ operator: e.target.value as LogicOperator })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            >
              {OPERATOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.key)}
                </option>
              ))}
            </select>
          </Field>

          {needsValue && (
            <Field label={t("builder.props.value")}>
              {referencedChoices.length > 0 ? (
                <select
                  value={rule.value}
                  onChange={(e) => patchRule({ value: e.target.value })}
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                >
                  <option value="">{t("builder.props.chooseOption")}</option>
                  {referencedChoices.map((c) => (
                    <option key={c.id} value={c.text}>
                      {c.text}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={rule.value}
                  onChange={(e) => patchRule({ value: e.target.value })}
                  placeholder={t("builder.props.valueToCompare")}
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              )}
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// Operadores para las reglas de salto (misma semántica que la visibilidad,
// pero con etiquetas pensadas para "si la respuesta…").
const BRANCH_OPERATOR_OPTIONS: { value: LogicOperator; key: string }[] = [
  { value: "=", key: "builder.bop.eq" },
  { value: "<>", key: "builder.bop.neq" },
  { value: "contains", key: "builder.bop.contains" },
  { value: ">", key: "builder.bop.gt" },
  { value: "<", key: "builder.bop.lt" },
  { value: "empty", key: "builder.bop.empty" },
  { value: "notempty", key: "builder.bop.notempty" },
];

function branchRuleId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID().slice(0, 8);
    }
  } catch {
    /* fall through */
  }
  return Math.random().toString(36).slice(2, 10);
}

function BranchingSection({
  question,
  questions,
  onQuestionChange,
}: {
  question: BuilderQuestion;
  questions: BuilderQuestion[];
  onQuestionChange: (patch: Partial<BuilderQuestion>) => void;
}) {
  const { t } = useI18n();
  // Solo se puede saltar hacia adelante: preguntas posteriores a la actual
  // (las secciones no son destinos válidos, no existen como pregunta).
  const idx = questions.findIndex((x) => x.id === question.id);
  const targets = questions
    .map((x, i) => ({ q: x, i }))
    .filter(({ q: x, i }) => i > idx && x.type !== "section");

  const rules = question.branching ?? [];
  const currentChoices = question.choices ?? [];

  function setRules(next: BranchRule[]) {
    onQuestionChange({ branching: next.length ? next : undefined });
  }

  function addRule() {
    const rule: BranchRule = {
      id: branchRuleId(),
      operator: "=",
      value: "",
      target: targets[0]?.q.name ?? BRANCH_END,
    };
    setRules([...rules, rule]);
  }

  function patchRule(id: string, patch: Partial<BranchRule>) {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRule(id: string) {
    setRules(rules.filter((r) => r.id !== id));
  }

  return (
    <div className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
      <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
        <GitBranch className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" /> {t("builder.branch.title")}
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("builder.branch.hint")}
      </p>

      {rules.map((rule) => {
        const needsValue = rule.operator !== "empty" && rule.operator !== "notempty";
        return (
          <div
            key={rule.id}
            className="mb-2 rounded-lg border border-neutral-100 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/60 p-2.5"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                    {t("builder.branch.ifAnswer")}
                  </span>
                  <select
                    value={rule.operator}
                    onChange={(e) =>
                      patchRule(rule.id, {
                        operator: e.target.value as LogicOperator,
                      })
                    }
                    className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                  >
                    {BRANCH_OPERATOR_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.key)}
                      </option>
                    ))}
                  </select>
                </div>

                {needsValue &&
                  (currentChoices.length > 0 ? (
                    <select
                      value={rule.value}
                      onChange={(e) => patchRule(rule.id, { value: e.target.value })}
                      className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                    >
                      <option value="">{t("builder.props.chooseOption")}</option>
                      {currentChoices.map((c) => (
                        <option key={c.id} value={c.text}>
                          {c.text}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={rule.value}
                      onChange={(e) => patchRule(rule.id, { value: e.target.value })}
                      placeholder={t("builder.props.valueToCompare")}
                      className="w-full rounded-md border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                    />
                  ))}

                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{t("builder.branch.goTo")}</span>
                  <select
                    value={rule.target}
                    onChange={(e) => patchRule(rule.id, { target: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                  >
                    {targets.map(({ q: x, i }) => (
                      <option key={x.id} value={x.name}>
                        {i + 1}. {x.title || x.name}
                      </option>
                    ))}
                    <option value={BRANCH_END}>{t("builder.branch.endSurvey")}</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                onClick={() => removeRule(rule.id)}
                className="shrink-0 p-1 text-neutral-400 dark:text-neutral-500 hover:text-red-600"
                aria-label={t("builder.branch.removeJump")}
                title={t("builder.branch.removeJump")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={addRule}
        className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-2.5 py-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 transition-colors hover:border-neutral-400 dark:hover:border-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <Plus className="h-3.5 w-3.5" /> {t("builder.branch.addJump")}
      </button>

      {rules.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          {t("builder.branch.footer")}
        </p>
      )}
    </div>
  );
}

function ExamSettings({
  evaluation,
  onChange,
  accent,
}: {
  evaluation: EvaluationSettings;
  onChange: (e: EvaluationSettings) => void;
  accent: string;
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
        <Field label={t("builder.exam.maxAttempts")}>
          <input
            type="number"
            min={1}
            value={evaluation.integrity.maxAttempts}
            onChange={(e) => setIntegrity({ maxAttempts: Number(e.target.value) })}
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
      </div>

      <AiGradingSection evaluation={evaluation} onChange={onChange} accent={accent} />
    </div>
  );
}

const FOCUS_SUGGESTIONS = [
  "contenido",
  "claridad",
  "originalidad",
  "ortografía",
  "ejemplos",
  "estructura",
];

function AiGradingSection({
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

function VideoSection({
  videoUrl,
  onChange,
}: {
  videoUrl?: string;
  onChange: (url: string | undefined) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-4 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
      <div className="mb-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
        <Film className="w-3.5 h-3.5 text-neutral-400 dark:text-neutral-500" /> {t("builder.video.title")}
      </div>

      <Field label={t("builder.video.urlLabel")}>
        <input
          value={videoUrl ?? ""}
          onChange={(e) => onChange(e.target.value.trim() || undefined)}
          placeholder={t("builder.video.urlPlaceholder")}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
      </Field>

      <div className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {t("builder.video.orUpload")}
      </div>
      <AssetPicker
        kind="video"
        value={videoUrl}
        onChange={(url) => onChange(url)}
      />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-4">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 mt-1">
      <div>
        <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</div>
        {hint && <div className="text-[11px] text-neutral-400 dark:text-neutral-500">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
