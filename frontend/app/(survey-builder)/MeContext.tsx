"use client";

import { createContext, useContext } from "react";
import type { Me } from "@/utils/auth";

const MeContext = createContext<Me | null>(null);

export function MeProvider({
  value,
  children,
}: {
  value: Me;
  children: React.ReactNode;
}) {
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

// Returns the authenticated session provided by the survey-builder shell.
// The shell guarantees `me` is non-null before rendering children.
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) {
    throw new Error("useMe debe usarse dentro del shell autenticado");
  }
  return me;
}
