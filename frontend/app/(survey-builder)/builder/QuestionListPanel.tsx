"use client";

import React from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  Type,
  AtSign,
  AlignLeft,
  CircleDot,
  CheckSquare,
  ChevronDownSquare,
  Star,
  ToggleLeft,
  Images,
  Video,
  Table,
  ListOrdered,
  Calendar,
  Paperclip,
  Plus,
  Rows3,
} from "lucide-react";
import { BuilderQuestion, QUESTION_TYPES, QuestionType } from "./model";
import { SortableQuestion } from "./SortableQuestion";

const PALETTE_ICON: Record<QuestionType, React.ComponentType<{ className?: string }>> = {
  text: Type,
  email: AtSign,
  comment: AlignLeft,
  radiogroup: CircleDot,
  checkbox: CheckSquare,
  dropdown: ChevronDownSquare,
  rating: Star,
  boolean: ToggleLeft,
  imagepicker: Images,
  videoresponse: Video,
  matrix: Table,
  ranking: ListOrdered,
  date: Calendar,
  fileupload: Paperclip,
  section: Rows3,
};

interface Props {
  questions: BuilderQuestion[];
  selectedId: string | null;
  accent: string;
  onAdd: (type: QuestionType) => void;
  onReorder: (questions: BuilderQuestion[]) => void;
  onSelect: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export function QuestionListPanel({
  questions,
  selectedId,
  accent,
  onAdd,
  onReorder,
  onSelect,
  onDuplicate,
  onDelete,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = questions.findIndex((q) => q.id === active.id);
    const newIndex = questions.findIndex((q) => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(questions, oldIndex, newIndex));
  }

  return (
    <div className="flex h-full flex-col">
      {/* Palette */}
      <div className="px-4 pt-4 pb-3 border-b border-neutral-200 dark:border-neutral-800">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-2">
          Añadir pregunta
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {QUESTION_TYPES.map((qt) => {
            const Icon = PALETTE_ICON[qt.type];
            return (
              <button
                key={qt.type}
                type="button"
                onClick={() => onAdd(qt.type)}
                className="group flex items-center gap-2 rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 px-2.5 py-2 text-left hover:border-neutral-300 dark:hover:border-neutral-700 hover:shadow-sm transition-all"
              >
                <span className="grid place-items-center w-7 h-7 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-700 dark:group-hover:text-neutral-300">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 truncate">
                    {qt.label}
                  </span>
                  <span className="block text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
                    {qt.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Question list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-2">
          Preguntas ({questions.length})
        </div>

        {questions.length === 0 ? (
          <button
            type="button"
            onClick={() => onAdd("text")}
            className="w-full rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 py-10 text-center text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
          >
            <Plus className="w-5 h-5 mx-auto mb-1" />
            Agregá tu primera pregunta
          </button>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={questions.map((q) => q.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-1.5">
                {questions.map((q, i) => (
                  <SortableQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    selected={q.id === selectedId}
                    accent={accent}
                    onSelect={() => onSelect(q.id)}
                    onDuplicate={() => onDuplicate(q.id)}
                    onDelete={() => onDelete(q.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
