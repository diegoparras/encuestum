import React from "react";
import { AuthBranding } from "./AuthBranding";

export const metadata = {
  title: "Acceder · Encuestum",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-100 px-4 py-12 dark:bg-neutral-950">
      <div className="w-full max-w-md">
        <AuthBranding />
        {children}
      </div>
    </div>
  );
}
