"use client";

// El alta manual de una plataforma LTI 1.3, dentro de la pestaña de LTI.
//
// **Por qué existe, si ya está el registro dinámico.** El registro dinámico lo
// hace un administrador del SITIO de Moodle. Un docente con acceso a un curso
// —que sí puede crear una herramienta LTI 1.3 a nivel curso— no llega a esa
// pantalla, así que para él la conexión automática no es una alternativa más
// lenta: directamente no está. Esta pantalla es la única puerta que le queda.
//
// **Las dos mitades.** Conectar a mano es un intercambio en dos direcciones y
// las dos tienen que estar acá, o la pantalla resuelve la mitad del problema:
//   1. Lo que se pega EN Moodle: las URLs de esta instalación. No estaban en
//      ningún lado del panel; había que deducirlas del código del backend.
//   2. Lo que se trae DE Moodle: el formulario propiamente dicho.
//
// **La ergonomía es el punto.** De los seis datos que pide el endpoint, tres
// salen del primero: escrito el issuer, las tres URLs del LMS se completan
// solas con los paths de Moodle. Quedan editables (otro LMS las tiene
// distintas) pero plegadas, porque nadie tendría que tipearlas. Sin eso, esto
// es un formulario de seis campos crípticos; con eso, son dos datos y listo.
//
// El `deployment_id` no se autocompleta ni se puede adivinar: en Moodle es el
// id numérico de la herramienta recién creada (`strval($typeid)` en
// `mod/lti/locallib.php`). Por eso el campo lo explica en vez de sólo pedirlo.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Loader2, Plug } from "lucide-react";
import {
  ErrorLti,
  createPlatform,
  urlsInstalacion,
  type UrlsInstalacion,
} from "@/utils/lti";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

// Los paths que Moodle usa para las tres URLs derivables. Se aplican sólo si
// el issuer parece una URL http(s): con "campus" a medio escribir, derivar
// daría basura.
function derivadas(issuer: string): { login: string; token: string; jwks: string } | null {
  const base = issuer.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/i.test(base)) return null;
  return {
    login: `${base}/mod/lti/auth.php`,
    token: `${base}/mod/lti/token.php`,
    jwks: `${base}/mod/lti/certs.php`,
  };
}

// El error ya traducido a algo que se puede leer: un título, una explicación y
// —cuando viene del servidor— su mensaje textual. El 400 del guard SSRF dice
// exactamente qué URL rechazó y por qué; reemplazarlo por un genérico sería
// borrar la única pista útil.
type Falla = { titulo: string; cuerpo: string; detalle?: string };

export default function LtiManualForm({ onCreada }: { onCreada: () => void }) {
  const { t } = useI18n();

  // Las URLs de esta instalación dependen del origen del navegador, así que no
  // son estado ni salen de un efecto: se calculan una vez, en el render. Este
  // formulario sólo se monta cuando alguien aprieta "conectar a mano", o sea
  // siempre del lado del cliente -- no entra en el HTML que se prerenderiza y
  // no hay nada que pueda quedar desincronizado al hidratar.
  const urls: UrlsInstalacion | null = useMemo(() => urlsInstalacion(), []);

  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [deployments, setDeployments] = useState("");
  const [nombre, setNombre] = useState("");

  const [authLogin, setAuthLogin] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [jwks, setJwks] = useState("");
  // Cuál de las tres tocó la persona a mano: una vez editada, el issuer deja
  // de pisarla. Si no, escribir el issuer al final borraría lo que puso.
  const [tocadas, setTocadas] = useState({ login: false, token: false, jwks: false });

  const [avanzado, setAvanzado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [falla, setFalla] = useState<Falla | null>(null);

  function onIssuer(valor: string) {
    setIssuer(valor);
    const d = derivadas(valor);
    if (!tocadas.login) setAuthLogin(d?.login ?? "");
    if (!tocadas.token) setAuthToken(d?.token ?? "");
    if (!tocadas.jwks) setJwks(d?.jwks ?? "");
  }

  async function onCopiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t("integrations.moodle.toast.linkCopied"));
    } catch {
      toast.error(t("integrations.moodle.toast.linkCopyError"));
    }
  }

  async function onEnviar(e: React.FormEvent) {
    e.preventDefault();
    setFalla(null);

    const ids = deployments
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!issuer.trim() || !clientId.trim() || ids.length === 0) {
      setFalla({ titulo: t("integrations.moodle.manual.error.other.title"),
                 cuerpo: t("integrations.moodle.manual.error.missing") });
      return;
    }
    if (!derivadas(issuer)) {
      setFalla({ titulo: t("integrations.moodle.manual.error.other.title"),
                 cuerpo: t("integrations.moodle.manual.error.issuer") });
      return;
    }

    setEnviando(true);
    try {
      await createPlatform({
        // Sin barra final: el issuer del `id_token` que manda Moodle no la
        // trae, y la búsqueda de la plataforma en cada lanzamiento es por
        // igualdad exacta (`_platform_for`). Una barra de más acá dejaría una
        // conexión que nunca matchea.
        issuer: issuer.trim().replace(/\/+$/, ""),
        client_id: clientId.trim(),
        deployment_ids: ids,
        auth_login_url: authLogin.trim(),
        auth_token_url: authToken.trim(),
        jwks_url: jwks.trim(),
        name: nombre.trim() || null,
      });
      toast.success(t("integrations.moodle.manual.toast.created"));
      onCreada();
    } catch (err) {
      const status = err instanceof ErrorLti ? err.status : 0;
      const detalle = err instanceof Error ? err.message : "";
      if (status === 409) {
        setFalla({ titulo: t("integrations.moodle.manual.error.duplicate.title"),
                   cuerpo: t("integrations.moodle.manual.error.duplicate.body"), detalle });
      } else if (status === 400) {
        // El campo rechazado es una de las tres URLs del LMS: se despliega el
        // bloque plegado, porque si no el mensaje señala un campo que no está
        // en pantalla.
        setAvanzado(true);
        setFalla({ titulo: t("integrations.moodle.manual.error.url.title"),
                   cuerpo: t("integrations.moodle.manual.error.url.body"), detalle });
      } else if (status === 403) {
        setFalla({ titulo: t("integrations.moodle.manual.error.role.title"),
                   cuerpo: t("integrations.moodle.manual.error.role.body"), detalle });
      } else {
        setFalla({ titulo: t("integrations.moodle.manual.error.other.title"), cuerpo: detalle });
      }
    } finally {
      setEnviando(false);
    }
  }

  // Las cinco filas del formulario de Moodle, en el orden en que aparecen ahí.
  // Tres comparten el mismo valor (la URL de lanzamiento) y aun así van como
  // filas separadas con su propio botón: quien está completando el otro lado
  // va bajando campo por campo, no deduciendo cuál repetir dónde.
  const filas = urls
    ? [
        { clave: "launch", valor: urls.launch },
        { clave: "keyset", valor: urls.jwks },
        { clave: "login", valor: urls.login },
        { clave: "redirect", valor: urls.launch },
        { clave: "deeplink", valor: urls.launch },
      ]
    : [];

  return (
    <div className="space-y-5 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div>
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {t("integrations.moodle.manual.title")}
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t("integrations.moodle.manual.intro")}
        </p>
      </div>

      {/* Mitad 1: lo que se pega en Moodle. */}
      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {t("integrations.moodle.manual.step1")}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("integrations.moodle.manual.step1.where")}
        </p>
        <ul className="space-y-1.5">
          {filas.map((f, i) => (
            <li
              key={`${f.clave}-${i}`}
              className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900 sm:flex-row sm:items-center sm:gap-3"
            >
              <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300 sm:w-52">
                {t(`integrations.moodle.manual.url.${f.clave}`)}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
                {f.valor}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 self-start sm:self-auto"
                onClick={() => onCopiar(f.valor)}
              >
                <Copy className="h-4 w-4" />
                {t("integrations.moodle.link.copy")}
              </Button>
            </li>
          ))}
        </ul>
        {/* El origen es una aproximación, no la URL pública configurada: hay
            que decirlo donde se copia, no en la documentación. */}
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t("integrations.moodle.manual.step1.base", { origin: urls?.origin ?? "" })}
        </p>
      </section>

      {/* Mitad 2: lo que se trae de Moodle. */}
      <form onSubmit={onEnviar} className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {t("integrations.moodle.manual.step2")}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("integrations.moodle.manual.step2.where")}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="ltiIssuer">{t("integrations.moodle.manual.issuer")}</Label>
          <Input
            id="ltiIssuer"
            value={issuer}
            onChange={(e) => onIssuer(e.target.value)}
            placeholder="https://campus.universidad.edu"
            autoComplete="off"
          />
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {t("integrations.moodle.manual.issuer.hint")}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ltiClientId">{t("integrations.moodle.manual.clientId")}</Label>
            <Input
              id="ltiClientId"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              {t("integrations.moodle.manual.clientId.hint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltiDeployment">{t("integrations.moodle.manual.deployment")}</Label>
            <Input
              id="ltiDeployment"
              value={deployments}
              onChange={(e) => setDeployments(e.target.value)}
              placeholder="12"
              autoComplete="off"
            />
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              {t("integrations.moodle.manual.deployment.hint")}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ltiName">{t("integrations.moodle.manual.name")}</Label>
          <Input
            id="ltiName"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder={t("integrations.moodle.manual.name.hint")}
            autoComplete="off"
          />
        </div>

        {/* Las tres derivadas: completas, editables y plegadas. */}
        <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
          <button
            type="button"
            onClick={() => setAvanzado((v) => !v)}
            aria-expanded={avanzado}
            className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            {avanzado ? (
              <ChevronDown className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" />
            )}
            {avanzado
              ? t("integrations.moodle.manual.advanced.hide")
              : t("integrations.moodle.manual.advanced.show")}
          </button>
          {avanzado && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("integrations.moodle.manual.advanced.hint")}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="ltiAuthLogin">{t("integrations.moodle.manual.authLogin")}</Label>
                <Input
                  id="ltiAuthLogin"
                  value={authLogin}
                  onChange={(e) => {
                    setAuthLogin(e.target.value);
                    setTocadas((p) => ({ ...p, login: true }));
                  }}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ltiAuthToken">{t("integrations.moodle.manual.authToken")}</Label>
                <Input
                  id="ltiAuthToken"
                  value={authToken}
                  onChange={(e) => {
                    setAuthToken(e.target.value);
                    setTocadas((p) => ({ ...p, token: true }));
                  }}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ltiJwks">{t("integrations.moodle.manual.jwks")}</Label>
                <Input
                  id="ltiJwks"
                  value={jwks}
                  onChange={(e) => {
                    setJwks(e.target.value);
                    setTocadas((p) => ({ ...p, jwks: true }));
                  }}
                  autoComplete="off"
                />
              </div>
            </div>
          )}
        </div>

        {falla && (
          <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{falla.titulo}</p>
              <p className="text-xs">{falla.cuerpo}</p>
              {falla.detalle && (
                <p className="text-xs">
                  <span className="opacity-70">{t("integrations.moodle.manual.error.server")}</span>{" "}
                  <span className="font-mono break-words">{falla.detalle}</span>
                </p>
              )}
            </div>
          </div>
        )}

        <Button type="submit" disabled={enviando}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {t("integrations.moodle.manual.submit")}
        </Button>
      </form>
    </div>
  );
}
