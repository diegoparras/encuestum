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
  ChevronDown,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import { BuilderQuestion, QUESTION_TYPES, QuestionType } from "./model";
import { SortableQuestion } from "./SortableQuestion";
import { useI18n } from "@/lib/i18n";
import { useCollapsed } from "@/lib/useCollapsed";

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
  const { t } = useI18n();
  const [paletteClosed, togglePalette] = useCollapsed("builder.palette");
  const [q, setQ] = React.useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Buscar por nombre o descripción del tipo, sin acentos: con 15 tipos,
  // escribir "matriz" es más rápido que barrer la grilla con la vista.
  const sinAcentos = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const filtro = sinAcentos(q.trim());
  const tipos = filtro
    ? QUESTION_TYPES.filter((qt) =>
        sinAcentos(
          `${t(`builder.qtype.${qt.type}`)} ${t(`builder.qhint.${qt.type}`)}`
        ).includes(filtro)
      )
    : QUESTION_TYPES;

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
      {/* Paleta: plegable, porque 15 tipos se comen el panel y dejan la lista
          de preguntas apretada abajo. La elección se recuerda. */}
      <div className="px-4 pt-4 pb-3 border-b border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={togglePalette}
          aria-expanded={!paletteClosed}
          className="flex w-full items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          {paletteClosed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          {t("builder.list.addQuestion")}
          {paletteClosed && (
            <span className="ml-auto font-normal normal-case tracking-normal text-neutral-400">
              {QUESTION_TYPES.length}
            </span>
          )}
        </button>

        {!paletteClosed && (
          <>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("builder.list.searchType")}
                aria-label={t("builder.list.searchType")}
                className="w-full rounded-md border border-neutral-200 bg-white py-1.5 pl-7 pr-6 text-xs outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:focus:border-neutral-600"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ("")}
                  aria-label={t("builder.list.clearSearch")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {tipos.length === 0 && (
              <p className="py-3 text-center text-xs text-neutral-400">
                {t("builder.list.noTypeMatch")}
              </p>
            )}
          </>
        )}

        <div className={`grid grid-cols-2 gap-1.5 ${paletteClosed ? "hidden" : ""}`}>
          {tipos.map((qt) => {
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
                    {t(`builder.qtype.${qt.type}`)}
                  </span>
                  <span className="block text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
                    {t(`builder.qhint.${qt.type}`)}
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
          {t("builder.list.questions", { n: questions.length })}
        </div>

        {questions.length === 0 ? (
          <button
            type="button"
            onClick={() => onAdd("text")}
            className="w-full rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 py-10 text-center text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
          >
            <Plus className="w-5 h-5 mx-auto mb-1" />
            {t("builder.list.addFirst")}
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
