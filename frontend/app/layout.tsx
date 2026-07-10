import "./globals.css";
import React from "react";
import { Toaster } from "sonner";

export const metadata = {
  title: "Encuestum",
  description: "Encuestas y evaluaciones con corrección por IA",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
    // suppressHydrationWarning: algunas extensiones del navegador inyectan
    // atributos en <html>/<body> antes de que React hidrate; eso dispara un
    // warning de hidratación inofensivo que acá silenciamos.
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Estándar Escriba: aplicar el tema antes de pintar, para evitar flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("encuestum.theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}',
          }}
        />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
