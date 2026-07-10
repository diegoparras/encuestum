"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { resetPassword } from "@/utils/auth";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

function ResetForm() {
  const { t } = useI18n();
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
      setError(t("auth.errors.invalidLink"));
      return;
    }
    if (password.length < 8) {
      setError(t("auth.errors.passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.errors.passwordMismatch"));
      return;
    }
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("auth.errors.resetFailed")
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-6">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {t("auth.reset.title")}
        </h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("auth.reset.subtitle")}
        </p>

        {done ? (
          <>
            <p className="mt-6 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40">
              {t("auth.reset.success")}
            </p>
            <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
              <Link
                href="/login"
                className="font-medium text-primary hover:underline"
              >
                {t("auth.goToLogin")}
              </Link>
            </p>
          </>
        ) : (
          <>
            {!token && (
              <p className="mt-6 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/40">
                {t("auth.reset.missingToken")}
              </p>
            )}
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="password">{t("auth.reset.newPasswordLabel")}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("auth.password.minPlaceholder")}
                />
                <p
                  className={
                    passwordTooShort
                      ? "text-xs text-red-600"
                      : "text-xs text-neutral-400 dark:text-neutral-500"
                  }
                >
                  {t("auth.password.hint")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">{t("auth.reset.confirmLabel")}</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={t("auth.reset.confirmPlaceholder")}
                />
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? t("auth.reset.submitting") : t("auth.reset.submit")}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
              <Link
                href="/login"
                className="font-medium text-primary hover:underline"
              >
                {t("auth.backToLogin")}
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
        <div className="flex min-h-[40vh] items-center justify-center text-neutral-400 dark:text-neutral-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <ResetForm />
    </Suspense>
  );
}
