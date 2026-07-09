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
        className="w-full max-w-sm rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" style={{ color: "#e25a4e" }} />
            <h2 className="text-sm font-semibold text-neutral-900">
              Consumo de IA
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs font-medium text-neutral-500">Modelo</p>
            <p className="mt-0.5 break-words font-mono text-sm text-neutral-900">
              {usage.model || "—"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <TokenBox label="Prompt" value={usage.prompt_tokens} />
            <TokenBox label="Respuesta" value={usage.completion_tokens} />
            <TokenBox label="Total" value={usage.total_tokens} emphasis />
          </div>

          <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-center">
            <p className="text-xs font-medium text-neutral-500">Costo estimado</p>
            <p className="mt-0.5 text-lg font-bold text-neutral-900">
              {hasCost ? (
                <>≈ US$ {usage.cost_usd!.toFixed(4)}</>
              ) : (
                <span className="text-sm font-medium text-neutral-400">
                  Sin precio configurado
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex justify-end border-t border-neutral-100 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: "#e25a4e" }}
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
          ? "border-neutral-300 bg-neutral-100"
          : "border-neutral-200 bg-white"
      }`}
    >
      <div className="text-base font-bold text-neutral-900">
        {value.toLocaleString("es")}
      </div>
      <div className="mt-0.5 text-[11px] text-neutral-500">{label}</div>
    </div>
  );
}
