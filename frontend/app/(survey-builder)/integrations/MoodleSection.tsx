"use client";

// La sección de Moodle (LTI 1.3) de la página de Integraciones.
//
// Tres estados, y el orden en que se resuelven importa:
//   1. LTI apagado en el servidor  -> se explica qué variable definir.
//   2. Prendido y sin plataformas  -> botón que genera el link de registro.
//   3. Con plataformas conectadas  -> lista con filas desplegables.
//
// El estado 1 se resuelve con `ltiEnabled()` ANTES de tocar ningún `/lti/*`:
// con la bandera apagada esos endpoints devuelven 404 y sin el chequeo previo
// se vería un error de red donde debería haber una explicación.
//
// Lo que NO se muestra acá: `LtiUser` (sub, email y nombre de cada persona que
// entró desde el LMS) existe en la base incluso para lanzamientos anónimos.
// Ningún endpoint lo expone y esta pantalla tampoco lo pide ni lo cruza contra
// nada del vínculo: un vínculo marcado anónimo que dejara ver quién respondió
// rompería la promesa que el selector le hizo al docente.

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  GraduationCap,
  Link2,
  Loader2,
  Plus,
  Unplug,
} from "lucide-react";
import {
  createRegistrationUrl,
  disconnectPlatform,
  listLinks,
  listPlatforms,
  ltiEnabled,
  type LtiLink,
  type LtiPlatform,
} from "@/utils/lti";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// La palabra que hay que escribir para confirmar la desconexión. Es literal y
// no se traduce: el chequeo la compara tal cual, así que el texto que la pide
// la interpola en vez de reescribirla en cada idioma.
const PALABRA_CONFIRMACION = "aceptar";

// El dominio del LMS, que es lo que un administrador reconoce. El `issuer` es
// una URL completa; si alguna plataforma mandara algo que no parsea, se
// muestra crudo antes que nada.
function dominio(issuer: string): string {
  try {
    return new URL(issuer).host || issuer;
  } catch {
    return issuer;
  }
}

function useFecha() {
  const { lang } = useI18n();
  return useCallback(
    (iso: string): string => {
      try {
        return new Date(iso).toLocaleDateString(lang, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      } catch {
        return iso;
      }
    },
    [lang]
  );
}

export default function MoodleSection() {
  const { t } = useI18n();
  const fecha = useFecha();

  // Una sola carga: la bandera del servidor y, sólo si está prendida, las
  // plataformas. Con LTI apagado ni se intenta el listado (404 garantizado).
  const { data, status, error, reload, setData } = useAsyncData(async () => {
    const enabled = await ltiEnabled();
    if (!enabled) return { enabled: false, platforms: [] as LtiPlatform[] };
    return { enabled: true, platforms: await listPlatforms() };
  }, []);

  // Link de registro recién generado (no se persiste: vale 30 minutos).
  const [registro, setRegistro] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);

  // Detalle por plataforma, cargado la primera vez que se despliega la fila.
  const [abierta, setAbierta] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, LtiLink[]>>({});
  const [cargandoLinks, setCargandoLinks] = useState<string | null>(null);
  const [errorLinks, setErrorLinks] = useState<Record<string, string>>({});

  const [aDesconectar, setADesconectar] = useState<LtiPlatform | null>(null);

  async function onGenerar() {
    setGenerando(true);
    try {
      const { url } = await createRegistrationUrl();
      setRegistro(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("integrations.moodle.toast.linkError"));
    } finally {
      setGenerando(false);
    }
  }

  async function onCopiar(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("integrations.moodle.toast.linkCopied"));
    } catch {
      toast.error(t("integrations.moodle.toast.linkCopyError"));
    }
  }

  async function onDesplegar(p: LtiPlatform) {
    if (abierta === p.id) {
      setAbierta(null);
      return;
    }
    setAbierta(p.id);
    // Se pide una sola vez por plataforma; volver a plegar y desplegar no
    // vuelve a golpear el backend.
    if (links[p.id] || cargandoLinks === p.id) return;
    setCargandoLinks(p.id);
    setErrorLinks((prev) => {
      if (!(p.id in prev)) return prev;
      const resto = { ...prev };
      delete resto[p.id];
      return resto;
    });
    try {
      const filas = await listLinks(p.id);
      setLinks((prev) => ({ ...prev, [p.id]: filas }));
    } catch (err) {
      setErrorLinks((prev) => ({
        ...prev,
        [p.id]: err instanceof Error ? err.message : t("integrations.moodle.links.error"),
      }));
    } finally {
      setCargandoLinks(null);
    }
  }

  // Saca la plataforma de la lista sin recargar toda la página, igual que hace
  // el bloque de webhooks al borrar uno.
  const quitarPlataforma = useCallback(
    (id: string) => {
      setData((prev) =>
        prev ? { ...prev, platforms: prev.platforms.filter((p) => p.id !== id) } : prev!
      );
      setLinks((prev) => {
        if (!(id in prev)) return prev;
        const resto = { ...prev };
        delete resto[id];
        return resto;
      });
      setAbierta((prev) => (prev === id ? null : prev));
    },
    [setData]
  );

  const cabecera = (
    <CardHeader className="flex flex-row items-center gap-2">
      <GraduationCap className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
      <CardTitle>{t("integrations.moodle.title")}</CardTitle>
    </CardHeader>
  );

  if (status === "loading") {
    return (
      <Card>
        {cabecera}
        <CardContent>
          <LoadSpinner compact />
        </CardContent>
      </Card>
    );
  }

  if (status === "error") {
    return (
      <Card>
        {cabecera}
        <CardContent>
          <LoadError message={error} onRetry={reload} compact />
        </CardContent>
      </Card>
    );
  }

  // Estado 1: la integración está apagada en este servidor.
  if (!data?.enabled) {
    return (
      <Card>
        {cabecera}
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p>
              {t("integrations.moodle.disabled.prefix")}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800 dark:text-neutral-200">
                LTI_ENABLED=true
              </code>
              {t("integrations.moodle.disabled.suffix")}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const plataformas = data.platforms;

  return (
    <>
      <Card>
        {cabecera}
        <CardContent className="space-y-4">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t("integrations.moodle.subtitle")}
          </p>

          {plataformas.length === 0 ? (
            // Estado 2: prendido pero sin ningún LMS conectado.
            <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center dark:border-neutral-700">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {t("integrations.moodle.empty")}
              </p>
              <Button className="mt-4" disabled={generando} onClick={onGenerar}>
                {generando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {t("integrations.moodle.connect")}
              </Button>
            </div>
          ) : (
            // Estado 3: la lista de LMS conectados.
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {plataformas.map((p) => {
                const desplegada = abierta === p.id;
                return (
                  <li key={p.id} className="py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                          {p.name?.trim() || dominio(p.issuer)}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
                          {dominio(p.issuer)} ·{" "}
                          {t("integrations.moodle.list.connectedOn", { date: fecha(p.created_at) })}
                        </p>
                        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                          {t("integrations.moodle.list.activities", { count: p.activities })} ·{" "}
                          {t("integrations.moodle.list.responses", { count: p.responses })}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => onDesplegar(p)}>
                          {desplegada ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          {desplegada
                            ? t("integrations.moodle.list.hideDetail")
                            : t("integrations.moodle.list.detail")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setADesconectar(p)}
                          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
                        >
                          <Unplug className="h-4 w-4" />
                          {t("integrations.moodle.list.disconnect")}
                        </Button>
                      </div>
                    </div>

                    {desplegada && (
                      <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950">
                        {cargandoLinks === p.id ? (
                          <LoadSpinner compact />
                        ) : errorLinks[p.id] ? (
                          <p className="py-4 text-center text-sm text-red-600 dark:text-red-400">
                            {errorLinks[p.id]}
                          </p>
                        ) : (links[p.id]?.length ?? 0) === 0 ? (
                          <p className="py-4 text-center text-sm text-neutral-400 dark:text-neutral-500">
                            {t("integrations.moodle.links.empty")}
                          </p>
                        ) : (
                          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                            {links[p.id]!.map((l) => (
                              <li key={l.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Link2 className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
                                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                                    {l.survey_title}
                                  </span>
                                  {l.anonymous && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                                      <EyeOff className="h-3 w-3" />
                                      {t("integrations.moodle.links.anonymous")}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                  {l.context_title?.trim()
                                    ? t("integrations.moodle.links.course", { title: l.context_title })
                                    : t("integrations.moodle.links.noCourse")}{" "}
                                  ·{" "}
                                  {t("integrations.moodle.links.activity", {
                                    id: l.resource_link_id,
                                  })}
                                </p>
                                {/* La columna que contesta "¿por qué no me llega
                                    la nota?": cero respuestas apunta a Moodle,
                                    respuestas sin nota apuntan acá. */}
                                <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                                  {l.responses > 0
                                    ? t("integrations.moodle.links.responses", { count: l.responses })
                                    : t("integrations.moodle.links.noResponses")}
                                  {l.last_response_at
                                    ? ` · ${t("integrations.moodle.links.last", {
                                        date: fecha(l.last_response_at),
                                      })}`
                                    : ""}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {plataformas.length > 0 && (
            <Button variant="outline" size="sm" disabled={generando} onClick={onGenerar}>
              {generando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t("integrations.moodle.connectMore")}
            </Button>
          )}

          {registro && (
            <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t("integrations.moodle.link.title")}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("integrations.moodle.link.where")}
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
                  {registro}
                </code>
                <Button variant="ghost" size="sm" onClick={() => onCopiar(registro)}>
                  <Copy className="h-4 w-4" />
                  {t("integrations.moodle.link.copy")}
                </Button>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t("integrations.moodle.link.expires")}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setRegistro(null)}>
                {t("integrations.moodle.link.hide")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {aDesconectar && (
        <ModalDesconectar
          plataforma={aDesconectar}
          onClose={() => setADesconectar(null)}
          onDone={(id) => {
            quitarPlataforma(id);
            setADesconectar(null);
          }}
        />
      )}
    </>
  );
}

// Desconectar rompe todo lo que ese LMS tenga andando, así que el modal no
// alcanza con un "¿estás seguro?": muestra los números REALES de esa
// plataforma y exige escribir la palabra de confirmación.
function ModalDesconectar({
  plataforma,
  onClose,
  onDone,
}: {
  plataforma: LtiPlatform;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const { t } = useI18n();
  const [confirmacion, setConfirmacion] = useState("");
  const [desconectando, setDesconectando] = useState(false);
  const puedeDesconectar = confirmacion.trim().toLowerCase() === "aceptar";

  async function onConfirmar() {
    if (!puedeDesconectar) return;
    setDesconectando(true);
    try {
      await disconnectPlatform(plataforma.id);
      toast.success(t("integrations.moodle.toast.disconnected"));
      onDone(plataforma.id);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("integrations.moodle.toast.disconnectError")
      );
      setDesconectando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <AlertTriangle className="h-5 w-5 text-red-500" />
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {t("integrations.moodle.disconnect.title")}
          </h2>
        </div>

        <div className="space-y-3 p-5 text-sm text-neutral-600 dark:text-neutral-300">
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            {plataforma.name?.trim() || dominio(plataforma.issuer)}
          </p>
          <p>
            {t("integrations.moodle.disconnect.breaks", { count: plataforma.activities })}
          </p>
          <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
            {t("integrations.moodle.disconnect.kept", { count: plataforma.responses })}
          </p>
          <div className="space-y-1.5">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("integrations.moodle.disconnect.prompt", { word: PALABRA_CONFIRMACION })}
            </p>
            <Input
              value={confirmacion}
              onChange={(e) => setConfirmacion(e.target.value)}
              placeholder={PALABRA_CONFIRMACION}
              autoFocus
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <Button variant="ghost" onClick={onClose} disabled={desconectando}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={!puedeDesconectar || desconectando} onClick={onConfirmar}>
            {desconectando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Unplug className="h-4 w-4" />
            )}
            {t("integrations.moodle.disconnect.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
