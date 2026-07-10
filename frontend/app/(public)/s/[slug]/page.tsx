import React from "react";
import SurveyViewClient from "./SurveyViewClient";

// Public survey page. Rendered on the client: the SurveyJS runtime builds the
// form model and posts responses straight to the (login-exempt) FastAPI
// endpoint. No auth, no ConfigurationInitializer — a respondent only needs the
// renderer.
export const metadata = {
  title: "Encuesta",
  robots: { index: false, follow: false },
};

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <SurveyViewClient slug={slug} />;
}
