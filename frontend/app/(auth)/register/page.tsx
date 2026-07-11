"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { register } from "@/utils/auth";
import { getApiUrl } from "@/utils/api";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export default function RegisterPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordTooShort = password.length > 0 && password.length < 8;

  // En modo federado (Lockatus SSO) no hay alta local: mandamos al login (que
  // muestra el botón de la Suite).
  useEffect(() => {
    fetch(getApiUrl("/api/v1/auth/config"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.sso) router.replace("/login");
      })
      .catch(() => undefined);
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t("auth.errors.passwordTooShort"));
      return;
    }
    setLoading(true);
    try {
      await register({
        email: email.trim(),
        password,
        name: name.trim() || undefined,
        orgName: orgName.trim() || undefined,
      });
      router.push("/surveys");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.errors.registerFailed"));
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-6">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t("auth.register.title")}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("auth.register.subtitle")}
        </p>

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

          <div className="space-y-1.5">
            <Label htmlFor="password">{t("auth.password.label")}</Label>
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
            <Label htmlFor="name">
              {t("auth.register.nameLabel")} <span className="text-neutral-400 dark:text-neutral-500">{t("auth.optional")}</span>
            </Label>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("auth.register.namePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="orgName">
              {t("auth.register.orgLabel")}{" "}
              <span className="text-neutral-400 dark:text-neutral-500">{t("auth.optional")}</span>
            </Label>
            <Input
              id="orgName"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder={t("auth.register.orgPlaceholder")}
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? t("auth.register.submitting") : t("auth.register.submit")}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
          {t("auth.register.haveAccount")}{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("auth.actions.login")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
