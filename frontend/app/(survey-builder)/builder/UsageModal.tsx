"use client";

import React from "react";
import { X, Sparkles } from "lucide-react";
import type { UsageInfo } from "../aiApi";

interface Props {
  usage: UsageInfo;
  onClose: () => void;
}

// Muestra prolijo el consumo de una llamada a la IA (modelo, tokens y costo).
export function UsageModal({ usage, onClose }: Props) {
  const hasCost = usage.cost_usd !== null && usage.cost_usd !== undefined;

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" style={{ color: "#8faf0e" }} />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Consumo de IA
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Modelo</p>
            <p className="mt-0.5 break-words font-mono text-sm text-neutral-900 dark:text-neutral-100">
              {usage.model || "—"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <TokenBox label="Prompt" value={usage.prompt_tokens} />
            <TokenBox label="Respuesta" value={usage.completion_tokens} />
            <TokenBox label="Total" value={usage.total_tokens} emphasis />
          </div>

          <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-center dark:border-neutral-800 dark:bg-neutral-950">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Costo estimado</p>
            <p className="mt-0.5 text-lg font-bold text-neutral-900 dark:text-neutral-100">
              {hasCost ? (
                <>≈ US$ {usage.cost_usd!.toFixed(4)}</>
              ) : (
                <span className="text-sm font-medium text-neutral-400 dark:text-neutral-500">
                  Sin precio configurado
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex justify-end border-t border-neutral-100 dark:border-neutral-800 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-[#1e2a06]"
            style={{ backgroundColor: "#8faf0e" }}
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenBox({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-2 py-2 ${
        emphasis
          ? "border-neutral-300 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      }`}
    >
      <div className="text-base font-bold text-neutral-900 dark:text-neutral-100">
        {value.toLocaleString("es")}
      </div>
      <div className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">{label}</div>
    </div>
  );
}
