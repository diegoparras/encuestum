"use client";

import React, { useEffect, useRef, useState } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { Check, Pipette } from "lucide-react";
import { ACCENT_PALETTE, readableForeground } from "./model";

interface Props {
  value: string;
  onChange: (color: string) => void;
}

export function AccentPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const isCustom = !ACCENT_PALETTE.some(
    (c) => c.value.toLowerCase() === value.toLowerCase()
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white pl-1.5 pr-2.5 py-1.5 hover:border-neutral-300 transition-colors"
        title="Color de la encuesta"
      >
        <span
          className="w-6 h-6 rounded-md ring-1 ring-black/5"
          style={{ backgroundColor: value }}
        />
        <span className="text-xs font-medium text-neutral-600">Color</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-neutral-200 bg-white p-3 shadow-xl">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 mb-2">
            Paleta Escriba
          </div>
          <div className="grid grid-cols-5 gap-2 mb-3">
            {ACCENT_PALETTE.map((c) => {
              const active = c.value.toLowerCase() === value.toLowerCase();
              return (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  onClick={() => onChange(c.value)}
                  className="relative aspect-square rounded-lg ring-1 ring-black/5 transition-transform hover:scale-105"
                  style={{ backgroundColor: c.value }}
                >
                  {active && (
                    <Check
                      className="w-4 h-4 absolute inset-0 m-auto"
                      style={{ color: readableForeground(c.value) }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 mb-2">
            <Pipette className="w-3.5 h-3.5" /> Personalizado
            {isCustom && <span className="ml-auto normal-case text-neutral-400">activo</span>}
          </div>
          <HexColorPicker
            color={value}
            onChange={onChange}
            style={{ width: "100%", height: 120 }}
          />
          <div className="mt-2 flex items-center gap-2">
            <span
              className="w-7 h-7 rounded-md ring-1 ring-black/5 shrink-0"
              style={{ backgroundColor: value }}
            />
            <HexColorInput
              color={value}
              onChange={onChange}
              prefixed
              className="w-full rounded-md border border-neutral-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-neutral-400"
            />
          </div>
        </div>
      )}
    </div>
  );
}
