"use client";

import { useEffect, useMemo, useState } from "react";
import { getApiUrl } from "@/utils/api";
import { useI18n } from "@/lib/i18n";

type Survey = {
  id: string;
  title: string;
  slug: string;
  is_exam: boolean;
  questions: number;
  updated_at: string;
};

/**
 * El selector de encuestas que se abre dentro del iframe de Moodle.
 *
 * Se llega acá por dos caminos y el que sea cambia lo que hace el botón de
 * confirmar:
 *
 *   - `?dl=<token>` — deep linking: la plataforma pidió un *content item*. La
 *     actividad todavía no existe del lado de Moodle; lo que se devuelve es un
 *     JWT firmado que el navegador postea de vuelta al LMS.
 *   - `?link=<token>` — un docente entró a una actividad que ya existe pero que
 *     nunca pasó por "Seleccionar contenido". Acá el vínculo se guarda de este
 *     lado y la respuesta es simplemente a dónde ir.
 *
 * Los dos tokens tienen propósitos distintos en el backend y no son
 * intercambiables (ver `_link_platform` en `app/routers/lti.py`), así que el
 * modo se decide por cuál de los dos llegó y no hay un caso mixto.
 */
export default function LtiSelect() {
  const { t, lang } = useI18n();
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Arranca en `true` (no en `!!dl`): los tokens se leen de `window` en un
  // efecto, así que en el primer render todavía no se sabe si hay sesión de
  // selección. Si el estado arrancara en `false`, el "No hay encuestas
  // publicadas…" parpadearía antes de que salga el fetch.
  const [loading, setLoading] = useState(true);
  // `null` mientras no se leyó la URL. Se hace en un efecto y no durante el
  // render porque este componente igual se renderiza en el servidor, donde no
  // hay `window`: leerlo ahí daría vacío y el primer render del cliente daría
  // otra cosa, que es exactamente una discrepancia de hidratación.
  const [tokens, setTokens] = useState<{ dl: string; link: string } | null>(null);
  const [filtro, setFiltro] = useState("");
  const [anonimo, setAnonimo] = useState(false);
  const [elegida, setElegida] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTokens({ dl: params.get("dl") ?? "", link: params.get("link") ?? "" });
  }, []);

  const dl = tokens?.dl ?? "";
  const link = tokens?.link ?? "";
  // El deep linking manda si por algún motivo llegaran los dos: es el flujo que
  // le debe una respuesta firmada a la plataforma, y dejarlo sin contestar
  // cuelga el diálogo de Moodle.
  const modo: "dl" | "link" | null = dl ? "dl" : link ? "link" : null;

  useEffect(() => {
    if (tokens === null) return;
    if (!modo) {
      setLoading(false);
      return;
    }
    const query = modo === "dl" ? `dl=${encodeURIComponent(dl)}` : `link=${encodeURIComponent(link)}`;
    fetch(getApiUrl(`/lti/select/surveys?${query}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("public.lti.error.list")))))
      .then((d) => setSurveys(d.surveys))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // `t` cambia con el idioma y no debe volver a disparar el pedido: sólo se
    // usa para el texto del error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, modo, dl, link]);

  const visibles = useMemo(() => {
    const aguja = filtro.trim().toLowerCase();
    if (!aguja) return surveys;
    return surveys.filter((s) => s.title.toLowerCase().includes(aguja));
  }, [surveys, filtro]);

  // Si lo elegido se cae del filtro, se deselecciona: confirmar algo que ya no
  // está en pantalla es la clase de error que después nadie puede explicar.
  useEffect(() => {
    if (elegida && !visibles.some((s) => s.id === elegida)) setElegida(null);
  }, [visibles, elegida]);

  const fecha = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(lang, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  /** Deep linking: el retorno es un POST de formulario al LMS, se arma y se envía. */
  async function confirmarDeepLink(id: string) {
    const r = await fetch(getApiUrl("/lti/select/return"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dl, survey_id: id }),
    });
    if (!r.ok) throw new Error(t("public.lti.error.choose"));
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
  }

  /** Vínculo: se guarda de este lado y se navega a donde diga el backend. */
  async function confirmarVinculo(id: string) {
    const r = await fetch(getApiUrl("/lti/select/link"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link, survey_id: id, anonymous: anonimo }),
    });
    if (!r.ok) throw new Error(t("public.lti.error.choose"));
    const { redirect } = await r.json();
    window.location.assign(redirect);
  }

  async function confirmar() {
    if (!elegida) return;
    setBusy(true);
    try {
      if (modo === "dl") await confirmarDeepLink(elegida);
      else await confirmarVinculo(elegida);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("public.lti.error.unexpected"));
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

  const aviso = !modo
    ? t("public.lti.noSession")
    : surveys.length === 0
      ? t("public.lti.empty")
      : visibles.length === 0
        ? t("public.lti.noMatches")
        : null;

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
        {t("public.lti.title")}
      </h1>

      {loading ? (
        <p className="text-neutral-500 dark:text-neutral-400">{t("public.lti.loading")}</p>
      ) : (
        <>
          {/* El buscador se muestra siempre que haya lista. Se evaluó
              esconderlo por debajo de N encuestas, pero un campo que aparece y
              desaparece según cuántas haya es más desconcertante que un campo
              de más. */}
          {surveys.length > 0 && (
            <input
              type="search"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              placeholder={t("public.lti.search")}
              aria-label={t("public.lti.search")}
              className="mb-4 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm
                         text-neutral-900 placeholder:text-neutral-400
                         focus:border-neutral-500 focus:outline-none
                         dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          )}

          {aviso ? (
            <p className="text-neutral-500 dark:text-neutral-400">{aviso}</p>
          ) : (
            <ul className="space-y-2">
              {/* Radios nativos con el mismo `name`: el agrupamiento y la
                  navegación con flechas los da el navegador, sin ARIA a mano. */}
              {visibles.map((s) => (
                <li key={s.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4
                                hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
                                  elegida === s.id
                                    ? "border-neutral-900 dark:border-neutral-100"
                                    : "border-neutral-300 dark:border-neutral-700"
                                }`}
                  >
                    <input
                      type="radio"
                      name="encuesta"
                      value={s.id}
                      checked={elegida === s.id}
                      disabled={busy}
                      onChange={() => setElegida(s.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-neutral-900 dark:text-neutral-100">
                        {s.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                        {/* `t()` no sabe pluralizar, y "1 preguntas" se ve en
                            toda encuesta de una sola pregunta. */}
                        {s.questions === 1
                          ? t("public.lti.questionsOne")
                          : t("public.lti.questions", { n: s.questions })}
                        {" · "}
                        {t("public.lti.updated", { date: fecha(s.updated_at) })}
                        {s.is_exam && <> {" · "}{t("public.lti.exam")}</>}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {/* El interruptor de anonimato SÓLO en modo `link`. En deep linking la
              actividad todavía no existe del lado de Moodle y es Moodle quien
              decide si acepta notas: ofrecer acá un interruptor que no hace
              nada sería peor que no ofrecerlo. */}
          {modo === "link" && !aviso && (
            <div className="mt-6 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={anonimo}
                  disabled={busy}
                  onChange={(e) => setAnonimo(e.target.checked)}
                  aria-describedby="ayuda-anonimo"
                />
                <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {t("public.lti.anonymous")}
                </span>
              </label>
              {/* Las tres consecuencias juntas y siempre visibles: activar el
                  anonimato y seguir esperando las notas en el LMS termina en un
                  silencio que el docente no puede diagnosticar. La tercera es
                  que el tope de intentos deja de aplicarse: sin identidad no
                  hay a quién contarle intentos, y el porqué está en
                  `backend/app/attempts.py`. */}
              <p
                id="ayuda-anonimo"
                className="mt-2 text-xs text-neutral-500 dark:text-neutral-400"
              >
                {t("public.lti.anonymousHelp")}
              </p>
            </div>
          )}

          {!aviso && (
            <button
              type="button"
              disabled={busy || !elegida}
              onClick={confirmar}
              className="mt-6 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium
                         text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {busy ? t("public.lti.confirming") : t("public.lti.confirm")}
            </button>
          )}
        </>
      )}
    </main>
  );
}
