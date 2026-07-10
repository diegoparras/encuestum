"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  Webhook as WebhookIcon,
} from "lucide-react";
import { getMe } from "@/utils/auth";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  testWebhook,
  type Webhook,
} from "@/utils/webhooks";
import { surveyApi, type SurveySummary } from "../surveyApi";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export default function IntegrationsPage() {
  const { t } = useI18n();
  const { data, status, error, reload, setData } = useAsyncData(async () => {
    const meData = await getMe();
    if (!meData) throw new Error(t("integrations.error.session"));
    const list = await listWebhooks(meData.active_org_id);
    // El selector de encuesta es opcional; si falla no rompemos la página.
    let surveys: SurveySummary[] = [];
    try {
      surveys = await surveyApi.list();
    } catch {
      surveys = [];
    }
    return { me: meData, webhooks: list, surveys };
  }, []);

  const me = data?.me ?? null;
  const webhooks = data?.webhooks ?? null;
  const surveys = data?.surveys ?? [];

  // Add-webhook form
  const [newUrl, setNewUrl] = useState("");
  const [newSurveyId, setNewSurveyId] = useState("");
  const [adding, setAdding] = useState(false);

  // Per-row UI state
  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const activeOrg = me?.orgs.find((o) => o.id === me.active_org_id) ?? me?.orgs[0];

  // Actualiza la lista de webhooks dentro del objeto cargado.
  const setWebhooks = useCallback(
    (updater: (prev: Webhook[]) => Webhook[]) => {
      setData((prev) =>
        prev ? { ...prev, webhooks: updater(prev.webhooks) } : prev!
      );
    },
    [setData]
  );

  const surveyTitle = useCallback(
    (id: string): string => {
      const s = surveys.find((x) => x.id === id);
      return s?.title?.trim() || t("integrations.untitled");
    },
    [surveys, t]
  );

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    const url = newUrl.trim();
    if (!isHttpUrl(url)) {
      toast.error(t("integrations.toast.urlInvalid"));
      return;
    }
    setAdding(true);
    try {
      const webhook = await createWebhook(
        me.active_org_id,
        url,
        newSurveyId || undefined
      );
      setWebhooks((prev) => [webhook, ...prev]);
      setNewUrl("");
      setNewSurveyId("");
      toast.success(t("integrations.toast.added"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("integrations.toast.addError"));
    } finally {
      setAdding(false);
    }
  }

  async function onTest(webhook: Webhook) {
    if (!me) return;
    setTesting(webhook.id);
    try {
      const result = await testWebhook(me.active_org_id, webhook.id);
      if (result.ok) {
        toast.success(t("integrations.toast.sent"));
      } else {
        toast.error(t("integrations.toast.testFailed"));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("integrations.toast.testError"));
    } finally {
      setTesting(null);
    }
  }

  async function onDelete(webhook: Webhook) {
    if (!me) return;
    if (!window.confirm(t("integrations.confirm.delete", { url: webhook.url }))) return;
    setDeleting(webhook.id);
    try {
      await deleteWebhook(me.active_org_id, webhook.id);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhook.id));
      toast.success(t("integrations.toast.deleted"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("integrations.toast.deleteError"));
    } finally {
      setDeleting(null);
    }
  }

  async function onCopySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t("integrations.toast.secretCopied"));
    } catch {
      toast.error(t("integrations.toast.secretCopyError"));
    }
  }

  if (status === "loading") return <LoadSpinner />;
  if (status === "error") return <LoadError message={error} onRetry={reload} />;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
          {t("integrations.title")}
        </h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("integrations.subtitle.prefix")}
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{activeOrg?.name}</span>
          {t("integrations.subtitle.suffix")}
        </p>
      </div>

      {/* Add webhook */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Plus className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>{t("integrations.add.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAdd} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="webhookUrl">{t("integrations.add.urlLabel")}</Label>
              <Input
                id="webhookUrl"
                type="url"
                required
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://hooks.zapier.com/…"
              />
            </div>
            <div className="space-y-1.5 sm:w-64">
              <Label htmlFor="webhookSurvey">{t("integrations.add.scopeLabel")}</Label>
              <Select
                id="webhookSurvey"
                value={newSurveyId}
                onChange={(e) => setNewSurveyId(e.target.value)}
              >
                <option value="">{t("integrations.allSurveys")}</option>
                {surveys.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title?.trim() || t("integrations.untitled")}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" disabled={adding}>
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t("integrations.add.submit")}
            </Button>
          </form>
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            {t("integrations.add.hint")}
          </p>
        </CardContent>
      </Card>

      {/* Webhooks list */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <WebhookIcon className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>{t("integrations.list.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {webhooks && webhooks.length > 0 ? (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {webhooks.map((w) => {
                const isTesting = testing === w.id;
                const isDeleting = deleting === w.id;
                const show = revealed[w.id] ?? false;
                return (
                  <li key={w.id} className="flex flex-col gap-3 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">{w.url}</p>
                        <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
                          {w.survey_id
                            ? t("integrations.list.survey", { title: surveyTitle(w.survey_id) })
                            : t("integrations.allSurveys")}{" "}
                          {t("integrations.list.created", { date: formatDate(w.created_at) })}
                          {!w.active && t("integrations.list.inactive")}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isTesting}
                          onClick={() => onTest(w)}
                        >
                          {isTesting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                          {t("integrations.list.test")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setRevealed((prev) => ({ ...prev, [w.id]: !show }))
                          }
                        >
                          {show ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                          {show ? t("integrations.list.hideSecret") : t("integrations.list.showSecret")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isDeleting}
                          onClick={() => onDelete(w)}
                          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
                        >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                          {t("integrations.list.delete")}
                        </Button>
                      </div>
                    </div>

                    {show && (
                      <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
                        <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
                          {w.secret}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onCopySecret(w.secret)}
                        >
                          <Copy className="h-4 w-4" />
                          {t("integrations.list.copy")}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="py-10 text-center">
              <WebhookIcon className="mx-auto h-8 w-8 text-neutral-300 dark:text-neutral-600" />
              <p className="mt-3 text-sm text-neutral-400 dark:text-neutral-500">
                {t("integrations.list.empty")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Help block */}
      <Card>
        <CardContent className="flex items-start gap-3 py-5">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400 dark:text-neutral-500" />
          <div className="space-y-1 text-sm text-neutral-600 dark:text-neutral-300">
            <p>
              {t("integrations.help.sentWith")}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800 dark:text-neutral-200">
                X-Encuestum-Event
              </code>
              {t("integrations.help.and")}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800 dark:text-neutral-200">
                X-Encuestum-Signature
              </code>
              {t("integrations.help.headersSuffix")}
            </p>
            <p className="text-neutral-500 dark:text-neutral-400">
              {t("integrations.help.verify")}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800 dark:text-neutral-200">
                X-Encuestum-Signature
              </code>
              {t("integrations.help.verifySuffix")}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
