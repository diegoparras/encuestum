"use client";

import React, { useState } from "react";
import { Sparkles, Loader2, X } from "lucide-react";
import { readableForeground } from "./model";

interface Body {
  topic: string;
  count: number;
  types: string[];
  language: string;
  difficulty?: string;
  context?: string;
}

interface Props {
  open: boolean;
  accent: string;
  language: string;
  onClose: () => void;
  onGenerate: (body: Body) => Promise<void>;
}

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "radiogroup", label: "Opción única" },
  { value: "checkbox", label: "Opción múltiple" },
  { value: "comment", label: "Desarrollo (IA)" },
  { value: "boolean", label: "Verdadero / Falso" },
];

export function GenerateDialog({ open, accent, language, onClose, onGenerate }: Props) {
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState("media");
  const [types, setTypes] = useState<string[]>(["radiogroup", "comment"]);
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function toggleType(v: string) {
    setTypes((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  }

  async function run() {
    if (!topic.trim() || types.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      await onGenerate({
        topic: topic.trim(),
        count,
        types,
        language,
        difficulty,
        context: context.trim() || undefined,
      });
      onClose();
    } catch (e: any) {
      setError(e?.message || "No se pudieron generar las preguntas.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" style={{ color: accent }} />
            <h2 className="text-sm font-semibold">Generar preguntas con IA</h2>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <label className="block">
            <span className="block text-xs font-medium text-neutral-600 mb-1.5">
              Tema
            </span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Ej. Revolución Francesa, fotosíntesis, bucles en Python…"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
              autoFocus
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-neutral-600 mb-1.5">
                Cantidad
              </span>
              <input
                type="number"
                min={1}
                max={20}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-neutral-600 mb-1.5">
                Dificultad
              </span>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 bg-white"
              >
                <option value="fácil">Fácil</option>
                <option value="media">Media</option>
                <option value="difícil">Difícil</option>
              </select>
            </label>
          </div>

          <div>
            <span className="block text-xs font-medium text-neutral-600 mb-1.5">
              Tipos de pregunta
            </span>
            <div className="flex flex-wrap gap-2">
              {TYPE_OPTIONS.map((t) => {
                const active = types.includes(t.value);
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => toggleType(t.value)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      active ? "text-white border-transparent" : "border-neutral-200 text-neutral-600"
                    }`}
                    style={active ? { backgroundColor: accent } : undefined}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-neutral-600 mb-1.5">
              Material de base (opcional)
            </span>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={3}
              placeholder="Pegá un texto y las preguntas se basarán en él"
              className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-neutral-100">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Cancelar
          </button>
          <button
            onClick={run}
            disabled={loading || !topic.trim() || types.length === 0}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
            style={{ backgroundColor: accent, color: readableForeground(accent) }}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Generar
          </button>
        </div>
      </div>
    </div>
  );
}
