"use client";

import React from "react";
import { useI18n } from "@/lib/i18n";

/**
 * Botón de pantalla completa, visible SOLO cuando la encuesta está embebida en
 * un iframe (típicamente un LMS vía LTI).
 *
 * Por qué existe: dentro de Moodle la encuesta vive en un `contentframe` que
 * ocupa lo que sobra de la ventana, debajo de la cabecera, el menú del curso y
 * la navegación de la actividad. Para responder un examen eso es incómodo: se
 * pierde la mitad de la pantalla en cromo del LMS y aparece un scroll dentro de
 * otro scroll. El iframe que arma Moodle trae `allowfullscreen`, así que el
 * tool puede pedir pantalla completa por su cuenta — solo hay que ofrecerlo.
 *
 * Abierta por su propio link no se muestra: ahí la encuesta ya ocupa toda la
 * ventana y el botón sería ruido.
 */
export default function FullscreenButton() {
  const { t } = useI18n();
  const [embebido, setEmbebido] = React.useState(false);
  const [activo, setActivo] = React.useState(false);
  const [disponible, setDisponible] = React.useState(false);

  React.useEffect(() => {
    // window.top puede tirar una excepción entre orígenes distintos; que la
    // tire ya significa que estamos embebidos.
    let dentroDeIframe: boolean;
    try {
      dentroDeIframe = window.self !== window.top;
    } catch {
      dentroDeIframe = true;
    }
    setEmbebido(dentroDeIframe);
    // Marca para el CSS: no existe un selector "estoy en un iframe", así que la
    // condición se calcula acá una sola vez y el resto se resuelve con estilos
    // (ver ENC_EMBED_CSS en SurveyView).
    document.documentElement.classList.toggle("enc-embedded", dentroDeIframe);
    // Si el iframe no trae `allowfullscreen`, pedirlo falla en silencio: mejor
    // no ofrecer un botón que no va a hacer nada.
    setDisponible(typeof document.documentElement.requestFullscreen === "function"
      && document.fullscreenEnabled);

    const alCambiar = () => setActivo(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", alCambiar);
    return () => document.removeEventListener("fullscreenchange", alCambiar);
  }, []);

  if (!embebido || !disponible) return null;

  const alternar = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Algunos navegadores lo rechazan sin gesto del usuario o con políticas
      // de permisos restrictivas. No hay nada que hacer y no vale la pena
      // molestar a quien está respondiendo.
    }
  };

  const etiqueta = activo ? t("public.fullscreen.exit") : t("public.fullscreen.enter");

  return (
    <button
      type="button"
      onClick={alternar}
      title={etiqueta}
      aria-label={etiqueta}
      className="fixed right-3 top-3 z-50 flex h-9 w-9 items-center justify-center
                 rounded-full border border-black/10 bg-white/80 text-neutral-700
                 shadow-sm backdrop-blur transition hover:bg-white hover:text-black
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/30
                 dark:border-white/15 dark:bg-black/40 dark:text-neutral-200
                 dark:hover:bg-black/60 dark:hover:text-white"
    >
      {activo ? (
        // Flechas hacia adentro: salir.
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
        </svg>
      ) : (
        // Flechas hacia afuera: entrar.
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
        </svg>
      )}
    </button>
  );
}
