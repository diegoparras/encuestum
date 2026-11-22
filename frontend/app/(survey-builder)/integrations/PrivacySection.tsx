"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Search, ShieldCheck, Trash2 } from "lucide-react";
import { ecosystemApi, type PersonFound } from "../ecosystemApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

const DIAS = [0, 30, 90, 180, 365, 730];

/** Privacidad de la organización: retención por defecto y derechos de cada
 *  persona (ver, exportar, borrar o anonimizar lo que hay de un email). */
export default function PrivacySection() {
  const { t } = useI18n();
  const { data: cfg, setData } = useAsyncData(() => ecosystemApi.privacySettings(), []);
  const [email, setEmail] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [found, setFound] = useState<PersonFound | null>(null);
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"delete" | "anonymize">("delete");
  const [borrando, setBorrando] = useState(false);

  async function guardarRetencion(days: number, action: "anonymize" | "delete") {
    try {
      const r = await ecosystemApi.setPrivacySettings(days, action);
      setData(r as typeof cfg & object);
      toast.success(t("integrations.privacy.saved"));
    } catch (e) {
      toast.error((e as Error)?.message || t("integrations.privacy.error"));
    }
  }

  async function buscar(e: React.FormEvent) {
    e.preventDefault();
    setBuscando(true);
    setFound(null);
    setConfirm("");
    try {
      setFound(await ecosystemApi.findPerson(email.trim()));
    } catch (err) {
      toast.error((err as Error)?.message || t("integrations.privacy.error"));
    } finally {
      setBuscando(false);
    }
  }

  async function borrar() {
    if (!found) return;
    setBorrando(true);
    try {
      const r = await ecosystemApi.erasePerson(found.email, confirm, mode);
      toast.success(t("integrations.privacy.erased", { n: r.responses }));
      setFound(await ecosystemApi.findPerson(found.email));
      setConfirm("");
    } catch (err) {
      toast.error((err as Error)?.message || t("integrations.privacy.error"));
    } finally {
      setBorrando(false);
    }
  }

  const dias = cfg?.retention_days ?? 0;
  const accion = (cfg?.retention_action ?? "anonymize") as "anonymize" | "delete";
  const vacio = found && found.responses + found.invitations + found.drafts === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
        <CardTitle>{t("integrations.privacy.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <Label>{t("integrations.privacy.retention")}</Label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Select
              aria-label={t("integrations.privacy.retention")}
              value={dias}
              onChange={(e) => guardarRetencion(Number(e.target.value), accion)}
              className="sm:w-56"
            >
              {[...new Set([...DIAS, dias])].sort((a, b) => a - b).map((d) => (
                <option key={d} value={d}>{d ? t("builder.privacy.days", { n: d }) : t("builder.privacy.keep")}</option>
              ))}
            </Select>
            {dias > 0 && (
              <Select
                aria-label={t("integrations.privacy.action")}
                value={accion}
                onChange={(e) => guardarRetencion(dias, e.target.value as "anonymize" | "delete")}
                className="sm:w-48"
              >
                <option value="anonymize">{t("builder.privacy.anonymize")}</option>
                <option value="delete">{t("builder.privacy.delete")}</option>
              </Select>
            )}
          </div>
          <p className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">{t("integrations.privacy.retentionHint")}</p>
        </div>

        <div className="border-t border-neutral-100 pt-5 dark:border-neutral-800">
          <Label htmlFor="personEmail">{t("integrations.privacy.person")}</Label>
          <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">{t("integrations.privacy.personHint")}</p>
          <form onSubmit={buscar} className="flex gap-2">
            <Input
              id="personEmail"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="persona@ejemplo.com"
            />
            <Button type="submit" variant="outline" disabled={buscando}>
              {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {t("integrations.privacy.search")}
            </Button>
          </form>

          {found && (
            <div className="mt-3 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              <p className="text-neutral-700 dark:text-neutral-300">
                {vacio
                  ? t("integrations.privacy.nothing")
                  : t("integrations.privacy.foundSummary", {
                      r: found.responses, i: found.invitations, d: found.drafts, s: found.surveys.length,
                    })}
              </p>
              {found.surveys.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-neutral-500 dark:text-neutral-400">
                  {found.surveys.map((s) => (
                    <li key={s.survey_id}>
                      {s.title || t("integrations.untitled")} — {t("integrations.privacy.surveyLine", { n: s.responses })}
                      {s.invited ? ` · ${t("integrations.privacy.invited")}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {!vacio && (
                <div className="mt-3 space-y-3">
                  <a
                    href={ecosystemApi.exportPersonUrl(found.email)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    <Download className="h-4 w-4" /> {t("integrations.privacy.export")}
                  </a>
                  <div className="rounded-lg bg-red-50 p-3 dark:bg-red-950/30">
                    <p className="text-xs text-red-700 dark:text-red-300">{t("integrations.privacy.eraseWarn")}</p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <Select value={mode} onChange={(e) => setMode(e.target.value as "delete" | "anonymize")} className="sm:w-56">
                        <option value="delete">{t("integrations.privacy.mode.delete")}</option>
                        <option value="anonymize">{t("integrations.privacy.mode.anonymize")}</option>
                      </Select>
                      <Input
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder={t("integrations.privacy.confirmPlaceholder")}
                        aria-label={t("integrations.privacy.confirmPlaceholder")}
                      />
                      <Button
                        type="button"
                        variant="danger"
                        disabled={borrando || confirm.trim().toLowerCase() !== found.email}
                        onClick={borrar}
                      >
                        {borrando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        {t("integrations.privacy.erase")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
