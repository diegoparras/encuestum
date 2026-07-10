"use client";

import React from "react";
import dynamic from "next/dynamic";

// SurveyView arrastra SurveyJS (survey-core + survey-react-ui), que es pesado.
// Lo diferimos a un chunk perezoso (ssr:false) para no cargarlo en el bundle
// inicial de la página pública. El módulo registra el tipo de pregunta
// "videoresponse" a nivel de módulo, así que ese efecto se ejecuta igual al
// cargar el chunk (antes de renderizar el componente). Sólo diferimos el
// import; no movemos ninguna lógica.
const SurveyView = dynamic(() => import("./SurveyView"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center text-sm text-neutral-500">
      Cargando…
    </div>
  ),
});

export default function SurveyViewClient({ slug }: { slug: string }) {
  return <SurveyView slug={slug} />;
}
