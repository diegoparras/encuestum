"use client";

import React from "react";
import { Switch } from "@/components/ui/switch";
import { BuilderQuestion, Choice } from "./model";
import { RubricEditor } from "./RubricEditor";
import { resolveAssetUrl } from "./design";

interface Props {
  question: BuilderQuestion;
  accent: string;
  onChange: (patch: Partial<BuilderQuestion>) => void;
}

const OPEN_TYPES = new Set(["text", "email", "comment"]);

export function GradingSection({ question: q, accent, onChange }: Props) {
  const isOpen = OPEN_TYPES.has(q.type);
  const grader = q.grader ?? (isOpen ? "llm" : "auto");
  const choiceTexts = (q.choices ?? []).map((c) => c.text).filter((t) => t.trim());

  return (
    <div
      className="mt-5 rounded-xl border p-3"
      style={{ borderColor: `${accent}44`, backgroundColor: `${accent}0a` }}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold" style={{ color: accent }}>
          Evaluación
        </div>
        <Switch
          checked={!!q.gradable}
          onCheckedChange={(v) =>
            onChange({ gradable: v, grader: q.grader ?? (isOpen ? "llm" : "auto") })
          }
        />
      </div>

      {q.gradable && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Puntos</label>
            <input
              type="number"
              min={0}
              step={0.5}
              value={q.points ?? 1}
              onChange={(e) => onChange({ points: Number(e.target.value) })}
              className="w-20 rounded-md border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </div>

          {isOpen && (
            <div>
              <div className="text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1.5">
                Cómo se corrige
              </div>
              <div className="flex gap-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 p-0.5 text-xs">
                <GraderTab
                  active={grader === "llm"}
                  onClick={() => onChange({ grader: "llm" })}
                  accent={accent}
                >
                  IA (rúbrica)
                </GraderTab>
                <GraderTab
                  active={grader === "auto"}
                  onClick={() => onChange({ grader: "auto" })}
                  accent={accent}
                >
                  Exacta
                </GraderTab>
              </div>
            </div>
          )}

          {/* Answer key by type */}
          {(q.type === "radiogroup" || q.type === "dropdown") && (
            <SingleCorrect
              choices={choiceTexts}
              value={q.correctText?.[0]}
              onChange={(v) => onChange({ correctText: v ? [v] : [] })}
            />
          )}

          {q.type === "checkbox" && (
            <MultiCorrect
              choices={choiceTexts}
              value={q.correctChoices ?? []}
              partial={!!q.partialCredit}
              onChange={(vals) => onChange({ correctChoices: vals })}
              onPartial={(v) => onChange({ partialCredit: v })}
            />
          )}

          {q.type === "imagepicker" &&
            (q.multiSelect ? (
              <ImageMultiCorrect
                choices={q.choices ?? []}
                value={q.correctChoices ?? []}
                partial={!!q.partialCredit}
                onChange={(vals) => onChange({ correctChoices: vals })}
                onPartial={(v) => onChange({ partialCredit: v })}
              />
            ) : (
              <ImageSingleCorrect
                choices={q.choices ?? []}
                value={q.correctChoices?.[0]}
                onChange={(v) => onChange({ correctChoices: v ? [v] : [] })}
              />
            ))}

          {q.type === "boolean" && (
            <Field label="Respuesta correcta">
              <div className="flex gap-2">
                <PillButton
                  active={q.correctBool === true}
                  onClick={() => onChange({ correctBool: true })}
                  accent={accent}
                >
                  {q.labelTrue ?? "Sí"}
                </PillButton>
                <PillButton
                  active={q.correctBool === false}
                  onClick={() => onChange({ correctBool: false })}
                  accent={accent}
                >
                  {q.labelFalse ?? "No"}
                </PillButton>
              </div>
            </Field>
          )}

          {q.type === "rating" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Valor correcto">
                <input
                  type="number"
                  value={q.correctNumber ?? ""}
                  onChange={(e) =>
                    onChange({
                      correctNumber:
                        e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              </Field>
              <Field label="Tolerancia (±)">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={q.tolerance ?? 0}
                  onChange={(e) => onChange({ tolerance: Number(e.target.value) })}
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              </Field>
            </div>
          )}

          {isOpen && grader === "auto" && (
            <>
              <Field label="Respuestas aceptadas (una por línea)">
                <textarea
                  value={(q.correctText ?? []).join("\n")}
                  onChange={(e) =>
                    onChange({
                      correctText: e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  rows={3}
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              </Field>
              <ToggleRow
                label="Distingue mayúsculas"
                checked={!!q.caseSensitive}
                onChange={(v) => onChange({ caseSensitive: v })}
              />
            </>
          )}

          {isOpen && grader === "llm" && (
            <>
              <Field label="Respuesta modelo">
                <textarea
                  value={q.modelAnswer ?? ""}
                  onChange={(e) => onChange({ modelAnswer: e.target.value })}
                  rows={3}
                  placeholder="La respuesta ideal contra la que se corrige"
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              </Field>
              <Field label="Conceptos clave (separados por coma)">
                <input
                  value={(q.keyConcepts ?? []).join(", ")}
                  onChange={(e) =>
                    onChange({
                      keyConcepts: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
              </Field>
              <Field label="Rúbrica">
                <RubricEditor
                  rubric={q.rubric ?? []}
                  onChange={(rubric) => onChange({ rubric })}
                />
              </Field>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SingleCorrect({
  choices,
  value,
  onChange,
}: {
  choices: string[];
  value?: string;
  onChange: (v: string) => void;
}) {
  if (!choices.length)
    return <Hint>Agregá opciones para marcar la correcta.</Hint>;
  return (
    <Field label="Opción correcta">
      <div className="space-y-1">
        {choices.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              checked={value === c}
              onChange={() => onChange(c)}
            />
            {c}
          </label>
        ))}
      </div>
    </Field>
  );
}

function MultiCorrect({
  choices,
  value,
  partial,
  onChange,
  onPartial,
}: {
  choices: string[];
  value: string[];
  partial: boolean;
  onChange: (v: string[]) => void;
  onPartial: (v: boolean) => void;
}) {
  if (!choices.length)
    return <Hint>Agregá opciones para marcar las correctas.</Hint>;
  function toggle(c: string) {
    onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  }
  return (
    <Field label="Opciones correctas">
      <div className="space-y-1">
        {choices.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={value.includes(c)}
              onChange={() => toggle(c)}
            />
            {c}
          </label>
        ))}
      </div>
      <div className="mt-2">
        <ToggleRow
          label="Crédito parcial"
          checked={partial}
          onChange={onPartial}
        />
      </div>
    </Field>
  );
}

// Answer key for imagepicker: choose the correct option(s) by their thumbnail
// and label. Stores the option text in q.correctChoices (matching the model).
function choiceKey(c: Choice, i: number): string {
  return c.text?.trim() ? c.text : `Opción ${i + 1}`;
}

function ImageChoiceThumb({ choice }: { choice: Choice }) {
  if (!choice.imageUrl)
    return (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-neutral-100 dark:bg-neutral-800 text-[10px] text-neutral-400 dark:text-neutral-500">
        —
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolveAssetUrl(choice.imageUrl)}
      alt=""
      className="h-9 w-9 shrink-0 rounded object-cover bg-neutral-100 dark:bg-neutral-800"
    />
  );
}

function ImageSingleCorrect({
  choices,
  value,
  onChange,
}: {
  choices: Choice[];
  value?: string;
  onChange: (v: string) => void;
}) {
  if (!choices.length)
    return <Hint>Agregá opciones para marcar la correcta.</Hint>;
  return (
    <Field label="Imagen correcta">
      <div className="space-y-1">
        {choices.map((c, i) => {
          const key = choiceKey(c, i);
          return (
            <label
              key={c.id}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <input
                type="radio"
                checked={value === key}
                onChange={() => onChange(key)}
              />
              <ImageChoiceThumb choice={c} />
              <span className="truncate">{key}</span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}

function ImageMultiCorrect({
  choices,
  value,
  partial,
  onChange,
  onPartial,
}: {
  choices: Choice[];
  value: string[];
  partial: boolean;
  onChange: (v: string[]) => void;
  onPartial: (v: boolean) => void;
}) {
  if (!choices.length)
    return <Hint>Agregá opciones para marcar las correctas.</Hint>;
  function toggle(key: string) {
    onChange(value.includes(key) ? value.filter((x) => x !== key) : [...value, key]);
  }
  return (
    <Field label="Imágenes correctas">
      <div className="space-y-1">
        {choices.map((c, i) => {
          const key = choiceKey(c, i);
          return (
            <label
              key={c.id}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <input
                type="checkbox"
                checked={value.includes(key)}
                onChange={() => toggle(key)}
              />
              <ImageChoiceThumb choice={c} />
              <span className="truncate">{key}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2">
        <ToggleRow label="Crédito parcial" checked={partial} onChange={onPartial} />
      </div>
    </Field>
  );
}

function GraderTab({
  active,
  onClick,
  accent,
  children,
}: {
  active: boolean;
  onClick: () => void;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1 font-medium transition-colors ${
        active ? "bg-white dark:bg-neutral-900 shadow-sm" : "text-neutral-500 dark:text-neutral-400"
      }`}
      style={active ? { color: accent } : undefined}
    >
      {children}
    </button>
  );
}

function PillButton({
  active,
  onClick,
  accent,
  children,
}: {
  active: boolean;
  onClick: () => void;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "text-white border-transparent" : "border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300"
      }`}
      style={active ? { backgroundColor: accent } : undefined}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-neutral-400 dark:text-neutral-500">{children}</p>;
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-700 dark:text-neutral-300">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
