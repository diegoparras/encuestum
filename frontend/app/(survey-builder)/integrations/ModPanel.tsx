"use client";

// La pestaña del módulo nativo (`mod_encuestum`) dentro de la sección de Moodle.
//
// Hace UNA cosa: generar el link de conexión que el admin pega en los ajustes
// del plugin. No lista sitios conectados ni permite desconectarlos porque esos
// endpoints todavía no existen del lado del módulo (sí para LTI) — y una lista
// vacía inventada sería peor que no mostrarla: diría "no hay ninguno conectado"
// de un servidor que puede tener varios.
//
// **Por qué el estado "apagado" aparece recién después de apretar el botón.**
// El panel de LTI lo resuelve antes de dibujar nada, porque `/auth/config`
// expone `lti_enabled`. Para el módulo no hay bandera equivalente publicada, así
// que el 404 del propio POST es la única señal (ver la cabecera de
// `utils/mod.ts`). Se prefirió eso a una llamada de sondeo al montar: ese
// sondeo sería este mismo POST, que mintea un token de registro de verdad —
// emitir credenciales sólo para averiguar si el endpoint existe es peor que
// enterarse un clic más tarde.

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Copy, Loader2, Plus, WifiOff } from "lucide-react";
import {
  ErrorDeRed,
  ModuloApagado,
  createModConnectUrl,
  type ModConnectUrl,
} from "@/utils/mod";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

export default function ModPanel() {
  const { t } = useI18n();

  // El link recién generado. No se persiste: vale unos minutos y volver a la
  // pestaña tiene que dar uno nuevo, no resucitar uno vencido.
  const [conexion, setConexion] = useState<ModConnectUrl | null>(null);
  const [generando, setGenerando] = useState(false);
  // Una vez que el servidor contestó 404, no se vuelve a ofrecer el botón: ya
  // se sabe que no va a andar hasta que alguien toque la configuración.
  const [apagado, setApagado] = useState(false);
  const [sinRed, setSinRed] = useState(false);

  async function onGenerar() {
    setGenerando(true);
    setSinRed(false);
    try {
      setConexion(await createModConnectUrl());
    } catch (err) {
      // Los dos casos con pantalla propia se distinguen por tipo, no por el
      // texto del mensaje: el resto (403 de no-admin, 500, lo que sea) va al
      // toast con el `detail` que mandó el backend.
      if (err instanceof ModuloApagado) setApagado(true);
      else if (err instanceof ErrorDeRed) setSinRed(true);
      else toast.error(err instanceof Error ? err.message : t("integrations.mod.toast.linkError"));
    } finally {
      setGenerando(false);
    }
  }

  async function onCopiar(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("integrations.mod.toast.linkCopied"));
    } catch {
      toast.error(t("integrations.mod.toast.linkCopyError"));
    }
  }

  // Estado 1: el módulo está apagado en este servidor. Mismo bloque que usa la
  // pestaña de LTI para su propia bandera, para que el admin reconozca la forma.
  if (apagado) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <p>
          {t("integrations.mod.disabled.prefix")}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800 dark:text-neutral-200">
            MOD_ENABLED=true
          </code>
          {t("integrations.mod.disabled.suffix")}
        </p>
      </div>
    );
  }

  // Minutos, no segundos: `expires_in` viene en segundos y nadie lee "1800".
  // `Math.max(1, …)` para que un TTL corto no muestre "0 minutos".
  const minutos = conexion ? Math.max(1, Math.round(conexion.expires_in / 60)) : 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {t("integrations.mod.subtitle")}
      </p>

      {!conexion ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t("integrations.mod.empty")}
          </p>
          <Button className="mt-4" disabled={generando} onClick={onGenerar}>
            {generando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t("integrations.mod.generate")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("integrations.mod.link.title")}
          </p>
          {/* Dónde pegarlo. Sin esta línea el link es un string sin destino: el
              plugin del módulo NO se configura donde el de LTI. */}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("integrations.mod.link.where")}
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
              {conexion.url}
            </code>
            <Button variant="ghost" size="sm" onClick={() => onCopiar(conexion.url)}>
              <Copy className="h-4 w-4" />
              {t("integrations.mod.link.copy")}
            </Button>
          </div>
          {/* Cuánto vale, con el número que dijo el backend. */}
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t("integrations.mod.link.expires", { minutes: minutos })}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" disabled={generando} onClick={onGenerar}>
              {generando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t("integrations.mod.regenerate")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConexion(null)}>
              {t("integrations.mod.link.hide")}
            </Button>
          </div>
        </div>
      )}

      {/* Estado 2: el servidor no contestó. Distinto del 404 a propósito: acá el
          botón sirve para reintentar, allá no serviría de nada. */}
      {sinRed && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t("integrations.mod.network")}</p>
        </div>
      )}

      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        {t("integrations.mod.requires")}
      </p>
    </div>
  );
}
