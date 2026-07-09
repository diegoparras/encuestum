import React from "react";
import AppShell from "./AppShell";

// Authenticated shell for the platform (surveys + members). AppShell is a client
// component that verifies the session on mount and renders the top nav, org
// switcher and user menu. Auth on the /api/v1/* calls is enforced server-side by
// the FastAPI session middleware; this shell is the UX gate.
export const metadata = {
  title: "Encuestum",
};

export default function SurveyBuilderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
