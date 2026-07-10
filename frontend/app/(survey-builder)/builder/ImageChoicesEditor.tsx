"use client";

import React from "react";
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
import { AssetPicker } from "./AssetPicker";

interface Props {
  choices: Choice[];
  onChange: (choices: Choice[]) => void;
}

/**
 * Choices editor for the "imagepicker" question type: each option has an image
 * thumbnail (AssetPicker, kind="image") plus a text label. Options can be
 * reordered by drag and removed.
 */
export function ImageChoicesEditor({ choices, onChange }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  function updateText(id: string, text: string) {
    onChange(choices.map((c) => (c.id === id ? { ...c, text } : c)));
  }
  function updateImage(id: string, imageUrl: string | undefined) {
    onChange(choices.map((c) => (c.id === id ? { ...c, imageUrl } : c)));
  }
  function remove(id: string) {
    onChange(choices.filter((c) => c.id !== id));
  }
  function add() {
    onChange([...choices, newChoice(`Opción ${choices.length + 1}`)]);
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
          <div className="space-y-2">
            {choices.map((c) => (
              <ImageChoiceRow
                key={c.id}
                choice={c}
                onText={(text) => updateText(c.id, text)}
                onImage={(url) => updateImage(c.id, url)}
                onRemove={() => remove(c.id)}
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

function ImageChoiceRow({
  choice,
  onText,
  onImage,
  onRemove,
  canRemove,
}: {
  choice: Choice;
  onText: (text: string) => void;
  onImage: (url: string | undefined) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: choice.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-start gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 p-2"
    >
      <button
        type="button"
        className="mt-2 shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 cursor-grab active:cursor-grabbing touch-none"
        {...attributes}
        {...listeners}
        aria-label="Reordenar opción"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <div className="w-24 shrink-0">
        <AssetPicker
          kind="image"
          value={choice.imageUrl}
          onChange={onImage}
        />
      </div>
      <input
        value={choice.text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Etiqueta (opcional)"
        className="mt-1.5 flex-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="mt-1.5 shrink-0 p-1 text-neutral-300 dark:text-neutral-600 hover:text-red-600 disabled:opacity-30 disabled:hover:text-neutral-300 dark:disabled:hover:text-neutral-600"
        aria-label="Quitar opción"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
