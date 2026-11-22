"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Gauge, Loader2 } from "lucide-react";
import { ecosystemApi } from "../ecosystemApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** Tope mensual de gasto en IA: al 80% se avisa a los administradores y al
 *  100% se frenan la generación y la corrección hasta el mes siguiente. */
export default function BudgetSection() {
  const { t } = useI18n();
  const { data: b, setData } = useAsyncData(() => ecosystemApi.budget(), []);
  const [valor, setValor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!b) return null;

  const input = valor ?? (b.budget_usd != null ? String(b.budget_usd) : "");
  const pct = b.ratio != null ? Math.min(100, Math.round(b.ratio * 100)) : null;
  const color = b.blocked ? "#dc2626" : b.warn ? "#d97706" : "#8faf0e";

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const n = input.trim() === "" ? null : Number(input.replace(",", "."));
    if (n != null && (!Number.isFinite(n) || n < 0)) {
      toast.error(t("ai.budget.invalid"));
      return;
    }
    setSaving(true);
    try {
      setData(await ecosystemApi.setBudget(n));
      setValor(null);
      toast.success(t("ai.budget.saved"));
    } catch (err) {
      toast.error((err as Error)?.message || t("ai.budget.error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Gauge className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
        <CardTitle>{t("ai.budget.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">
              {t("ai.budget.spent", { month: b.month })}
            </span>
            <span className="font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
              USD {b.spent_usd.toFixed(2)}
              {b.budget_usd != null && (
                <span className="font-normal text-neutral-400"> / {b.budget_usd.toFixed(2)}</span>
              )}
            </span>
          </div>
          {pct != null && (
            <div className="mt-2 h-2 rounded-full bg-neutral-100 dark:bg-neutral-800" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("ai.budget.title")}>
              <div className="h-2 rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
          )}
          {b.blocked ? (
            <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{t("ai.budget.blocked")}</p>
          ) : b.warn ? (
            <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">{t("ai.budget.warn")}</p>
          ) : null}
        </div>
        <form onSubmit={guardar} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="space-y-1.5 sm:w-56">
            <Label htmlFor="aiBudget">{t("ai.budget.limit")}</Label>
            <Input
              id="aiBudget"
              inputMode="decimal"
              value={input}
              onChange={(e) => setValor(e.target.value)}
              placeholder={t("ai.budget.none")}
            />
          </div>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("ai.budget.save")}
          </Button>
        </form>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("ai.budget.hint")}</p>
      </CardContent>
    </Card>
  );
}
