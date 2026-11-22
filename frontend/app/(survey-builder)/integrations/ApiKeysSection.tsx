"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BookOpen, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { ecosystemApi, type ApiKey } from "../ecosystemApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

function cuando(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Claves de la API pública. La clave completa se ve UNA vez, al crearla. */
export default function ApiKeysSection() {
  const { t } = useI18n();
  const { data: keys, setData, status } = useAsyncData(() => ecosystemApi.listKeys(), []);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [creating, setCreating] = useState(false);
  const [nueva, setNueva] = useState<ApiKey | null>(null);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const k = await ecosystemApi.createKey(name.trim(), scope);
      setNueva(k);
      setName("");
      setData((cur) => [{ ...k, key: undefined }, ...(cur ?? [])]);
    } catch (err) {
      toast.error((err as Error)?.message || t("integrations.api.error"));
    } finally {
      setCreating(false);
    }
  }

  async function revocar(k: ApiKey) {
    if (!window.confirm(t("integrations.api.confirmRevoke", { name: k.name }))) return;
    try {
      await ecosystemApi.revokeKey(k.id);
      setData((cur) => (cur ?? []).map((x) => (x.id === k.id ? { ...x, revoked_at: new Date().toISOString() } : x)));
    } catch (err) {
      toast.error((err as Error)?.message || t("integrations.api.error"));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <KeyRound className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
        <CardTitle>{t("integrations.api.title")}</CardTitle>
        <a
          href={ecosystemApi.docsUrl()}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <BookOpen className="h-3.5 w-3.5" /> {t("integrations.api.docs")}
        </a>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("integrations.api.intro")}</p>
        <form onSubmit={crear} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="apiKeyName">{t("integrations.api.name")}</Label>
            <Input id="apiKeyName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Power BI" />
          </div>
          <div className="space-y-1.5 sm:w-56">
            <Label htmlFor="apiKeyScope">{t("integrations.api.scope")}</Label>
            <Select id="apiKeyScope" value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
              <option value="read">{t("integrations.api.scope.read")}</option>
              <option value="write">{t("integrations.api.scope.write")}</option>
            </Select>
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("integrations.api.create")}
          </Button>
        </form>

        {nueva?.key && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
            <p className="font-medium text-amber-800 dark:text-amber-200">{t("integrations.api.copyNow")}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs dark:bg-neutral-900 dark:text-neutral-200">
                {nueva.key}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigator.clipboard?.writeText(nueva.key!).then(() => toast.success(t("surveys.copied")))}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="mt-2 font-mono text-[11px] text-amber-700 dark:text-amber-300">
              curl -H &quot;Authorization: Bearer {nueva.key.slice(0, 16)}…&quot; {ecosystemApi.apiBase()}/surveys
            </p>
          </div>
        )}

        {status === "ready" && keys && keys.length > 0 && (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className={`font-medium ${k.revoked_at ? "text-neutral-400 line-through" : "text-neutral-800 dark:text-neutral-200"}`}>
                  {k.name}
                </span>
                <code className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{k.prefix}</code>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {t(`integrations.api.scope.${k.scope}`)}
                </span>
                <span className="text-xs text-neutral-400 dark:text-neutral-500">
                  {k.revoked_at
                    ? t("integrations.api.revoked", { when: cuando(k.revoked_at) })
                    : t("integrations.api.lastUsed", { when: cuando(k.last_used_at) })}
                </span>
                {!k.revoked_at && (
                  <button
                    onClick={() => revocar(k)}
                    className="ml-auto text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                    aria-label={t("integrations.api.revoke")}
                    title={t("integrations.api.revoke")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
