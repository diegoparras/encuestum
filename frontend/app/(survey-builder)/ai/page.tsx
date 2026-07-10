"use client";

import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Sparkles,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  Search,
  X,
  Check,
  Globe,
  Building2,
  Activity,
  DollarSign,
  Star,
} from "lucide-react";
import { getMe } from "@/utils/auth";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import {
  aiApi,
  type Provider,
  type ProviderKind,
  type ProviderScope,
  type AiModel,
  type UsageReport,
  type PriceRow,
  type PricesReport,
  type CreateProviderInput,
  BASE_URL_DEFAULTS,
  KIND_LABEL,
  OPERATION_LABEL,
  formatCost,
} from "../aiApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const ACCENT = "#8faf0e";

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function modelOptionLabel(m: AiModel): string {
  const name = m.name || m.id;
  const parts: string[] = [];
  if (m.input_per_m !== null) parts.push(`entrada US$${m.input_per_m}`);
  if (m.output_per_m !== null) parts.push(`salida US$${m.output_per_m}`);
  return parts.length > 0 ? `${name} — ${parts.join(" / ")} (por 1M)` : name;
}

// ---------------------------------------------------------------------------
// Formulario de proveedor (crear o editar)
// ---------------------------------------------------------------------------

interface ProviderFormProps {
  isSuperadmin: boolean;
  provider?: Provider; // presente => modo edición
  onCancel: () => void;
  onSaved: (p: Provider) => void;
}

function ProviderForm({
  isSuperadmin,
  provider,
  onCancel,
  onSaved,
}: ProviderFormProps) {
  const editing = !!provider;
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "openai");
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(
    provider?.base_url ?? BASE_URL_DEFAULTS["openai"]
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(provider?.model ?? "");
  const [isDefault, setIsDefault] = useState(provider?.is_default ?? false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [scope, setScope] = useState<ProviderScope>(provider?.scope ?? "org");

  const [models, setModels] = useState<AiModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  function onKindChange(next: ProviderKind) {
    setKind(next);
    // Autocompleta base_url según el tipo (editable solo en custom).
    setBaseUrl(BASE_URL_DEFAULTS[next]);
    setModels([]);
  }

  async function onSearchModels() {
    setSearching(true);
    try {
      const res = editing
        ? await aiApi.providerModels(provider!.id)
        : await aiApi.listModels({
            kind,
            base_url: baseUrl || undefined,
            api_key: apiKey,
          });
      setModels(res.models);
      if (res.models.length === 0) {
        toast.info("No se encontraron modelos");
      } else {
        toast.success(`${res.models.length} modelo(s) encontrado(s)`);
        if (!model && res.models[0]) setModel(res.models[0].id);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudieron buscar los modelos"
      );
    } finally {
      setSearching(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Ingresá un nombre para el proveedor");
      return;
    }
    if (!model.trim()) {
      toast.error("Elegí o ingresá un modelo");
      return;
    }
    if (kind === "custom" && !baseUrl.trim()) {
      toast.error("El proveedor personalizado necesita una URL base");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const updated = await aiApi.updateProvider(provider!.id, {
          name: name.trim(),
          base_url: baseUrl.trim() || undefined,
          model: model.trim(),
          api_key: apiKey.trim() || undefined,
          is_default: isDefault,
          enabled,
        });
        toast.success("Proveedor actualizado");
        onSaved(updated);
      } else {
        if (!apiKey.trim()) {
          toast.error("Ingresá la API key");
          setSaving(false);
          return;
        }
        const body: CreateProviderInput = {
          scope: isSuperadmin ? scope : "org",
          name: name.trim(),
          kind,
          base_url: baseUrl.trim() || undefined,
          api_key: apiKey.trim(),
          model: model.trim(),
          is_default: isDefault,
        };
        const created = await aiApi.createProvider(body);
        toast.success("Proveedor agregado");
        onSaved(created);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo guardar el proveedor"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          {editing ? "Editar proveedor" : "Nuevo proveedor"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-neutral-400 hover:text-neutral-700"
          aria-label="Cerrar formulario"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="prov-kind">Proveedor</Label>
          <Select
            id="prov-kind"
            value={kind}
            disabled={editing}
            onChange={(e) => onKindChange(e.target.value as ProviderKind)}
          >
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Personalizado</option>
          </Select>
          {editing && (
            <p className="text-[11px] text-neutral-400">
              El tipo de proveedor no se puede cambiar.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="prov-name">Nombre</Label>
          <Input
            id="prov-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej. OpenAI producción"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="prov-baseurl">URL base</Label>
        <Input
          id="prov-baseurl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          disabled={kind !== "custom"}
          placeholder="https://…/v1"
        />
        {kind !== "custom" && (
          <p className="text-[11px] text-neutral-400">
            Se completa automáticamente según el proveedor.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="prov-key">
          API key {editing && <span className="text-neutral-400">(opcional)</span>}
        </Label>
        <Input
          id="prov-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            editing
              ? `Actual: ${provider!.key_hint || "•••"} — dejá vacío para conservarla`
              : "sk-…"
          }
        />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="prov-model">Modelo</Label>
          {models.length > 0 ? (
            <Select
              id="prov-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Elegí un modelo…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelOptionLabel(m)}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="prov-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Ej. gpt-4o-mini"
            />
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onSearchModels}
          disabled={searching || (!editing && !apiKey.trim())}
          title={
            !editing && !apiKey.trim()
              ? "Ingresá la API key para buscar modelos"
              : undefined
          }
        >
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Buscar modelos
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-4 w-4 rounded border-neutral-300 accent-[#8faf0e]"
          />
          Predeterminado
        </label>

        {editing && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            Habilitado
          </label>
        )}

        {!editing && isSuperadmin && (
          <div className="flex items-center gap-2 text-sm text-neutral-700">
            <span>Alcance:</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-neutral-300">
              <button
                type="button"
                onClick={() => setScope("org")}
                className={`px-3 py-1.5 text-xs font-medium ${
                  scope === "org"
                    ? "bg-neutral-900 text-white"
                    : "bg-white text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                Mi organización
              </button>
              <button
                type="button"
                onClick={() => setScope("global")}
                className={`px-3 py-1.5 text-xs font-medium ${
                  scope === "global"
                    ? "bg-neutral-900 text-white"
                    : "bg-white text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                Global (plataforma)
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {editing ? "Guardar cambios" : "Agregar proveedor"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Fila de proveedor
// ---------------------------------------------------------------------------

function ProviderRow({
  provider,
  onEdit,
  onDeleted,
}: {
  provider: Provider;
  onEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    if (!window.confirm(`¿Eliminar el proveedor "${provider.name}"?`)) return;
    setDeleting(true);
    try {
      await aiApi.deleteProvider(provider.id);
      toast.success("Proveedor eliminado");
      onDeleted(provider.id);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo eliminar el proveedor"
      );
      setDeleting(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-neutral-900">{provider.name}</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              provider.scope === "global"
                ? "bg-indigo-100 text-indigo-700"
                : "bg-neutral-100 text-neutral-600"
            }`}
          >
            {provider.scope === "global" ? (
              <Globe className="h-3 w-3" />
            ) : (
              <Building2 className="h-3 w-3" />
            )}
            {provider.scope === "global" ? "Global" : "Organización"}
          </span>
          {provider.is_default && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[#1e2a06]"
              style={{ backgroundColor: ACCENT }}
            >
              <Star className="h-3 w-3" /> Predeterminado
            </span>
          )}
          {!provider.enabled && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              Deshabilitado
            </span>
          )}
          {!provider.editable && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
              Solo lectura
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {KIND_LABEL[provider.kind]} · Modelo{" "}
          <span className="font-mono text-neutral-700">{provider.model}</span>
        </p>
        <p className="mt-0.5 text-xs text-neutral-400">
          {provider.base_url || "—"} · Key {provider.key_hint || "•••"}
        </p>
      </div>

      {provider.editable && (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" /> Editar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={onDelete}
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Eliminar
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sección Proveedores
// ---------------------------------------------------------------------------

function ProvidersSection({ isSuperadmin }: { isSuperadmin: boolean }) {
  const {
    data: providers,
    status,
    error,
    reload,
    setData: setProviders,
  } = useAsyncData(() => aiApi.listProviders(), []);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function onSaved(saved: Provider) {
    // Recargamos entero: marcar default puede afectar a otros proveedores.
    setShowForm(false);
    setEditingId(null);
    reload();
    void saved;
  }

  const editingProvider =
    editingId != null ? providers?.find((p) => p.id === editingId) : undefined;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-neutral-400" />
          <CardTitle>Proveedores de IA</CardTitle>
        </div>
        {!showForm && !editingId && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" /> Agregar proveedor
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && !editingId && (
          <ProviderForm
            isSuperadmin={isSuperadmin}
            onCancel={() => setShowForm(false)}
            onSaved={onSaved}
          />
        )}

        {status === "loading" ? (
          <LoadSpinner compact />
        ) : status === "error" ? (
          <LoadError message={error} onRetry={reload} compact />
        ) : providers && providers.length > 0 ? (
          <ul className="divide-y divide-neutral-100">
            {providers.map((p) =>
              editingId === p.id && editingProvider ? (
                <li key={p.id} className="py-4">
                  <ProviderForm
                    isSuperadmin={isSuperadmin}
                    provider={editingProvider}
                    onCancel={() => setEditingId(null)}
                    onSaved={onSaved}
                  />
                </li>
              ) : (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  onEdit={() => {
                    setShowForm(false);
                    setEditingId(p.id);
                  }}
                  onDeleted={(id) =>
                    setProviders((prev) =>
                      (prev ?? []).filter((x) => x.id !== id)
                    )
                  }
                />
              )
            )}
          </ul>
        ) : (
          providers && (
            <div className="py-8 text-center">
              <Sparkles className="mx-auto h-8 w-8 text-neutral-300" />
              <p className="mt-3 text-sm text-neutral-400">
                Todavía no hay proveedores de IA configurados. Agregá uno para
                empezar a generar y corregir con IA.
              </p>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sección Consumo
// ---------------------------------------------------------------------------

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4">
      <div className="text-2xl font-bold tracking-tight text-neutral-900">
        {value}
      </div>
      <div className="mt-1 text-xs text-neutral-500">{label}</div>
    </div>
  );
}

function UsageSection({ isSuperadmin }: { isSuperadmin: boolean }) {
  const [scope, setScope] = useState<ProviderScope>("org");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: ProviderScope) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await aiApi.usage(s, 50));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo cargar el consumo"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-neutral-400" />
          <CardTitle>Consumo</CardTitle>
        </div>
        {isSuperadmin && (
          <div className="inline-flex overflow-hidden rounded-lg border border-neutral-300">
            <button
              type="button"
              onClick={() => setScope("org")}
              className={`px-3 py-1.5 text-xs font-medium ${
                scope === "org"
                  ? "bg-neutral-900 text-white"
                  : "bg-white text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              Mi organización
            </button>
            <button
              type="button"
              onClick={() => setScope("global")}
              className={`px-3 py-1.5 text-xs font-medium ${
                scope === "global"
                  ? "bg-neutral-900 text-white"
                  : "bg-white text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              Global (plataforma)
            </button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-neutral-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center">
            <p className="text-sm text-red-600">{error}</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() => void load(scope)}
            >
              Reintentar
            </Button>
          </div>
        ) : report ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatBox
                label="Llamadas"
                value={report.totals.calls.toLocaleString("es")}
              />
              <StatBox
                label="Tokens totales"
                value={report.totals.total_tokens.toLocaleString("es")}
              />
              <StatBox
                label="Costo aproximado"
                value={
                  report.totals.total_cost_usd !== null
                    ? `≈ ${formatCost(report.totals.total_cost_usd)}`
                    : "—"
                }
              />
            </div>

            {report.recent.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                      <th className="pb-2 font-medium">Operación</th>
                      <th className="pb-2 font-medium">Modelo</th>
                      <th className="pb-2 font-medium">Tokens</th>
                      <th className="pb-2 font-medium">Costo</th>
                      <th className="pb-2 font-medium">Fecha</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {report.recent.map((r) => (
                      <tr key={r.id}>
                        <td className="py-3 pr-4 text-neutral-700">
                          {OPERATION_LABEL[r.operation] ?? r.operation}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-neutral-600">
                          {r.model}
                        </td>
                        <td className="py-3 pr-4 text-neutral-700">
                          {r.total_tokens.toLocaleString("es")}
                        </td>
                        <td className="py-3 pr-4 text-neutral-700">
                          {formatCost(r.cost_usd)}
                        </td>
                        <td className="py-3 text-neutral-500">
                          {formatDateTime(r.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-neutral-400">
                Todavía no hay consumo registrado.
              </p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sección Precios
// ---------------------------------------------------------------------------

interface PriceDraft {
  kind: ProviderKind;
  model: string;
  input_per_m: string;
  output_per_m: string;
}

const EMPTY_DRAFT: PriceDraft = {
  kind: "openai",
  model: "",
  input_per_m: "",
  output_per_m: "",
};

function PricesSection() {
  const [data, setData] = useState<PricesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await aiApi.prices());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudieron cargar los precios"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(row: PriceRow) {
    setDraft({
      kind: row.kind,
      model: row.model,
      input_per_m: String(row.input_per_m),
      output_per_m: String(row.output_per_m),
    });
  }

  async function onSave() {
    if (!draft) return;
    const input = Number(draft.input_per_m);
    const output = Number(draft.output_per_m);
    if (!draft.model.trim()) {
      toast.error("Ingresá el modelo");
      return;
    }
    if (Number.isNaN(input) || Number.isNaN(output)) {
      toast.error("Los precios deben ser números");
      return;
    }
    setSaving(true);
    try {
      await aiApi.putPrice({
        kind: draft.kind,
        model: draft.model.trim(),
        input_per_m: input,
        output_per_m: output,
      });
      toast.success("Precio guardado");
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo guardar el precio"
      );
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(row: PriceRow) {
    if (!row.id) return;
    if (!window.confirm(`¿Borrar el precio de ${row.model}?`)) return;
    setDeletingId(row.id);
    try {
      await aiApi.deletePrice(row.id);
      toast.success("Precio eliminado");
      await load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo eliminar el precio"
      );
    } finally {
      setDeletingId(null);
    }
  }

  const editable = data?.editable ?? false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-neutral-400" />
          <CardTitle>Precios</CardTitle>
        </div>
        {editable && !draft && (
          <Button size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <Plus className="h-4 w-4" /> Agregar precio
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-neutral-400">
          Precios en dólares por cada 1&nbsp;millón de tokens.
        </p>

        {draft && (
          <div className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 sm:grid-cols-5 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="price-kind">Tipo</Label>
              <Select
                id="price-kind"
                value={draft.kind}
                onChange={(e) =>
                  setDraft({ ...draft, kind: e.target.value as ProviderKind })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Personalizado</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="price-model">Modelo</Label>
              <Input
                id="price-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="gpt-4o-mini"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="price-in">Entrada / 1M</Label>
              <Input
                id="price-in"
                type="number"
                step="0.01"
                value={draft.input_per_m}
                onChange={(e) =>
                  setDraft({ ...draft, input_per_m: e.target.value })
                }
                placeholder="0.15"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="price-out">Salida / 1M</Label>
              <Input
                id="price-out"
                type="number"
                step="0.01"
                value={draft.output_per_m}
                onChange={(e) =>
                  setDraft({ ...draft, output_per_m: e.target.value })
                }
                placeholder="0.60"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={onSave} disabled={saving} className="flex-1">
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Guardar
              </Button>
              <Button variant="outline" onClick={() => setDraft(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-neutral-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center">
            <p className="text-sm text-red-600">{error}</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() => void load()}
            >
              Reintentar
            </Button>
          </div>
        ) : data && data.prices.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2 font-medium">Tipo</th>
                  <th className="pb-2 font-medium">Modelo</th>
                  <th className="pb-2 font-medium">Entrada / 1M</th>
                  <th className="pb-2 font-medium">Salida / 1M</th>
                  <th className="pb-2 font-medium">Origen</th>
                  {editable && <th className="pb-2 font-medium text-right">Acciones</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.prices.map((row, i) => (
                  <tr key={row.id ?? `${row.kind}-${row.model}-${i}`}>
                    <td className="py-3 pr-4 text-neutral-600">
                      {KIND_LABEL[row.kind]}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-neutral-700">
                      {row.model}
                    </td>
                    <td className="py-3 pr-4 text-neutral-700">
                      US$ {row.input_per_m}
                    </td>
                    <td className="py-3 pr-4 text-neutral-700">
                      US$ {row.output_per_m}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          row.source === "custom"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-neutral-100 text-neutral-500"
                        }`}
                      >
                        {row.source === "custom" ? "Personalizado" : "Por defecto"}
                      </span>
                    </td>
                    {editable && (
                      <td className="py-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(row)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {row.source === "custom" && row.id && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={deletingId === row.id}
                              onClick={() => onDelete(row)}
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                            >
                              {deletingId === row.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          data && (
            <p className="py-6 text-center text-sm text-neutral-400">
              No hay precios configurados.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function AiPage() {
  const { data: me, status, error, reload } = useAsyncData(async () => {
    const data = await getMe();
    if (!data) throw new Error("Tu sesión expiró.");
    return data;
  }, []);

  if (status === "loading") return <LoadSpinner />;
  if (status === "error" || !me) {
    return (
      <LoadError message={error ?? "No hay sesión."} onRetry={reload} />
    );
  }

  const isSuperadmin = me.user.is_superadmin;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">IA</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Configurá proveedores de inteligencia artificial, seguí el consumo y
          administrá los precios de los modelos.
        </p>
      </div>

      <ProvidersSection isSuperadmin={isSuperadmin} />
      <UsageSection isSuperadmin={isSuperadmin} />
      <PricesSection />
    </div>
  );
}
