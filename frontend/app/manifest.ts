import type { MetadataRoute } from "next";

// Instalable como app (escritorio y celular). El service worker de las
// encuestas públicas está en /public/sw.js.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Encuestum",
    short_name: "Encuestum",
    description: "Encuestas y exámenes con IA",
    start_url: "/surveys",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#8faf0e",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
