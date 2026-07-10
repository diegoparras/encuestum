"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { forgotPassword } from "@/utils/auth";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export default function ForgotPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await forgotPassword(email.trim());
      setMessage(res.detail || t("auth.forgot.successFallback"));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("auth.errors.requestFailed")
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-6">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {t("auth.forgot.title")}
        </h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("auth.forgot.subtitle")}
        </p>

        {message ? (
          <p className="mt-6 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40">
            {message}
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("auth.email.label")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("auth.email.placeholder")}
              />
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("auth.backToLogin")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
