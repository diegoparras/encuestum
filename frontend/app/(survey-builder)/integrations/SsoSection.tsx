"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Fingerprint, Loader2, Trash2 } from "lucide-react";
import { ecosystemApi, type SsoConfig } from "../ecosystemApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

/** Login con el proveedor de identidad de la organización (OIDC). */
export default function SsoSection() {
  const { t } = useI18n();
  // Sin permiso (no es admin) el pedido falla y la sección no se muestra.
  const { data, setData } = useAsyncData(() => ecosystemApi.sso(), []);
  const [form, setForm] = useState<Partial<SsoConfig> & { client_secret?: string; dominios?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  if (!data) return null;

  const f = form ?? { ...data, dominios: (data.domains ?? []).join(", "), client_secret: "" };
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await ecosystemApi.saveSso({
        issuer: (f.issuer ?? "").trim(), client_id: (f.client_id ?? "").trim(),
        client_secret: f.client_secret?.trim() || undefined,
        domains: (f.dominios ?? "").split(/[,\s]+/).filter(Boolean),
        enabled: f.enabled ?? true, auto_provision: f.auto_provision ?? true,
        default_role: f.default_role ?? "member", enforce: !!f.enforce,
      });
      setData(r);
      setForm(null);
      toast.success(t("integrations.sso.saved"));
    } catch (err) {
      toast.error((err as Error)?.message || t("integrations.sso.error"));
    } finally {
      setSaving(false);
    }
  }

  async function quitar() {
    if (!window.confirm(t("integrations.sso.confirmRemove"))) return;
    await ecosystemApi.deleteSso().catch(() => {});
    setData({ configured: false, redirect_uri: data!.redirect_uri });
    setForm(null);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Fingerprint className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
        <CardTitle>{t("integrations.sso.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("integrations.sso.intro")}</p>
        <div className="rounded-lg bg-neutral-50 p-3 text-xs dark:bg-neutral-800/50">
          <div className="mb-1 font-medium text-neutral-600 dark:text-neutral-300">{t("integrations.sso.redirect")}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-neutral-700 dark:text-neutral-200">{data.redirect_uri}</code>
            <button
              type="button"
              aria-label={t("surveys.copy")}
              onClick={() => navigator.clipboard?.writeText(data.redirect_uri).then(() => toast.success(t("surveys.copied")))}
              className="text-neutral-400 hover:text-neutral-800"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
        <form onSubmit={guardar} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ssoIssuer">{t("integrations.sso.issuer")}</Label>
            <Input id="ssoIssuer" required value={f.issuer ?? ""} onChange={(e) => set({ issuer: e.target.value })}
              placeholder="https://accounts.google.com · https://login.microsoftonline.com/<tenant>/v2.0" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ssoClient">{t("integrations.sso.clientId")}</Label>
            <Input id="ssoClient" required value={f.client_id ?? ""} onChange={(e) => set({ client_id: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ssoSecret">{t("integrations.sso.clientSecret")}</Label>
            <Input id="ssoSecret" type="password" value={f.client_secret ?? ""} onChange={(e) => set({ client_secret: e.target.value })}
              placeholder={data.client_secret_set ? `${t("integrations.sso.secretKept")} ${data.client_secret_hint ?? ""}` : ""} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ssoDomains">{t("integrations.sso.domains")}</Label>
            <Input id="ssoDomains" required value={f.dominios ?? ""} onChange={(e) => set({ dominios: e.target.value })} placeholder="escuela.edu, alumnos.escuela.edu" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ssoRole">{t("integrations.sso.defaultRole")}</Label>
            <Select id="ssoRole" value={f.default_role ?? "member"} onChange={(e) => set({ default_role: e.target.value as "member" | "viewer" })}>
              <option value="member">{t("members.role.member")}</option>
              <option value="viewer">{t("members.role.viewer")}</option>
            </Select>
          </div>
          <div className="space-y-2 pt-6 text-sm text-neutral-700 dark:text-neutral-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.auto_provision ?? true} onChange={(e) => set({ auto_provision: e.target.checked })} />
              {t("integrations.sso.autoProvision")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!f.enforce} onChange={(e) => set({ enforce: e.target.checked })} />
              {t("integrations.sso.enforce")}
            </label>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("integrations.sso.save")}
            </Button>
            {data.configured && (
              <Button type="button" variant="outline" onClick={quitar}>
                <Trash2 className="h-4 w-4" /> {t("integrations.sso.remove")}
              </Button>
            )}
          </div>
        </form>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("integrations.sso.hint")}</p>
      </CardContent>
    </Card>
  );
}
