/** @type {import('next').NextConfig} */

// LTI 1.3: cuando la integración está prendida, Moodle carga dos páginas
// nuestras dentro de un <iframe> de su propio origen — el selector de deep
// linking (/lti-select) y el lanzamiento de recurso, que es la misma vista
// pública de encuesta de siempre (/s/[slug]). Con X-Frame-Options:
// SAMEORIGIN (el default de esta app, más abajo) el navegador se niega a
// mostrarlas ahí, y X-Frame-Options no puede expresar "cualquier origen" —
// su sucesor, la directiva CSP `frame-ancestors`, sí puede. Por eso, sólo
// con LTI_ENABLED prendido, esas dos rutas cambian a
// `Content-Security-Policy: frame-ancestors *` y se les saca
// X-Frame-Options (los dos headers compiten por controlar el framing, y en
// algunos navegadores X-Frame-Options gana incluso con una CSP permisiva
// presente). Es un trade-off real, no una formalidad: prendiendo LTI,
// cualquier sitio puede enmarcar /s/[slug] — no sólo Moodle — porque esa
// misma ruta sirve todas las encuestas públicas, atadas a LTI o no. Es
// exactamente lo que una integración LMS necesita; el resto de la app sigue
// con SAMEORIGIN sin cambios.
//
// OJO al tocar esto: `headers()` corre una sola vez, durante `next build`
// —no en cada arranque del server como podría parecer. En producción /
// standalone el server lee el `routes-manifest.json` que `next build` deja
// congelado (ver next/dist/server/lib/router-utils/filesystem.js: sólo
// `next dev` vuelve a invocar `headers()` en caliente). El Dockerfile de
// este repo buildea el frontend en un stage que NO recibe LTI_ENABLED —esa
// variable sólo se define en el contenedor final, en runtime (start.sh)—
// así que, tal como está armado el build hoy, este flag queda fijado al
// valor de LTI_ENABLED que había en el momento de `docker build`, no al que
// tenga el contenedor corriendo. Ver el reporte de Task 5
// (.superpowers/sdd/task-5-report.md) para el detalle y qué haría falta
// para que el build-arg viaje hasta acá.
const LTI_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.LTI_ENABLED || "").trim().toLowerCase()
);

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone) so the production
  // image can run `node server.js` without the full node_modules tree.
  output: "standalone",
  // Soft security headers. Intentionally NO strict CSP: SurveyJS uses inline
  // styles on the public response pages and a strict policy would break them.
  async headers() {
    const framingRules = LTI_ENABLED
      ? [
          {
            source: "/lti-select",
            headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
          },
          {
            source: "/s/:slug*",
            headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
          },
          {
            // Todo lo que NO sea /lti-select ni /s/... : el lookahead negativo
            // excluye esas dos rutas a nivel de `source` (no alcanza con poner
            // esta regla antes o después — los headers de varias reglas que
            // matchean el mismo path se combinan, así que un `/:path*` sin
            // exclusión les seguiría agregando SAMEORIGIN encima de la CSP).
            source: "/((?!lti-select|s/).*)",
            headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
          },
        ]
      : [
          {
            source: "/:path*",
            headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
          },
        ];

    return [
      ...framingRules,
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
