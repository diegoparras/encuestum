"use client";

/**
 * Distribución avanzada: campos ocultos de la URL, cupos por grupo y link
 * público de resultados. Se guarda al toque (como el resto del panel).
 */

import React, { useEffect, useState } from "react";
import { Copy, Link2, Loader2, Plus, RefreshCw, Trash2, Users2, X } from "lucide-react";
import { toast } from "sonner";
import { surveyApi, type PublicResultsConfig, type Quota, type QuotaStatus } from "../surveyApi";
import { useI18n } from "@/lib/i18n";

type Pregunta = { name: string; title: string; choices: string[] };
type Choice = string | number | { value?: unknown; text?: unknown };
type Elemento = {
  name?: string; title?: string; type?: string; choices?: Choice[]; rateMin?: number; rateMax?: number;
};

function preguntasConOpciones(schema: { pages?: { elements?: Elemento[] }[] } | null | undefined): Pregunta[] {
  const out: Pregunta[] = [];
  for (const p of schema?.pages ?? []) {
    for (const el of p?.elements ?? []) {
      if (!el?.name) continue;
      let choices: string[] = [];
      if (Array.isArray(el.choices))
        choices = el.choices.map((c) => String(typeof c === "object" && c ? c.value ?? c.text : c));
      else if (el.type === "boolean") choices = ["true", "false"];
      else if (el.type === "rating") {
        const lo = Number(el.rateMin ?? 1), hi = Number(el.rateMax ?? 5);
        for (let i = lo; i <= hi && choices.length < 11; i++) choices.push(String(i));
      }
      if (choices.length) out.push({ name: el.name, title: String(el.title || el.name), choices });
    }
  }
  return out;
}

const INPUT =
  "w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";

export function DistributionSettings({ surveyId, slug }: { surveyId: string; slug?: string }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [nuevo, setNuevo] = useState("");
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [estado, setEstado] = useState<QuotaStatus[]>([]);
  const [preguntas, setPreguntas] = useState<Pregunta[]>([]);
  const [pub, setPub] = useState<PublicResultsConfig | null>(null);
  const [slugActual, setSlugActual] = useState(slug ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    surveyApi
      .get(surveyId, ctrl.signal)
      .then(async (s) => {
        setHidden(s.hidden_fields ?? []);
        setQuotas(s.quotas ?? []);
        setPub(s.public_results ?? null);
        setPreguntas(preguntasConOpciones(s.json_schema));
        setSlugActual(s.slug);
        if (s.quotas?.length) setEstado(await surveyApi.quotaStatus(surveyId).catch(() => []));
        setLoaded(true);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [surveyId]);

  async function guardar(patch: Parameters<typeof surveyApi.update>[1]) {
    setSaving(true);
    try {
      const s = await surveyApi.update(surveyId, patch);
      setHidden(s.hidden_fields ?? []);
      setQuotas(s.quotas ?? []);
      setPub(s.public_results ?? null);
      if (s.quotas?.length) setEstado(await surveyApi.quotaStatus(surveyId).catch(() => []));
      return true;
    } catch (e) {
      toast.error((e as Error)?.message || t("builder.dist.error"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  const origen = typeof window !== "undefined" ? window.location.origin : "";
  const ejemplo = hidden.length
    ? `${origen}/s/${slugActual}?${hidden.map((h) => `${h}=…`).join("&")}`
    : "";
  const linkPublico = pub?.token ? `${origen}/r/${pub.token}` : "";
  const opcionesCupo: Pregunta[] = [
    ...preguntas,
    ...hidden.map((h) => ({ name: `@${h}`, title: `@${h}`, choices: [] })),
  ];

  function agregarOculto() {
    const n = nuevo.trim();
    if (!n) return;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(n)) {
      toast.error(t("builder.dist.hiddenInvalid"));
      return;
    }
    if (hidden.includes(n)) return;
    guardar({ hidden_fields: [...hidden, n] }).then((ok) => ok && setNuevo(""));
  }

  function editarCupo(i: number, cambio: Partial<Quota>) {
    setQuotas((qs) => qs.map((q, j) => (j === i ? { ...q, ...cambio } : q)));
  }

  return (
    <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
      <div className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {t("builder.dist.title")}
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>

      {/* Campos ocultos */}
      <div className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{t("builder.dist.hidden")}</div>
      <p className="mb-1.5 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">{t("builder.dist.hiddenHint")}</p>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {hidden.map((h) => (
          <span key={h} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            {h}
            <button
              type="button"
              aria-label={t("builder.dist.removeHidden", { name: h })}
              onClick={() => guardar({ hidden_fields: hidden.filter((x) => x !== h) })}
              className="text-neutral-400 hover:text-red-600"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), agregarOculto())}
          placeholder={t("builder.dist.hiddenPlaceholder")}
          aria-label={t("builder.dist.hidden")}
          className={INPUT}
        />
        <button type="button" onClick={agregarOculto} className="rounded-md border border-neutral-200 px-2 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {ejemplo && <p className="mt-1 break-all font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{ejemplo}</p>}

      {/* Cupos */}
      <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">
        <Users2 className="h-3.5 w-3.5" /> {t("builder.dist.quotas")}
      </div>
      <p className="mb-1.5 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">{t("builder.dist.quotasHint")}</p>
      <div className="space-y-2">
        {quotas.map((q, i) => {
          const preg = opcionesCupo.find((p) => p.name === q.question);
          const st = estado.find((e) => e.question === q.question && e.values.join() === q.values.join());
          return (
            <div key={i} className="space-y-1.5 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
              <div className="flex gap-1.5">
                <select
                  value={q.question}
                  onChange={(e) => editarCupo(i, { question: e.target.value, values: [] })}
                  aria-label={t("builder.dist.quotaQuestion")}
                  className={INPUT}
                >
                  {opcionesCupo.map((p) => <option key={p.name} value={p.name}>{p.title}</option>)}
                </select>
                <button
                  type="button"
                  aria-label={t("builder.dist.removeQuota")}
                  onClick={() => guardar({ quotas: quotas.filter((_, j) => j !== i) })}
                  className="text-neutral-400 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {preg?.choices.length ? (
                <select
                  value={q.values[0] ?? ""}
                  onChange={(e) => editarCupo(i, { values: [e.target.value] })}
                  aria-label={t("builder.dist.quotaValue")}
                  className={INPUT}
                >
                  <option value="" disabled>{t("builder.dist.quotaValue")}</option>
                  {preg.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  value={q.values.join(", ")}
                  onChange={(e) => editarCupo(i, { values: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                  placeholder={t("builder.dist.quotaValue")}
                  aria-label={t("builder.dist.quotaValue")}
                  className={INPUT}
                />
              )}
              <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                {t("builder.dist.quotaLimit")}
                <input
                  type="number"
                  min={0}
                  value={q.limit}
                  onChange={(e) => editarCupo(i, { limit: Number(e.target.value) })}
                  aria-label={t("builder.dist.quotaLimit")}
                  className={`${INPUT} w-20`}
                />
                {st && (
                  <span className={st.full ? "font-medium text-red-600" : ""}>
                    {t("builder.dist.quotaUsed", { used: st.used, limit: st.limit })}
                  </span>
                )}
              </div>
              <input
                value={q.message ?? ""}
                onChange={(e) => editarCupo(i, { message: e.target.value })}
                placeholder={t("builder.dist.quotaMessage")}
                aria-label={t("builder.dist.quotaMessage")}
                className={INPUT}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={!opcionesCupo.length}
          onClick={() => setQuotas((qs) => [...qs, { question: opcionesCupo[0].name, values: [], limit: 50, message: "" }])}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
        >
          <Plus className="h-3.5 w-3.5" /> {t("builder.dist.addQuota")}
        </button>
        {quotas.length > 0 && (
          <button
            type="button"
            disabled={quotas.some((q) => !q.values.length)}
            onClick={() => guardar({ quotas }).then((ok) => ok && toast.success(t("builder.dist.quotasSaved")))}
            className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {t("builder.dist.saveQuotas")}
          </button>
        )}
      </div>

      {/* Resultados públicos */}
      <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
        <input
          id="pubResults"
          type="checkbox"
          checked={!!pub?.enabled}
          onChange={(e) => {
            const enabled = e.target.checked;
            setPub((p) => ({ token: "", show_text: false, min_responses: 5, ...p, enabled }));
            guardar({ public_results: { enabled } });
          }}
          className="mt-1"
        />
        <label htmlFor="pubResults" className="min-w-0">
          <span className="flex items-center gap-1 text-sm font-medium text-neutral-800 dark:text-neutral-200">
            <Link2 className="h-3.5 w-3.5" /> {t("builder.dist.public")}
          </span>
          <span className="block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">{t("builder.dist.publicHint")}</span>
        </label>
      </div>
      {pub?.enabled && (
        <div className="mt-2 space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5">
            <code className="flex-1 truncate rounded bg-neutral-100 px-2 py-1 font-mono text-[11px] dark:bg-neutral-800 dark:text-neutral-200">{linkPublico}</code>
            <button
              type="button"
              aria-label={t("surveys.copy")}
              onClick={() => navigator.clipboard?.writeText(linkPublico).then(() => toast.success(t("surveys.copied")))}
              className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              <Copy className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t("builder.dist.regenerate")}
              title={t("builder.dist.regenerate")}
              onClick={() => window.confirm(t("builder.dist.regenerateConfirm")) && guardar({ public_results: { enabled: true, regenerate: true } })}
              className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={pub.show_text}
              onChange={(e) => {
                const show_text = e.target.checked;
                setPub((p) => (p ? { ...p, show_text } : p));
                guardar({ public_results: { enabled: true, show_text } });
              }}
            />
            {t("builder.dist.showText")}
          </label>
          <label className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
            {t("builder.dist.minResponses")}
            <select
              value={pub.min_responses}
              onChange={(e) => guardar({ public_results: { enabled: true, min_responses: Number(e.target.value) } })}
              className="rounded border border-neutral-200 bg-white px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-800"
            >
              {[1, 3, 5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
