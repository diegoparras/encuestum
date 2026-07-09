"use client";

import { useCallback, useEffect, useState } from "react";
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
import { getMe, type Me } from "@/utils/auth";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  testWebhook,
  type Webhook,
} from "@/utils/webhooks";
import { surveyApi, type SurveySummary } from "../surveyApi";
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
  const [me, setMe] = useState<Me | null>(null);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [surveys, setSurveys] = useState<SurveySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-webhook form
  const [newUrl, setNewUrl] = useState("");
  const [newSurveyId, setNewSurveyId] = useState("");
  const [adding, setAdding] = useState(false);

  // Per-row UI state
  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const activeOrg = me?.orgs.find((o) => o.id === me.active_org_id) ?? me?.orgs[0];

  const surveyTitle = useCallback(
    (id: string): string => {
      const s = surveys.find((x) => x.id === id);
      return s?.title?.trim() || "(sin título)";
    },
    [surveys]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const meData = await getMe();
      if (!meData) {
        setError("Tu sesión expiró.");
        return;
      }
      setMe(meData);
      const list = await listWebhooks(meData.active_org_id);
      setWebhooks(list);
      // El selector de encuesta es opcional; si falla no rompemos la página.
      try {
        setSurveys(await surveyApi.list());
      } catch {
        setSurveys([]);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudieron cargar los webhooks"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    const url = newUrl.trim();
    if (!isHttpUrl(url)) {
      toast.error("La URL debe empezar con http:// o https://");
      return;
    }
    setAdding(true);
    try {
      const webhook = await createWebhook(
        me.active_org_id,
        url,
        newSurveyId || undefined
      );
      setWebhooks((prev) => (prev ? [webhook, ...prev] : [webhook]));
      setNewUrl("");
      setNewSurveyId("");
      toast.success("Webhook agregado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo agregar el webhook");
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
        toast.success("Enviado ✓");
      } else {
        toast.error("Falló: la URL no respondió correctamente");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo probar el webhook");
    } finally {
      setTesting(null);
    }
  }

  async function onDelete(webhook: Webhook) {
    if (!me) return;
    if (!window.confirm(`¿Eliminar el webhook hacia ${webhook.url}?`)) return;
    setDeleting(webhook.id);
    try {
      await deleteWebhook(me.active_org_id, webhook.id);
      setWebhooks((prev) => (prev ? prev.filter((w) => w.id !== webhook.id) : prev));
      toast.success("Webhook eliminado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo eliminar el webhook");
    } finally {
      setDeleting(null);
    }
  }

  async function onCopySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Secreto copiado");
    } catch {
      toast.error("No se pudo copiar el secreto");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-neutral-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-red-600">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => void load()}>
            Reintentar
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
          Integraciones
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Mandá cada respuesta en tiempo real a Zapier, Make, Google Sheets o tu
          propia URL desde{" "}
          <span className="font-medium text-neutral-700">{activeOrg?.name}</span>.
        </p>
      </div>

      {/* Add webhook */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Plus className="h-5 w-5 text-neutral-400" />
          <CardTitle>Agregar webhook</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAdd} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="webhookUrl">URL de destino</Label>
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
              <Label htmlFor="webhookSurvey">Alcance</Label>
              <Select
                id="webhookSurvey"
                value={newSurveyId}
                onChange={(e) => setNewSurveyId(e.target.value)}
              >
                <option value="">Todas las encuestas</option>
                {surveys.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title?.trim() || "(sin título)"}
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
              Agregar webhook
            </Button>
          </form>
          <p className="mt-2 text-xs text-neutral-400">
            Elegí una encuesta específica o dejá &quot;Todas las encuestas&quot; para
            enviar las respuestas de toda la organización.
          </p>
        </CardContent>
      </Card>

      {/* Webhooks list */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <WebhookIcon className="h-5 w-5 text-neutral-400" />
          <CardTitle>Webhooks configurados</CardTitle>
        </CardHeader>
        <CardContent>
          {webhooks && webhooks.length > 0 ? (
            <ul className="divide-y divide-neutral-100">
              {webhooks.map((w) => {
                const isTesting = testing === w.id;
                const isDeleting = deleting === w.id;
                const show = revealed[w.id] ?? false;
                return (
                  <li key={w.id} className="flex flex-col gap-3 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-neutral-900">{w.url}</p>
                        <p className="mt-0.5 text-xs text-neutral-400">
                          {w.survey_id ? (
                            <>Encuesta: {surveyTitle(w.survey_id)}</>
                          ) : (
                            <>Todas las encuestas</>
                          )}{" "}
                          · Creado el {formatDate(w.created_at)}
                          {!w.active && " · Inactivo"}
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
                          Probar
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
                          {show ? "Ocultar secreto" : "Ver secreto"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isDeleting}
                          onClick={() => onDelete(w)}
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                          Eliminar
                        </Button>
                      </div>
                    </div>

                    {show && (
                      <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                        <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700">
                          {w.secret}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onCopySecret(w.secret)}
                        >
                          <Copy className="h-4 w-4" />
                          Copiar
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="py-10 text-center">
              <WebhookIcon className="mx-auto h-8 w-8 text-neutral-300" />
              <p className="mt-3 text-sm text-neutral-400">
                Todavía no configuraste ningún webhook. Agregá uno arriba para
                empezar a recibir las respuestas.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Help block */}
      <Card>
        <CardContent className="flex items-start gap-3 py-5">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400" />
          <div className="space-y-1 text-sm text-neutral-600">
            <p>
              Cada respuesta se envía con los headers{" "}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs">
                X-Encuestum-Event
              </code>{" "}
              y{" "}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs">
                X-Encuestum-Signature
              </code>
              .
            </p>
            <p className="text-neutral-500">
              Verificá la autenticidad con el header{" "}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs">
                X-Encuestum-Signature
              </code>{" "}
              (HMAC-SHA256 del cuerpo con tu secreto).
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
