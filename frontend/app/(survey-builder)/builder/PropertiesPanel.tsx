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
  QUESTION_TYPE_LABEL,
  RATE_PRESENTATIONS,
  Strictness,
  typeHasChoices,
  VisibilityRule,
} from "./model";
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
  const toDateInput = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
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
          hint="Experiencia tipo Typeform"
          checked={onePerPage}
          onChange={(v) => onSurveyChange({ onePerPage: v })}
        />
        {onePerPage && (
          <ToggleRow
            label="Mostrar progreso"
            hint="Muestra «Pregunta 1 de 3» arriba"
            checked={showProgress}
            onChange={(v) => onSurveyChange({ showProgress: v })}
          />
        )}

        <div className="mt-5 border-t border-neutral-100 pt-4">
          <SectionTitle>Cierre automático</SectionTitle>
          <Field label="Cerrar en una fecha (opcional)">
            <input
              type="datetime-local"
              value={toDateInput(closesAt)}
              onChange={(e) =>
                onSurveyChange({
                  closesAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <Field label="Máximo de respuestas (opcional)">
            <input
              type="number"
              min={1}
              value={maxResponses ?? ""}
              placeholder="Sin límite"
              onChange={(e) =>
                onSurveyChange({
                  maxResponses: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 1) : null,
                })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <p className="text-xs text-neutral-400">
            La encuesta deja de aceptar respuestas al llegar la fecha o el cupo.
          </p>
        </div>

        <div className="mt-5 border-t border-neutral-100 pt-4">
          <SectionTitle>Al terminar</SectionTitle>
          <Field label="Mensaje de agradecimiento">
            <textarea
              value={thankyouMessage}
              onChange={(e) => onSurveyChange({ thankyouMessage: e.target.value })}
              rows={3}
              placeholder="¡Gracias por responder!"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <p className="-mt-2 mb-4 text-xs text-neutral-400">
            Se muestra al terminar. Si lo dejás vacío, se muestra el mensaje por
            defecto.
          </p>
          <Field label="Redirigir al terminar (opcional)">
            <input
              type="url"
              value={redirectUrl}
              onChange={(e) => onSurveyChange({ redirectUrl: e.target.value })}
              placeholder="https://tu-sitio.com/gracias"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <p className="-mt-2 text-xs text-neutral-400">
            Al enviar, se redirige a esta URL (ej. tu sitio o un agradecimiento
            propio). Si está seteada, tiene prioridad sobre el mensaje.
          </p>
        </div>

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

  // Las secciones no son preguntas: solo título, descripción y una nota.
  if (q.type === "section") {
    return (
      <div className="p-5">
        <SectionTitle>Sección</SectionTitle>

        <Field label="Título de la sección">
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
            rows={3}
            placeholder="Un texto introductorio para esta sección"
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
          />
        </Field>

        <p className="rounded-lg border border-neutral-100 bg-neutral-50/60 p-3 text-xs leading-relaxed text-neutral-500">
          Las preguntas debajo de esta sección quedan agrupadas. En modo normal,
          cada sección es una página con botón Siguiente; en una-por-pantalla,
          la sección muestra una portada.
        </p>
      </div>
    );
  }

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

      <VideoSection
        videoUrl={q.videoUrl}
        onChange={(videoUrl) => onQuestionChange({ videoUrl })}
      />

      {/* Estilo SOLO de esta pregunta (pisa el diseño general) */}
      <div className="mt-1 mb-4 rounded-lg border border-neutral-100 bg-neutral-50/60 p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Estilo de esta pregunta
        </p>

        <Field label="Alineación">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { value: undefined, label: "General" },
                { value: "left", label: "Izquierda" },
                { value: "center", label: "Centrado" },
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
                      ? "border-[#e25a4e] bg-[#e25a4e0a] text-neutral-800"
                      : "border-neutral-200 text-neutral-500 hover:border-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </Field>

        <ToggleRow
          label="Transparencia personalizada"
          hint="Pisa la opacidad del diseño solo acá"
          checked={q.boxOpacity != null}
          onChange={(v) => onQuestionChange({ boxOpacity: v ? 0 : undefined })}
        />
        {q.boxOpacity != null && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-xs text-neutral-600">
              <span>Opacidad del cuadro</span>
              <span className="tabular-nums text-neutral-400">
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
              className="w-full accent-[#e25a4e]"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
              0% = sin cuadro (ideal para escalas/NPS sobre una imagen de fondo).
            </p>
          </div>
        )}
      </div>

      {showPlaceholder && (
        <Field label="Texto de ejemplo (placeholder)">
          <input
            value={q.placeholder ?? ""}
            onChange={(e) => onQuestionChange({ placeholder: e.target.value })}
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
          />
        </Field>
      )}

      {(q.type === "text" || q.type === "comment") && (
        <Field label="Máximo de caracteres (opcional)">
          <input
            type="number"
            min={1}
            value={q.maxLength ?? ""}
            placeholder="Sin límite"
            onChange={(e) =>
              onQuestionChange({
                maxLength: e.target.value
                  ? Math.max(1, parseInt(e.target.value, 10) || 1)
                  : undefined,
              })
            }
            className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
          />
          <p className="mt-1 text-xs text-neutral-400">
            Quien responde ve un contador y no puede pasarse.
          </p>
        </Field>
      )}

      {q.type === "imagepicker" ? (
        <>
          <Field label="Opciones (imagen)">
            <ImageChoicesEditor
              choices={q.choices ?? []}
              onChange={(choices) => onQuestionChange({ choices })}
            />
          </Field>
          <ToggleRow
            label="Permitir varias"
            hint="Quien responde puede elegir más de una imagen"
            checked={!!q.multiSelect}
            onChange={(v) => onQuestionChange({ multiSelect: v })}
          />
        </>
      ) : (
        typeHasChoices(q.type) && (
          <Field label="Opciones">
            <ChoicesEditor
              choices={q.choices ?? []}
              onChange={(choices) => onQuestionChange({ choices })}
            />
          </Field>
        )
      )}

      {q.type === "rating" && (
        <>
          <Field label="Presentación">
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
                        ? "border-[#e25a4e] bg-[#e25a4e0a] text-neutral-800"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </Field>
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

      {q.type === "matrix" && (
        <>
          <Field label="Filas (cada una se responde por separado)">
            <ChoicesEditor
              choices={q.matrixRows ?? []}
              onChange={(matrixRows) => onQuestionChange({ matrixRows })}
            />
          </Field>
          <Field label="Columnas (opciones únicas por fila)">
            <ChoicesEditor
              choices={q.matrixColumns ?? []}
              onChange={(matrixColumns) => onQuestionChange({ matrixColumns })}
            />
          </Field>
        </>
      )}

      {q.type === "date" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha mínima (opcional)">
            <input
              type="date"
              value={q.dateMin ?? ""}
              onChange={(e) => onQuestionChange({ dateMin: e.target.value || undefined })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
          <Field label="Fecha máxima (opcional)">
            <input
              type="date"
              value={q.dateMax ?? ""}
              onChange={(e) => onQuestionChange({ dateMax: e.target.value || undefined })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
        </div>
      )}

      {q.type === "fileupload" && (
        <>
          <ToggleRow
            label="Permitir varios archivos"
            hint="Quien responde puede adjuntar más de un archivo"
            checked={!!q.fileMultiple}
            onChange={(v) => onQuestionChange({ fileMultiple: v })}
          />
          <Field label="Tipos aceptados (opcional)">
            <input
              value={q.fileAccept ?? ""}
              onChange={(e) => onQuestionChange({ fileAccept: e.target.value })}
              placeholder="Ej. .pdf,.docx,.jpg (vacío = cualquiera)"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
        </>
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

const OPERATOR_OPTIONS: { value: LogicOperator; label: string }[] = [
  { value: "=", label: "es igual a" },
  { value: "<>", label: "es distinto de" },
  { value: "contains", label: "contiene" },
  { value: ">", label: "es mayor que" },
  { value: "<", label: "es menor que" },
  { value: "empty", label: "está vacía" },
  { value: "notempty", label: "fue respondida" },
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
    <div className="mt-4 rounded-xl border border-neutral-200 p-3">
      <ToggleRow
        label="Lógica de visibilidad"
        hint="Mostrar esta pregunta sólo si…"
        checked={enabled}
        onChange={toggle}
      />

      {others.length === 0 && !enabled && (
        <p className="mt-1 text-[11px] text-neutral-400">
          Necesitás otra pregunta antes para condicionar esta.
        </p>
      )}

      {enabled && rule && (
        <div className="mt-2 space-y-3">
          <Field label="Pregunta">
            <select
              value={rule.questionName}
              onChange={(e) => patchRule({ questionName: e.target.value })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white"
            >
              {others.map((x) => (
                <option key={x.id} value={x.name}>
                  {x.title || x.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Condición">
            <select
              value={rule.operator}
              onChange={(e) =>
                patchRule({ operator: e.target.value as LogicOperator })
              }
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white"
            >
              {OPERATOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          {needsValue && (
            <Field label="Valor">
              {referencedChoices.length > 0 ? (
                <select
                  value={rule.value}
                  onChange={(e) => patchRule({ value: e.target.value })}
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white"
                >
                  <option value="">Elegí una opción…</option>
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
                  placeholder="Valor a comparar"
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
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
const BRANCH_OPERATOR_OPTIONS: { value: LogicOperator; label: string }[] = [
  { value: "=", label: "es igual a" },
  { value: "<>", label: "es distinta de" },
  { value: "contains", label: "contiene" },
  { value: ">", label: "es mayor que" },
  { value: "<", label: "es menor que" },
  { value: "empty", label: "está vacía" },
  { value: "notempty", label: "tiene algo" },
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
    <div className="mt-4 rounded-xl border border-neutral-200 p-3">
      <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-600">
        <GitBranch className="h-3.5 w-3.5 text-neutral-400" /> Bifurcación (saltos)
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-neutral-400">
        Según la respuesta, salta a una pregunta posterior o termina la encuesta.
      </p>

      {rules.map((rule) => {
        const needsValue = rule.operator !== "empty" && rule.operator !== "notempty";
        return (
          <div
            key={rule.id}
            className="mb-2 rounded-lg border border-neutral-100 bg-neutral-50/60 p-2.5"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-neutral-500">
                    Si la respuesta
                  </span>
                  <select
                    value={rule.operator}
                    onChange={(e) =>
                      patchRule(rule.id, {
                        operator: e.target.value as LogicOperator,
                      })
                    }
                    className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400"
                  >
                    {BRANCH_OPERATOR_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                {needsValue &&
                  (currentChoices.length > 0 ? (
                    <select
                      value={rule.value}
                      onChange={(e) => patchRule(rule.id, { value: e.target.value })}
                      className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400"
                    >
                      <option value="">Elegí una opción…</option>
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
                      placeholder="Valor a comparar"
                      className="w-full rounded-md border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-neutral-400"
                    />
                  ))}

                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-neutral-500">→ Ir a</span>
                  <select
                    value={rule.target}
                    onChange={(e) => patchRule(rule.id, { target: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400"
                  >
                    {targets.map(({ q: x, i }) => (
                      <option key={x.id} value={x.name}>
                        {i + 1}. {x.title || x.name}
                      </option>
                    ))}
                    <option value={BRANCH_END}>🏁 Terminar la encuesta</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                onClick={() => removeRule(rule.id)}
                className="shrink-0 p-1 text-neutral-400 hover:text-red-600"
                aria-label="Eliminar salto"
                title="Eliminar salto"
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
        className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-700"
      >
        <Plus className="h-3.5 w-3.5" /> Agregar salto
      </button>

      {rules.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
          Los saltos se evalúan al responder. Tienen prioridad sobre el orden
          normal.
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
    <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-3">
      <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
        <Sparkles className="h-3.5 w-3.5" style={{ color: accent }} /> Corrección con IA
      </div>

      <ToggleRow
        label="Usar criterios personalizados para la IA correctora"
        checked={ai.enabled}
        onChange={(v) => setAi({ enabled: v })}
      />

      {ai.enabled && (
        <div className="mt-2 space-y-3">
          <Field label="Nivel de exigencia">
            <select
              value={ai.strictness}
              onChange={(e) => setAi({ strictness: e.target.value as Strictness })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white"
            >
              <option value="indulgente">Indulgente</option>
              <option value="equilibrado">Equilibrado</option>
              <option value="estricto">Estricto</option>
            </select>
          </Field>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-neutral-600">
              Qué priorizar
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
                        : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                    }`}
                    style={active ? { backgroundColor: accent } : undefined}
                  >
                    {f}
                  </button>
                );
              })}
            </div>
          </div>

          <Field label="Tono del feedback">
            <select
              value={ai.tone}
              onChange={(e) => setAi({ tone: e.target.value as FeedbackTone })}
              className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 bg-white"
            >
              <option value="motivador">Motivador</option>
              <option value="neutral">Neutral</option>
              <option value="directo">Directo</option>
            </select>
          </Field>

          <Field label="Instrucciones">
            <textarea
              value={ai.instructions}
              onChange={(e) => setAi({ instructions: e.target.value })}
              rows={3}
              placeholder="Ej. Penalizá respuestas sin ejemplos concretos"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </Field>
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
        Estos criterios guían a la IA que corrige las respuestas abiertas; no
        anulan las reglas de seguridad.
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
  return (
    <div className="mb-4 rounded-xl border border-neutral-200 p-3">
      <div className="mb-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-600">
        <Film className="w-3.5 h-3.5 text-neutral-400" /> Video (opcional)
      </div>

      <Field label="URL (YouTube, Vimeo o mp4)">
        <input
          value={videoUrl ?? ""}
          onChange={(e) => onChange(e.target.value.trim() || undefined)}
          placeholder="https://youtu.be/…"
          className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
        />
      </Field>

      <div className="mb-1 text-xs font-medium text-neutral-600">
        …o subí tu propio video
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
