"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Mail, KeyRound } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { DesignSettings } from "../../../(survey-builder)/builder/model";

// Palette derived from the survey design so the gate and the result screens
// look right in both light and dark themes (the theme can be dark).
export function gatePalette(design: DesignSettings) {
  const dark = design.mode === "dark";
  return {
    dark,
    pageBg: design.backgroundColor || (dark ? "#181c24" : "#f6f6f7"),
    cardBg: dark ? "#1f2530" : "#ffffff",
    text: dark ? "#e5e7eb" : "#1f2937",
    muted: dark ? "#9aa3b2" : "#6b7280",
    border: dark ? "#374151" : "#e5e7eb",
    inputBg: dark ? "#141821" : "#ffffff",
    ring: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
  };
}

// Read email/code from the URL once (magic link). SSR-safe: guarded window use.
export function useMagicLinkParams(): { email: string; code: string } {
  return useMemo(() => {
    if (typeof window === "undefined") return { email: "", code: "" };
    try {
      const p = new URLSearchParams(window.location.search);
      return { email: p.get("email") || "", code: p.get("code") || "" };
    } catch {
      return { email: "", code: "" };
    }
  }, []);
}

// A centered, theme-aware card used by the gate and the result screens.
function GateShell({
  design,
  brandingHeader,
  title,
  children,
}: {
  design: DesignSettings;
  brandingHeader?: React.ReactNode;
  title?: string | null;
  children: React.ReactNode;
}) {
  const c = gatePalette(design);
  return (
    <div className="min-h-screen" style={{ backgroundColor: c.pageBg }}>
      {brandingHeader}
      {/* Padding más compacto en móvil para que la tarjeta aproveche el ancho. */}
      <div className="flex min-h-[80vh] flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
        <div
          className="w-full max-w-md rounded-2xl p-6 sm:p-8 shadow-sm"
          style={{
            backgroundColor: c.cardBg,
            boxShadow: `0 0 0 1px ${c.ring}`,
            color: c.text,
          }}
        >
          {title && (
            <h1 className="mb-1 text-center text-xl font-semibold" style={{ color: c.text }}>
              {title}
            </h1>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

interface GateInputProps {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  icon?: React.ReactNode;
  autoFocus?: boolean;
  placeholder?: string;
  design: DesignSettings;
}

function GateInput({
  id,
  label,
  type = "text",
  value,
  onChange,
  icon,
  autoFocus,
  placeholder,
  design,
}: GateInputProps) {
  const c = gatePalette(design);
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-sm font-medium" style={{ color: c.muted }}>
        {label}
      </span>
      <span className="relative block">
        {icon && (
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: c.muted }}
          >
            {icon}
          </span>
        )}
        <input
          id={id}
          type={type}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          // min-h táctil (44px) y text-base en móvil: con menos de 16px iOS
          // hace zoom automático al enfocar el input.
          className="w-full min-h-[44px] rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none transition focus:ring-2"
          style={{
            backgroundColor: c.inputBg,
            color: c.text,
            border: `1px solid ${c.border}`,
            paddingLeft: icon ? 38 : undefined,
          }}
        />
      </span>
    </label>
  );
}

/**
 * Access gate for restricted (gated) surveys. On success it hands the parent
 * the access token and the full PublicSurvey (with its json_schema) so the
 * survey can be rendered.
 */
export function AccessGate({
  slug,
  accessMode,
  design,
  accent,
  title,
  brandingHeader,
  apiBase,
  onGranted,
}: {
  slug: string;
  accessMode: "pin" | "list";
  design: DesignSettings;
  accent: string;
  title?: string | null;
  brandingHeader?: React.ReactNode;
  apiBase: () => string;
  onGranted: (token: string, survey: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const c = gatePalette(design);
  const magic = useMagicLinkParams();
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState(magic.email);
  const [code, setCode] = useState(magic.code);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const autoTried = useRef(false);

  async function attempt(payload: Record<string, string>) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/access`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError((body && body.detail) || t("public.access.error.validate"));
        return;
      }
      if (body?.access_token && body?.survey) {
        onGranted(body.access_token as string, body.survey as Record<string, any>);
      } else {
        setError(t("public.access.error.unexpected"));
      }
    } catch {
      setError(t("public.access.error.connect"));
    } finally {
      setLoading(false);
    }
  }

  // Magic link: if email and code arrive in the URL (list mode), try once.
  useEffect(() => {
    if (autoTried.current) return;
    if (accessMode === "list" && magic.email && magic.code) {
      autoTried.current = true;
      void attempt({ email: magic.email, code: magic.code });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessMode, magic.email, magic.code]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (accessMode === "pin") {
      if (!pin.trim()) {
        setError(t("public.access.error.needPin"));
        return;
      }
      void attempt({ pin: pin.trim() });
    } else {
      if (!email.trim() || !code.trim()) {
        setError(t("public.access.error.needEmailCode"));
        return;
      }
      void attempt({ email: email.trim(), code: code.trim() });
    }
  }

  return (
    <GateShell design={design} brandingHeader={brandingHeader} title={title}>
      <div
        className="mx-auto mb-4 mt-2 grid h-12 w-12 place-items-center rounded-full"
        style={{ backgroundColor: `${accent}22`, color: accent }}
      >
        <Lock className="h-6 w-6" />
      </div>
      <p className="mb-6 text-center text-sm" style={{ color: c.muted }}>
        {accessMode === "pin"
          ? t("public.access.prompt.pin")
          : t("public.access.prompt.list")}
      </p>

      <form onSubmit={submit} className="space-y-4">
        {accessMode === "pin" ? (
          <GateInput
            id="gate-pin"
            label={t("public.access.pinLabel")}
            type="password"
            value={pin}
            onChange={setPin}
            icon={<KeyRound className="h-4 w-4" />}
            autoFocus
            design={design}
          />
        ) : (
          <>
            <GateInput
              id="gate-email"
              label={t("public.access.emailLabel")}
              type="email"
              value={email}
              onChange={setEmail}
              icon={<Mail className="h-4 w-4" />}
              placeholder={t("public.access.emailPlaceholder")}
              autoFocus={!magic.email}
              design={design}
            />
            <GateInput
              id="gate-code"
              label={t("public.access.codeLabel")}
              value={code}
              onChange={setCode}
              icon={<KeyRound className="h-4 w-4" />}
              design={design}
            />
          </>
        )}

        {error && (
          <p
            className="rounded-lg px-3 py-2 text-sm"
            style={{ backgroundColor: "#ef444422", color: c.dark ? "#fca5a5" : "#b91c1c" }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full min-h-[44px] rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-60"
          style={{ backgroundColor: accent }}
        >
          {loading ? t("public.access.verifying") : t("public.access.enter")}
        </button>
      </form>
    </GateShell>
  );
}

/**
 * Result lookup for list-mode surveys. Lets a respondent check their graded
 * result later with their email + code. On a graded result it calls onGraded
 * so the parent can render its rich results screen; a pending result is shown
 * inline with the server's detail message.
 */
export function ResultCheck({
  slug,
  design,
  accent,
  prefill,
  apiBase,
  onGraded,
}: {
  slug: string;
  design: DesignSettings;
  accent: string;
  prefill?: { email?: string; code?: string };
  apiBase: () => string;
  onGraded: (result: any, creds: { email: string; code: string }) => void;
}) {
  const { t } = useI18n();
  const c = gatePalette(design);
  const [email, setEmail] = useState(prefill?.email || "");
  const [code, setCode] = useState(prefill?.code || "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !code.trim()) {
      setError(t("public.access.error.needEmailCode"));
      return;
    }
    setLoading(true);
    setError(null);
    setPending(null);
    try {
      const res = await fetch(
        `${apiBase()}/api/v1/survey/public/${encodeURIComponent(slug)}/result`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), code: code.trim() }),
        }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError((body && body.detail) || t("public.result.error.validate"));
        return;
      }
      if (body?.status === "graded" && body.result) {
        onGraded(body.result, { email: email.trim(), code: code.trim() });
      } else if (body?.status === "pending") {
        setPending(body.detail || t("public.result.pendingDefault"));
      } else {
        setError(t("public.access.error.unexpected"));
      }
    } catch {
      setError(t("public.access.error.connect"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <GateInput
        id="result-email"
        label={t("public.access.emailLabel")}
        type="email"
        value={email}
        onChange={setEmail}
        icon={<Mail className="h-4 w-4" />}
        placeholder={t("public.access.emailPlaceholder")}
        design={design}
      />
      <GateInput
        id="result-code"
        label={t("public.access.codeLabel")}
        value={code}
        onChange={setCode}
        icon={<KeyRound className="h-4 w-4" />}
        design={design}
      />

      {error && (
        <p
          className="rounded-lg px-3 py-2 text-sm"
          style={{ backgroundColor: "#ef444422", color: c.dark ? "#fca5a5" : "#b91c1c" }}
        >
          {error}
        </p>
      )}
      {pending && (
        <p
          className="rounded-lg px-3 py-2 text-sm"
          style={{ backgroundColor: "#f59e0b22", color: c.dark ? "#fcd34d" : "#b45309" }}
        >
          {pending}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full min-h-[44px] rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-60"
        style={{ backgroundColor: accent }}
      >
        {loading ? t("public.result.checking") : t("public.result.view")}
      </button>
    </form>
  );
}

// Post-submit screen for list-mode surveys: a thank-you plus (when results are
// held back) a notice and the result lookup form.
export function PostSubmitScreen({
  design,
  accent,
  title,
  brandingHeader,
  pending,
  slug,
  prefill,
  apiBase,
  onGraded,
}: {
  design: DesignSettings;
  accent: string;
  title?: string | null;
  brandingHeader?: React.ReactNode;
  pending: boolean;
  slug: string;
  prefill?: { email?: string; code?: string };
  apiBase: () => string;
  onGraded: (result: any, creds: { email: string; code: string }) => void;
}) {
  const { t } = useI18n();
  const c = gatePalette(design);
  const [showCheck, setShowCheck] = useState(false);

  return (
    <GateShell design={design} brandingHeader={brandingHeader} title={title}>
      <h2 className="mb-2 text-center text-lg font-semibold" style={{ color: c.text }}>
        {t("public.received")}
      </h2>
      {pending ? (
        <p className="mb-5 text-center text-sm" style={{ color: c.muted }}>
          {t("public.postSubmit.pending")}
        </p>
      ) : (
        <p className="mb-5 text-center text-sm" style={{ color: c.muted }}>
          {t("public.postSubmit.thanks")}
        </p>
      )}

      {showCheck ? (
        <ResultCheck
          slug={slug}
          design={design}
          accent={accent}
          prefill={prefill}
          apiBase={apiBase}
          onGraded={onGraded}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowCheck(true)}
          className="w-full min-h-[44px] rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition"
          style={{ backgroundColor: accent }}
        >
          {t("public.result.view")}
        </button>
      )}
    </GateShell>
  );
}
