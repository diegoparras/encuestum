"use client";

/** Piezas de UI del panel de propiedades (secciones, campos, filas). */

import React from "react";
import { Switch } from "@/components/ui/switch";

import { useCollapsed } from "@/lib/useCollapsed";

import { ChevronDown, ChevronRight } from "lucide-react";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-4">
      {children}
    </div>
  );
}

/**
 * Sección plegable de ajustes. El panel apila varios bloques y casi nunca se
 * tocan todos a la vez; poder cerrar los que no se usan deja la pantalla
 * respirable. La elección se recuerda por `id`.
 */
export function Section({
  id,
  title,
  defaultCollapsed = false,
  children,
}: {
  id: string;
  title: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, toggle] = useCollapsed(`builder.props.${id}`, defaultCollapsed);
  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 mb-4 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
        {title}
      </button>
      {!collapsed && children}
    </>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}

export function SelectRow({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 mt-1">
      <div>
        <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</div>
        {hint && <div className="text-[11px] text-neutral-400 dark:text-neutral-500">{hint}</div>}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="shrink-0 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ToggleRow({
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
        <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</div>
        {hint && <div className="text-[11px] text-neutral-400 dark:text-neutral-500">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
