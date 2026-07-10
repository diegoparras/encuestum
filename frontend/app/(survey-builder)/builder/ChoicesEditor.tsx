"use client";

import React, { useRef } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X, Plus } from "lucide-react";
import { Choice, newChoice } from "./model";

interface Props {
  choices: Choice[];
  onChange: (choices: Choice[]) => void;
}

export function ChoicesEditor({ choices, onChange }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const lastInputRef = useRef<HTMLInputElement | null>(null);

  function update(id: string, text: string) {
    onChange(choices.map((c) => (c.id === id ? { ...c, text } : c)));
  }
  function remove(id: string) {
    onChange(choices.filter((c) => c.id !== id));
  }
  function add() {
    onChange([...choices, newChoice(`Opción ${choices.length + 1}`)]);
    // Focus the new field on the next tick.
    requestAnimationFrame(() => lastInputRef.current?.focus());
  }
  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = choices.findIndex((c) => c.id === active.id);
    const newIndex = choices.findIndex((c) => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(choices, oldIndex, newIndex));
  }

  return (
    <div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={choices.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1.5">
            {choices.map((c, i) => (
              <ChoiceRow
                key={c.id}
                choice={c}
                inputRef={i === choices.length - 1 ? lastInputRef : undefined}
                onChange={(text) => update(c.id, text)}
                onRemove={() => remove(c.id)}
                onEnter={add}
                canRemove={choices.length > 1}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
      >
        <Plus className="w-3.5 h-3.5" /> Agregar opción
      </button>
    </div>
  );
}

function ChoiceRow({
  choice,
  onChange,
  onRemove,
  onEnter,
  canRemove,
  inputRef,
}: {
  choice: Choice;
  onChange: (text: string) => void;
  onRemove: () => void;
  onEnter: () => void;
  canRemove: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: choice.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1.5">
      <button
        type="button"
        className="shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 cursor-grab active:cursor-grabbing touch-none"
        {...attributes}
        {...listeners}
        aria-label="Reordenar opción"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <input
        ref={inputRef}
        value={choice.text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        className="flex-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="shrink-0 p-1 text-neutral-300 dark:text-neutral-600 hover:text-red-600 disabled:opacity-30 disabled:hover:text-neutral-300 dark:disabled:hover:text-neutral-600"
        aria-label="Quitar opción"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
