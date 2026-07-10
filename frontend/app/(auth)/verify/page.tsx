"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { resendVerification, verifyEmail } from "@/utils/auth";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type Status = "verifying" | "success" | "error";

function VerifyView() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [status, setStatus] = useState<Status>("verifying");
  const [detail, setDetail] = useState<string>("");

  // Resend-verification form
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!token) {
        if (!cancelled) {
          setStatus("error");
          setDetail(t("auth.verify.missingToken"));
        }
        return;
      }
      try {
        const res = await verifyEmail(token);
        if (!cancelled) {
          setStatus("success");
          setDetail(res.detail || t("auth.verify.successFallback"));
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setDetail(
            err instanceof Error
              ? err.message
              : t("auth.verify.errorFallback")
          );
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onResend(e: React.FormEvent) {
    e.preventDefault();
    setResendError(null);
    setResendMessage(null);
    setResending(true);
    try {
      const res = await resendVerification(email.trim());
      setResendMessage(res.detail || t("auth.verify.resendSuccessFallback"));
    } catch (err) {
      setResendError(
        err instanceof Error ? err.message : t("auth.errors.resendFailed")
      );
    } finally {
      setResending(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-6">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {t("auth.verify.title")}
        </h1>

        {status === "verifying" && (
          <div className="mt-6 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t("auth.verify.verifying")}
          </div>
        )}

        {status === "success" && (
          <>
            <div className="mt-6 flex items-start gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <span>{detail}</span>
            </div>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Link
                href="/surveys"
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t("auth.goToPanel")}
              </Link>
              <Link
                href="/login"
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
              >
                {t("auth.goToLogin")}
              </Link>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div className="mt-6 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40">
              <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <span>{detail}</span>
            </div>

            <div className="mt-6 border-t border-neutral-100 pt-6 dark:border-neutral-800">
              <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t("auth.verify.resendTitle")}
              </h2>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t("auth.verify.resendSubtitle")}
              </p>
              {resendMessage ? (
                <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40">
                  {resendMessage}
                </p>
              ) : (
                <form onSubmit={onResend} className="mt-4 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="resendEmail">{t("auth.email.label")}</Label>
                    <Input
                      id="resendEmail"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t("auth.email.placeholder")}
                    />
                  </div>
                  {resendError && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40">
                      {resendError}
                    </p>
                  )}
                  <Button type="submit" className="w-full" disabled={resending}>
                    {resending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {resending ? t("auth.verify.resendSubmitting") : t("auth.verify.resendSubmit")}
                  </Button>
                </form>
              )}
            </div>
          </>
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

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-neutral-400 dark:text-neutral-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <VerifyView />
    </Suspense>
  );
}
