"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { acceptInvite, getMe } from "@/utils/auth";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";

type Status = "loading" | "accepting" | "success" | "error" | "unauthenticated";

function AcceptInviteView() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [status, setStatus] = useState<Status>("loading");
  const [detail, setDetail] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!token) {
        if (!cancelled) {
          setStatus("error");
          setDetail(t("auth.invite.missingToken"));
        }
        return;
      }
      try {
        const me = await getMe();
        if (cancelled) return;
        if (!me) {
          setStatus("unauthenticated");
          return;
        }
        setStatus("accepting");
        await acceptInvite(token);
        if (cancelled) return;
        setStatus("success");
        setDetail(t("auth.invite.success"));
        // Refresh the app context and land on the panel.
        window.location.assign("/surveys");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setDetail(
            err instanceof Error
              ? err.message
              : t("auth.invite.errorFallback")
          );
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Preserve the token so the user can return here after logging in.
  const nextUrl = token
    ? `/accept-invite?token=${encodeURIComponent(token)}`
    : "/accept-invite";
  const loginHref = `/login?next=${encodeURIComponent(nextUrl)}`;
  const registerHref = `/register?next=${encodeURIComponent(nextUrl)}`;

  return (
    <Card>
      <CardContent className="py-6">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {t("auth.invite.title")}
        </h1>

        {(status === "loading" || status === "accepting") && (
          <div className="mt-6 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            {status === "loading"
              ? t("auth.invite.checkingSession")
              : t("auth.invite.accepting")}
          </div>
        )}

        {status === "success" && (
          <div className="mt-6 flex items-start gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <span>{detail} {t("auth.invite.redirecting")}</span>
          </div>
        )}

        {status === "unauthenticated" && (
          <>
            <p className="mt-6 text-sm text-neutral-600 dark:text-neutral-300">
              {t("auth.invite.unauthenticated")}
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Link
                href={loginHref}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t("auth.actions.login")}
              </Link>
              <Link
                href={registerHref}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
              >
                {t("auth.actions.createAccount")}
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
            <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
              <Link
                href="/surveys"
                className="font-medium text-primary hover:underline"
              >
                {t("auth.goToPanel")}
              </Link>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-neutral-400 dark:text-neutral-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <AcceptInviteView />
    </Suspense>
  );
}
