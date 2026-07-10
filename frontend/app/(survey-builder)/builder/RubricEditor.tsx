"use client";

import React from "react";
import { Plus, X } from "lucide-react";
import { RubricItem, newRubricItem } from "./model";
import { useI18n } from "@/lib/i18n";

interface Props {
  rubric: RubricItem[];
  onChange: (rubric: RubricItem[]) => void;
}

export function RubricEditor({ rubric, onChange }: Props) {
  const { t } = useI18n();
  const total = rubric.reduce((s, r) => s + (Number(r.points) || 0), 0);

  function update(id: string, patch: Partial<RubricItem>) {
    onChange(rubric.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  return (
    <div>
      <div className="space-y-1.5">
        {rubric.map((r) => (
          <div key={r.id} className="flex items-center gap-1.5">
            <input
              value={r.label}
              onChange={(e) => update(r.id, { label: e.target.value })}
              placeholder={t("builder.rubric.criterionPlaceholder")}
              className="flex-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            <input
              type="number"
              value={r.points}
              min={0}
              step={0.5}
              onChange={(e) => update(r.id, { points: Number(e.target.value) })}
              className="w-16 rounded-md border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              title={t("builder.rubric.pointsTitle")}
            />
            <button
              type="button"
              onClick={() => onChange(rubric.filter((x) => x.id !== r.id))}
              className="p-1 text-neutral-300 dark:text-neutral-600 hover:text-red-600"
              aria-label={t("builder.rubric.removeCriterion")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onChange([...rubric, newRubricItem("", 1)])}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          <Plus className="w-3.5 h-3.5" /> {t("builder.rubric.addCriterion")}
        </button>
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
          {t("builder.rubric.total", { total })}
        </span>
      </div>
    </div>
  );
}
