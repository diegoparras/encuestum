"use client";

import React from "react";

import { arrastrarCorrectas, BRANCH_END, BranchRule, BuilderQuestion, EvaluationSettings, LogicOperator, newChoice, RATE_PRESENTATIONS, typeHasChoices, VisibilityRule } from "./model";
import { useI18n } from "@/lib/i18n";

import { ChoicesEditor } from "./ChoicesEditor";

// Escalas Likert balanceadas (dos polos simétricos y punto medio).
const LIKERT: Record<string, string[]> = {
  acuerdo: ["Muy en desacuerdo", "En desacuerdo", "Ni de acuerdo ni en desacuerdo", "De acuerdo", "Muy de acuerdo"],
  frecuencia: ["Nunca", "Casi nunca", "A veces", "Casi siempre", "Siempre"],
  satisfaccion: ["Muy insatisfecho/a", "Insatisfecho/a", "Neutral", "Satisfecho/a", "Muy satisfecho/a"],
  importancia: ["Nada importante", "Poco importante", "Moderadamente importante", "Importante", "Muy importante"],
};
import { ImageChoicesEditor } from "./ImageChoicesEditor";
import { GradingSection } from "./GradingSection";
import { AssetPicker } from "./AssetPicker";
import { utcToLocalInput, localInputToUtc, tzLabel } from "@/utils/tz";
import { ArrowLeft, Film, GitBranch, Plus, Trash2 } from "lucide-react";
import { SectionTitle, Section, Field, ToggleRow } from "./panelUi";
import { ExamSettings } from "./ExamSettings";

interface Props {
  question: BuilderQuestion | null;
  questions: BuilderQuestion[];
  onQuestionChange: (patch: Partial<BuilderQuestion>) => void;
  // Vuelve a las opciones generales de la encuesta (deselecciona la pregunta).
  onBack?: () => void;
  // Survey-level settings (shown when no question is selected).
  description: string;
  onePerPage: boolean;
  showProgress: boolean;
  opensAt: string | null;
  closesAt: string | null;
  maxResponses: number | null;
  maxAttempts: number | null;
  thankyouMessage: string;
  gradingMessage: string;
  redirectUrl: string;
  // Link personalizado (slug). Se confirma al salir del campo (valida unicidad).
  slug: string;
  onSlugCommit: (slug: string) => void;
  // Zona horaria fija (config del servidor) para los campos de fecha.
  timezone: string;
  onSurveyChange: (patch: {
    description?: string;
    onePerPage?: boolean;
    showProgress?: boolean;
    opensAt?: string | null;
    closesAt?: string | null;
    maxResponses?: number | null;
    maxAttempts?: number | null;
    thankyouMessage?: string;
    gradingMessage?: string;
    redirectUrl?: string;
  }) => void;
  evaluation: EvaluationSettings;
  onEvaluationChange: (evaluation: EvaluationSettings) => void;
  accent: string;
  /** Para que la corrección pueda pedirle explicaciones a la IA. */
  surveyId?: string;
}

export function PropertiesPanel({
  question,
  questions,
  onQuestionChange,
  onBack,
  description,
  onePerPage,
  showProgress,
  opensAt,
  closesAt,
  maxResponses,
  maxAttempts,
  thankyouMessage,
  gradingMessage,
  redirectUrl,
  slug,
  onSlugCommit,
  timezone,
  onSurveyChange,
  evaluation,
  onEvaluationChange,
  accent,
  surveyId,
}: Props) {
  const { t } = useI18n();
  // Fechas en la zona horaria fija del servidor (ENCUESTUM_TIMEZONE).
  const toDateInput = (iso: string | null) => utcToLocalInput(iso, timezone);
  const fromDateInput = (v: string) => localInputToUtc(v, timezone);
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

        <SlugField slug={slug} onCommit={onSlugCommit} />

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
          <Section id="schedule" title={t("builder.props.schedule")}>
          <Field label={`${t("builder.props.openOnDate")} (${tzLabel(timezone)})`}>
            <input
              type="datetime-local"
              value={toDateInput(opensAt)}
              onChange={(e) =>
                onSurveyChange({ opensAt: fromDateInput(e.target.value) })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <Field label={`${t("builder.props.closeOnDate")} (${tzLabel(timezone)})`}>
            <input
              type="datetime-local"
              value={toDateInput(closesAt)}
              onChange={(e) =>
                onSurveyChange({ closesAt: fromDateInput(e.target.value) })
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
          <Field label={t("builder.props.maxAttempts")}>
            <input
              type="number"
              min={1}
              value={maxAttempts ?? ""}
              placeholder={t("builder.props.noLimit")}
              onChange={(e) =>
                onSurveyChange({
                  maxAttempts: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 1) : null,
                })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          {/* Honestidad sobre el alcance: fuera del modo lista el límite no es
              un candado, y conviene que quien lo configura lo sepa. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.maxAttemptsHint")}
          </p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.scheduleHint")}
          </p>
          </Section>
        </div>

        <div className="mt-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <Section id="onFinish" title={t("builder.props.onFinish")}>
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
          <Field label={t("builder.props.gradingMessage")}>
            <textarea
              value={gradingMessage}
              onChange={(e) => onSurveyChange({ gradingMessage: e.target.value })}
              rows={2}
              placeholder={t("builder.props.gradingPlaceholder")}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </Field>
          <p className="-mt-2 mb-4 text-xs text-neutral-400 dark:text-neutral-500">
            {t("builder.props.gradingHint")}
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
          </Section>
        </div>

        <ExamSettings
          evaluation={evaluation}
          onChange={onEvaluationChange}
          accent={accent}
          questions={questions}
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
        {onBack && <BackToSurvey onBack={onBack} label={t("builder.props.backToSurvey")} />}
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
      {onBack && <BackToSurvey onBack={onBack} label={t("builder.props.backToSurvey")} />}
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
              onChange={(choices) =>
                onQuestionChange({ choices, ...arrastrarCorrectas(q, choices) })
              }
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
              onChange={(choices) =>
                onQuestionChange({ choices, ...arrastrarCorrectas(q, choices) })
              }
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
            {/* Escalas Likert de uso habitual, balanceadas y con punto medio. */}
            <select
              value=""
              onChange={(e) => {
                const escala = LIKERT[e.target.value];
                if (escala) onQuestionChange({ matrixColumns: escala.map((x) => newChoice(x)) });
              }}
              className="mt-2 w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              <option value="">{t("builder.props.likert")}…</option>
              {Object.keys(LIKERT).map((k) => (
                <option key={k} value={k}>
                  {t(`builder.props.likert.${k}`)}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {(q.type === "number" || q.type === "slider") && (
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ["numMin", "builder.props.numMin"],
              ["numMax", "builder.props.numMax"],
              ["numStep", "builder.props.numStep"],
            ] as const
          ).map(([campo, etiqueta]) => (
            <Field key={campo} label={t(etiqueta)}>
              <input
                type="number"
                value={q[campo] ?? ""}
                onChange={(e) =>
                  onQuestionChange({ [campo]: e.target.value === "" ? undefined : Number(e.target.value) })
                }
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
              />
            </Field>
          ))}
        </div>
      )}

      {q.type === "consent" && (
        <p className="text-[11px] text-neutral-400">{t("builder.props.consentHint")}</p>
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
        <Field label={t("builder.exam.group")}>
          <input
            value={q.group ?? ""}
            onChange={(e) => onQuestionChange({ group: e.target.value || undefined })}
            placeholder={t("builder.exam.groupPlaceholder")}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
          />
        </Field>
      )}

      {/* Firma, consentimiento y teléfono no tienen "respuesta correcta". */}
      {evaluation.enabled && !["signature", "consent", "phone"].includes(q.type) && (
        <GradingSection question={q} accent={accent} onChange={onQuestionChange} surveyId={surveyId} />
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

function BackToSurvey({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-3 -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

// Link personalizado: input saneado en vivo (minúsculas, letras/números/guiones);
// confirma al salir del campo (el padre valida unicidad contra el servidor).
function SlugField({
  slug,
  onCommit,
}: {
  slug: string;
  onCommit: (slug: string) => void;
}) {
  const { t } = useI18n();
  const [val, setVal] = React.useState(slug);
  React.useEffect(() => {
    setVal(slug);
  }, [slug]);
  const sanitize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "");
  return (
    <Field label={t("builder.props.customLink")}>
      <div className="flex items-center rounded-md border border-neutral-200 focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800">
        <span className="pl-2.5 text-sm text-neutral-400 dark:text-neutral-500 select-none">
          /s/
        </span>
        <input
          value={val}
          onChange={(e) => setVal(sanitize(e.target.value))}
          onBlur={() => {
            const v = val.replace(/-+$/, "");
            if (v && v !== slug) onCommit(v);
            else setVal(slug);
          }}
          placeholder="mi-encuesta"
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-2 text-sm outline-none dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
      </div>
      <p className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">
        {t("builder.props.customLinkHint")}
      </p>
    </Field>
  );
}

