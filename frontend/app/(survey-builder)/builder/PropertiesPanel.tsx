"use client";

import React from "react";
import { Switch } from "@/components/ui/switch";
import {
  BuilderQuestion,
  EvaluationSettings,
  QUESTION_TYPE_LABEL,
  typeHasChoices,
} from "./model";
import { ChoicesEditor } from "./ChoicesEditor";
import { GradingSection } from "./GradingSection";
import { AssetPicker } from "./AssetPicker";

interface Props {
  question: BuilderQuestion | null;
  onQuestionChange: (patch: Partial<BuilderQuestion>) => void;
  // Survey-level settings (shown when no question is selected).
  description: string;
  onePerPage: boolean;
  onSurveyChange: (patch: { description?: string; onePerPage?: boolean }) => void;
  evaluation: EvaluationSettings;
  onEvaluationChange: (evaluation: EvaluationSettings) => void;
  accent: string;
}

export function PropertiesPanel({
  question,
  onQuestionChange,
  description,
  onePerPage,
  onSurveyChange,
  evaluation,
  onEvaluationChange,
  accent,
}: Props) {
  if (!question) {
    return (
      <div className="p-5">
        <SectionTitle>Ajustes de la encuesta</SectionTitle>
        <Field label="Descripción (opcional)">
          <textarea
            value={description}
            onChange={(e) => onSurveyChange({ description: e.target.value })}
            rows={3}
            placeholder="Un subtítulo o contexto para quien responde"
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
          />
        </Field>
        <ToggleRow
          label="Una pregunta por pantalla"
          hint="Experiencia tipo Typeform, con barra de progreso"
          checked={onePerPage}
          onChange={(v) => onSurveyChange({ onePerPage: v })}
        />

        <ExamSettings
          evaluation={evaluation}
          onChange={onEvaluationChange}
          accent={accent}
        />

        <p className="mt-6 text-xs text-neutral-400 leading-relaxed">
          Seleccioná una pregunta de la izquierda para editar su contenido, o
          agregá una nueva desde la paleta.
        </p>
      </div>
    );
  }

  const q = question;
  const showPlaceholder = q.type === "text" || q.type === "email" || q.type === "comment";

  return (
    <div className="p-5">
      <SectionTitle>{QUESTION_TYPE_LABEL[q.type]}</SectionTitle>

      <Field label="Pregunta">
        <input
          value={q.title}
          onChange={(e) => onQuestionChange({ title: e.target.value })}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
        />
      </Field>

      <Field label="Descripción (opcional)">
        <textarea
          value={q.description ?? ""}
          onChange={(e) => onQuestionChange({ description: e.target.value })}
          rows={2}
          placeholder="Texto de ayuda debajo de la pregunta"
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
        />
      </Field>

      <Field label="Imagen de la pregunta (opcional)">
        <AssetPicker
          kind="image"
          value={q.imageUrl}
          onChange={(url) => onQuestionChange({ imageUrl: url })}
        />
      </Field>

      {showPlaceholder && (
        <Field label="Texto de ejemplo (placeholder)">
          <input
            value={q.placeholder ?? ""}
            onChange={(e) => onQuestionChange({ placeholder: e.target.value })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
          />
        </Field>
      )}

      {typeHasChoices(q.type) && (
        <Field label="Opciones">
          <ChoicesEditor
            choices={q.choices ?? []}
            onChange={(choices) => onQuestionChange({ choices })}
          />
        </Field>
      )}

      {q.type === "rating" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mínimo">
              <input
                type="number"
                value={q.rateMin ?? 0}
                onChange={(e) =>
                  onQuestionChange({ rateMin: Number(e.target.value) })
                }
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
              />
            </Field>
            <Field label="Máximo">
              <input
                type="number"
                value={q.rateMax ?? 10}
                onChange={(e) =>
                  onQuestionChange({ rateMax: Number(e.target.value) })
                }
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
              />
            </Field>
          </div>
          <Field label="Etiqueta del mínimo">
            <input
              value={q.minRateDescription ?? ""}
              onChange={(e) =>
                onQuestionChange({ minRateDescription: e.target.value })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <Field label="Etiqueta del máximo">
            <input
              value={q.maxRateDescription ?? ""}
              onChange={(e) =>
                onQuestionChange({ maxRateDescription: e.target.value })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
        </>
      )}

      {q.type === "boolean" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Etiqueta “Sí”">
            <input
              value={q.labelTrue ?? ""}
              onChange={(e) => onQuestionChange({ labelTrue: e.target.value })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <Field label="Etiqueta “No”">
            <input
              value={q.labelFalse ?? ""}
              onChange={(e) => onQuestionChange({ labelFalse: e.target.value })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
        </div>
      )}

      <ToggleRow
        label="Obligatoria"
        hint="No se puede enviar sin responder"
        checked={q.isRequired}
        onChange={(v) => onQuestionChange({ isRequired: v })}
      />

      {evaluation.enabled && (
        <GradingSection question={q} accent={accent} onChange={onQuestionChange} />
      )}

      <details className="mt-4 group">
        <summary className="cursor-pointer text-xs font-medium text-neutral-400 hover:text-neutral-600 select-none">
          Avanzado
        </summary>
        <Field label="Clave / variable (para exportar datos)">
          <input
            value={q.name}
            onChange={(e) =>
              onQuestionChange({
                name: e.target.value.replace(/\s+/g, "_"),
              })
            }
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm font-mono outline-none focus:border-neutral-400"
          />
        </Field>
      </details>
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
  if (!evaluation.enabled) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-neutral-200 p-3 text-xs text-neutral-400">
        Activá <span className="font-medium">Examen</span> en la barra superior
        para corregir respuestas con puntaje y feedback por IA.
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
        Modo evaluación
      </div>

      <Field label="Cuándo ve el resultado quien responde">
        <select
          value={evaluation.feedbackTiming}
          onChange={(e) => set({ feedbackTiming: e.target.value as any })}
          className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white"
        >
          <option value="onComplete">Al finalizar (nota + feedback)</option>
          <option value="immediate">Inmediato (pregunta a pregunta)</option>
          <option value="never">Nunca (solo lo ve el profe)</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Nota para aprobar (%)">
          <input
            type="number"
            min={0}
            max={100}
            value={evaluation.passingScore}
            onChange={(e) => set({ passingScore: Number(e.target.value) })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400"
          />
        </Field>
        <Field label="Intentos máx.">
          <input
            type="number"
            min={1}
            value={evaluation.integrity.maxAttempts}
            onChange={(e) => setIntegrity({ maxAttempts: Number(e.target.value) })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400"
          />
        </Field>
      </div>

      <div className="mt-1 space-y-1.5">
        <ToggleRow
          label="Mostrar la nota al que responde"
          checked={evaluation.showScoreToRespondent}
          onChange={(v) => set({ showScoreToRespondent: v })}
        />
        <ToggleRow
          label="Doble corrección (2ª opinión)"
          hint="Si discrepan, va a revisión humana"
          checked={evaluation.doublePass}
          onChange={(v) => set({ doublePass: v })}
        />
        <ToggleRow
          label="Barajar preguntas"
          checked={evaluation.integrity.shuffleQuestions}
          onChange={(v) => setIntegrity({ shuffleQuestions: v })}
        />
        <ToggleRow
          label="Barajar opciones"
          checked={evaluation.integrity.shuffleChoices}
          onChange={(v) => setIntegrity({ shuffleChoices: v })}
        />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 mb-4">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <span className="block text-xs font-medium text-neutral-600 mb-1.5">
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
        <div className="text-sm font-medium text-neutral-700">{label}</div>
        {hint && <div className="text-[11px] text-neutral-400">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
