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
  return (
    <html lang="es">
      <body>
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
