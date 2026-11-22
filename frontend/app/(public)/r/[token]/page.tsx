import React from "react";
import PublicResults from "./PublicResults";

// Resultados compartidos por el dueño de la encuesta (solo lectura, sin login).
export const metadata = {
  title: "Resultados",
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicResults token={token} />;
}
