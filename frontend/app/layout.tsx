import "./globals.css";
import React from "react";
import { Toaster } from "sonner";
import { I18nProvider } from "@/lib/i18n";

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
        {/* Estándar Escriba: aplicar tema e idioma antes de pintar, sin flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("encuestum.theme")==="dark")document.documentElement.dataset.theme="dark";var l=localStorage.getItem("encuestum.lang");if(l)document.documentElement.lang=l}catch(e){}',
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <I18nProvider>
          {children}
          <Toaster richColors position="top-center" />
        </I18nProvider>
      </body>
    </html>
  );
}
