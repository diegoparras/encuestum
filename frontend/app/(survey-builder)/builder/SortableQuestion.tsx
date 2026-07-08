"use client";

import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Copy,
  Trash2,
  Type,
  AtSign,
  AlignLeft,
  CircleDot,
  CheckSquare,
  ChevronDownSquare,
  Star,
  ToggleLeft,
} from "lucide-react";
import {
  BuilderQuestion,
  QUESTION_TYPE_LABEL,
  QuestionType,
  readableForeground,
} from "./model";

const ICON: Record<QuestionType, React.ComponentType<{ className?: string }>> = {
  text: Type,
  email: AtSign,
  comment: AlignLeft,
  radiogroup: CircleDot,
  checkbox: CheckSquare,
  dropdown: ChevronDownSquare,
  rating: Star,
  boolean: ToggleLeft,
};

interface Props {
  question: BuilderQuestion;
  index: number;
  selected: boolean;
  accent: string;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function SortableQuestion({
  question,
  index,
  selected,
  accent,
  onSelect,
  onDuplicate,
  onDelete,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: question.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const Icon = ICON[question.type];

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={`group relative flex items-center gap-2 rounded-lg border px-2 py-2 cursor-pointer transition-colors ${
        selected ? "bg-white shadow-sm border-neutral-200" : "bg-white/60 hover:bg-white border-neutral-200"
      }`}
    >
      <span
        className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full"
        style={{ backgroundColor: selected ? accent : "transparent" }}
        aria-hidden
      />
      <button
        type="button"
        className="shrink-0 text-neutral-300 hover:text-neutral-500 cursor-grab active:cursor-grabbing touch-none"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        aria-label="Reordenar"
      >
        <GripVertical className="w-4 h-4" />
      </button>

      <span
        className="shrink-0 grid place-items-center w-7 h-7 rounded-md text-[13px]"
        style={{
          backgroundColor: selected ? accent : "#f1f1f2",
          color: selected ? readableForeground(accent) : "#6b7280",
        }}
      >
        <Icon className="w-4 h-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-neutral-800 truncate">
          {index + 1}. {question.title || "(sin título)"}
        </div>
        <div className="text-[11px] text-neutral-400">
          {QUESTION_TYPE_LABEL[question.type]}
          {question.isRequired ? " · obligatoria" : ""}
        </div>
      </div>

      <div className="shrink-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
          className="p-1.5 text-neutral-400 hover:text-neutral-700"
          aria-label="Duplicar"
          title="Duplicar"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1.5 text-neutral-400 hover:text-red-600"
          aria-label="Eliminar"
          title="Eliminar"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
