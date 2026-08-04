"use client";

import { useEffect, useState } from "react";
import { getApiUrl } from "@/utils/api";

type Survey = { id: string; title: string; slug: string; is_exam: boolean };

export default function LtiSelect() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Arranca en `true` (no en `!!dl`): en el primer render de cliente `dl`
  // todavía puede no estar leído (depende de `window`), y si el estado
  // arrancara en `false` el "No hay encuestas publicadas..." se mostraría
  // brevemente antes de que el efecto de abajo dispare el fetch.
  const [loading, setLoading] = useState(true);
  const dl = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("dl") ?? "";

  useEffect(() => {
    if (!dl) {
      setLoading(false);
      return;
    }
    fetch(getApiUrl(`/lti/select/surveys?dl=${encodeURIComponent(dl)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No se pudieron listar las encuestas."))))
      .then((d) => setSurveys(d.surveys))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [dl]);

  // El retorno de deep linking es un POST de formulario al LMS: se arma y se envía.
  async function choose(id: string) {
    setBusy(true);
    try {
      const r = await fetch(getApiUrl("/lti/select/return"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dl, survey_id: id }),
      });
      if (!r.ok) throw new Error("No se pudo confirmar la elección.");
      const { action, jwt } = await r.json();
      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "JWT";
      input.value = jwt;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado.");
      setBusy(false);
    }
  }

  if (error) {
    return (
      <main className="p-8">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Elegí una encuesta</h1>
      {loading ? (
        <p className="text-neutral-500 dark:text-neutral-400">Cargando encuestas…</p>
      ) : surveys.length === 0 ? (
        <p className="text-neutral-500 dark:text-neutral-400">No hay encuestas publicadas en esta organización.</p>
      ) : (
        <ul className="space-y-2">
          {surveys.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => choose(s.id)}
                className="w-full rounded-lg border p-4 text-left hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{s.title}</span>
                {s.is_exam && (
                  <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">examen · lleva nota</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
