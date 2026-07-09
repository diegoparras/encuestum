"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { resetPassword } from "@/utils/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

function ResetForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordTooShort = password.length > 0 && password.length < 8;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("El enlace no es válido. Solicitá uno nuevo.");
      return;
    }
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo restablecer la contraseña"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-6">
        <h1 className="text-xl font-semibold text-neutral-900">
          Restablecer contraseña
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Elegí una nueva contraseña para tu cuenta.
        </p>

        {done ? (
          <>
            <p className="mt-6 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              Tu contraseña se actualizó correctamente. Ya podés ingresar con la
              nueva.
            </p>
            <p className="mt-6 text-center text-sm text-neutral-500">
              <Link
                href="/login"
                className="font-medium text-primary hover:underline"
              >
                Ir a Ingresar
              </Link>
            </p>
          </>
        ) : (
          <>
            {!token && (
              <p className="mt-6 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                Falta el token de recuperación. Abrí el enlace del correo o
                solicitá uno nuevo.
              </p>
            )}
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="password">Nueva contraseña</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                />
                <p
                  className={
                    passwordTooShort
                      ? "text-xs text-red-600"
                      : "text-xs text-neutral-400"
                  }
                >
                  Al menos 8 caracteres.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">Repetir contraseña</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repetí la contraseña"
                />
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "Guardando…" : "Restablecer contraseña"}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-neutral-500">
              <Link
                href="/login"
                className="font-medium text-primary hover:underline"
              >
                Volver a Ingresar
              </Link>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function ResetPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-neutral-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <ResetForm />
    </Suspense>
  );
}
