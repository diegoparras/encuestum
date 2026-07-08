import React from "react";

// Standalone admin shell for the survey module. Kept separate from the deck
// dashboard so it doesn't require an LLM to be configured (surveys don't need
// one in this phase). Auth is enforced by the FastAPI session middleware on the
// /api/v1/survey/* calls these pages make.
export const metadata = {
  title: "Encuestas · Presentia",
};

export default function SurveyBuilderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-neutral-50 text-neutral-900">{children}</div>;
}
