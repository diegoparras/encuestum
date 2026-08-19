"use client";

// La sección de Moodle de la página de Integraciones.
//
// **Dos pestañas, una sola sección, y eso es la decisión de diseño.** Hay dos
// formas de conectar Moodle con Encuestum -- el plugin LTI (`local_encuestum`,
// en producción) y el módulo nativo (`mod_encuestum`) -- y las dos conectan el
// MISMO Moodle. Como secciones hermanas quedarían dos tarjetas casi idénticas,
// las dos hablando de Moodle, y el administrador tendría que deducir por su
// cuenta si le hacen falta las dos, si una reemplaza a la otra, o cuál le
// conviene. Como pestañas, la elección se plantea una sola vez, en el lugar
// donde hay que hacerla, con la línea de arriba explicando qué cambia entre
// una y otra. (Conviven: elegir una pestaña no desconecta la otra.)
//
// Cada pestaña trae sus propios datos y sus propios estados: la de LTI lista
// plataformas y desconecta; la del módulo sólo puede dar de alta la conexión,
// porque no hay todavía endpoints de listado ni de baja para el módulo.
//
// La pestaña de LTI tiene tres estados, y el orden en que se resuelven importa:
//   1. LTI apagado en el servidor  -> se explica qué variable definir.
//   2. Prendido y sin plataformas  -> botón que genera el link de registro.
//   3. Con plataformas conectadas  -> lista con filas desplegables.
//
// En los estados 2 y 3 conviven las DOS formas de conectar: el registro
// dinámico (un clic, pero lo tiene que hacer un administrador del sitio de
// Moodle) y el alta manual (`LtiManualForm`, la única puerta para un docente
// de curso). La línea que dice cuál te corresponde va al lado de los dos
// botones: elegir mal cuesta más que cualquiera de los dos flujos.
//
// El estado 1 se resuelve con `ltiEnabled()` ANTES de tocar ningún `/lti/*`:
// con la bandera apagada esos endpoints devuelven 404 y sin el chequeo previo
// se vería un error de red donde debería haber una explicación. El módulo no
// puede hacer lo mismo porque su bandera no está publicada en `/auth/config`;
// cómo lo resuelve está en `ModPanel.tsx`.
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
  Plug,
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
import LtiManualForm from "./LtiManualForm";
import ModPanel from "./ModPanel";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// La palabra que hay que escribir para confirmar la desconexión. Es literal y
// no se traduce: el chequeo la compara tal cual, así que el texto que la pide
// la interpola en vez de reescribirla en cada idioma.
const PALABRA_CONFIRMACION = "aceptar";

// `t()` no sabe pluralizar, y acá el singular no es un caso raro: un Moodle
// recién conectado tiene una sola actividad, y una actividad recién publicada
// una sola respuesta. Sin esto el modal obligatorio diría "Se rompe su 1
// actividades". Cada clave con contador tiene su variante `...One`.
function claveSegunCantidad(clave: string, n: number): string {
  return n === 1 ? `${clave}One` : clave;
}

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

type Pestana = "lti" | "mod";

export default function MoodleSection() {
  const { t } = useI18n();
  const [pestana, setPestana] = useState<Pestana>("lti");

  // Arranca en LTI porque es la conexión que hoy está en producción y la que
  // funciona sin instalar un módulo de actividad: es la respuesta correcta para
  // quien todavía no eligió.
  const solapas: { id: Pestana; etiqueta: string }[] = [
    { id: "lti", etiqueta: t("integrations.moodle.tab.lti") },
    { id: "mod", etiqueta: t("integrations.moodle.tab.mod") },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <GraduationCap className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
        <CardTitle>{t("integrations.moodle.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* La línea que hace elegir: qué cambia entre una conexión y la otra.
            Va ANTES de las pestañas porque si va adentro de una de ellas, sólo
            la lee quien ya eligió. */}
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t("integrations.moodle.chooseHint")}
        </p>

        <div
          role="tablist"
          aria-label={t("integrations.moodle.title")}
          className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800"
        >
          {solapas.map((s) => {
            const activa = pestana === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`moodle-tab-${s.id}`}
                aria-selected={activa}
                aria-controls={`moodle-panel-${s.id}`}
                onClick={() => setPestana(s.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400",
                  activa
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
                )}
              >
                {s.etiqueta}
              </button>
            );
          })}
        </div>

        {/* Sólo se monta la pestaña visible: la de LTI pide plataformas al
            montarse, y tenerla montada de fondo golpearía el backend por una
            pantalla que nadie está mirando. */}
        <div
          role="tabpanel"
          id={`moodle-panel-${pestana}`}
          aria-labelledby={`moodle-tab-${pestana}`}
        >
          {pestana === "lti" ? <PanelLti /> : <ModPanel />}
        </div>
      </CardContent>
    </Card>
  );
}

// La pestaña de LTI 1.3: el listado de plataformas conectadas y el alta.
function PanelLti() {
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

  // El formulario de alta manual, plegado hasta que alguien lo pide.
  const [manual, setManual] = useState(false);

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
      // Sólo si el que termina es el que se está esperando. Con dos plataformas
      // desplegadas casi a la vez, limpiar incondicionalmente hacía que al
      // terminar la primera la segunda dejara de mostrarse "cargando" y pintara
      // "ninguna actividad usa todavía una encuesta" — justo el mensaje que
      // esta sección existe para no equivocar.
      setCargandoLinks((actual) => (actual === p.id ? null : actual));
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

  if (status === "loading") return <LoadSpinner compact />;

  if (status === "error") return <LoadError message={error} onRetry={reload} compact />;

  // Estado 1: la integración está apagada en este servidor.
  if (!data?.enabled) {
    return (
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
    );
  }

  const plataformas = data.platforms;

  return (
    <>
      <div className="space-y-4">
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
                        {t(claveSegunCantidad("integrations.moodle.list.activities", p.activities),
                           { count: p.activities })} ·{" "}
                        {t(claveSegunCantidad("integrations.moodle.list.responses", p.responses),
                           { count: p.responses })}
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
                                  ? t(claveSegunCantidad("integrations.moodle.links.responses",
                                                         l.responses), { count: l.responses })
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

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Sin plataformas, el botón de registro dinámico ya está adentro
                del recuadro punteado; acá sólo va el del alta manual. */}
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
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={manual}
              onClick={() => setManual((v) => !v)}
            >
              <Plug className="h-4 w-4" />
              {manual
                ? t("integrations.moodle.manual.close")
                : t("integrations.moodle.manual.open")}
            </Button>
          </div>
          {/* Cuál de las dos te corresponde. Una línea, al lado de los dos
              botones: quien no es admin del sitio de Moodle puede pasarse
              media hora peleando con el registro dinámico sin saber que nunca
              iba a andar para él. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {t("integrations.moodle.manual.which")}
          </p>
        </div>

        {manual && (
          <LtiManualForm
            onCreada={() => {
              // Se pliega y se recarga el listado: la plataforma nueva tiene
              // que aparecer arriba, no quedar invisible hasta un F5.
              setManual(false);
              reload();
            }}
          />
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
      </div>

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
  // Contra la constante, no contra el literal: son lo mismo hoy, pero si
  // alguien cambia la constante, la pantalla pediría una palabra y el botón
  // aceptaría otra.
  const puedeDesconectar = confirmacion.trim().toLowerCase() === PALABRA_CONFIRMACION;

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
    // El backdrop no cierra mientras el DELETE está en vuelo: si cerrara y el
    // borrado igual saliera bien, la fila seguiría en pantalla hasta recargar y
    // el siguiente intento daría 404. Mismo criterio que el botón Cancelar.
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
      onClick={() => { if (!desconectando) onClose(); }}
    >
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
            {t(claveSegunCantidad("integrations.moodle.disconnect.breaks", plataforma.activities),
               { count: plataforma.activities })}
          </p>
          <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
            {t(claveSegunCantidad("integrations.moodle.disconnect.kept", plataforma.responses),
               { count: plataforma.responses })}
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
