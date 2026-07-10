"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  BarChart3,
  Building2,
  ClipboardList,
  Globe,
  Info,
  Loader2,
  LogOut,
  Moon,
  Shield,
  Sparkles,
  Sun,
  Users,
  Webhook,
  WifiOff,
  X,
} from "lucide-react";
import { getMe, logout, switchOrg, type Me } from "@/utils/auth";
import { getApiUrl } from "@/utils/api";
import { MeProvider } from "./MeContext";
import { cn } from "@/lib/utils";
import { EncuestumLogo } from "@/components/EncuestumLogo";
import { useI18n, LANGS, LANG_LABELS } from "@/lib/i18n";

function useOutsideClick(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);
  return ref;
}

// Tema claro/oscuro del chrome (estándar Escriba, por data-theme en <html>).
function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);
  const toggle = () => {
    const next = document.documentElement.dataset.theme !== "dark";
    if (next) document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("encuestum.theme", next ? "dark" : "light");
    } catch {
      /* storage no disponible */
    }
    setDark(next);
  };
  return [dark, toggle];
}

// Ícono kebab estándar Escriba: 3 círculos verticales.
function Kebab() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <circle cx="10" cy="4" r="1.7" />
      <circle cx="10" cy="10" r="1.7" />
      <circle cx="10" cy="16" r="1.7" />
    </svg>
  );
}

// Menú kebab: TODO adentro (usuario, organización, tema, secciones, acerca de,
// cerrar sesión). El header solo lleva el logo y este botón (§3.2 del estándar).
const NAV_ITEMS: { href: string; tkey: string; icon: React.ComponentType<{ className?: string }>; superOnly?: boolean }[] = [
  { href: "/surveys", tkey: "nav.surveys", icon: ClipboardList },
  { href: "/members", tkey: "nav.members", icon: Users },
  { href: "/panel", tkey: "nav.panel", icon: BarChart3 },
  { href: "/integrations", tkey: "nav.integrations", icon: Webhook },
  { href: "/ai", tkey: "nav.ai", icon: Sparkles },
  { href: "/admin", tkey: "nav.admin", icon: Shield, superOnly: true },
];

function AppMenu({ me }: { me: Me }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [dark, toggleTheme] = useTheme();
  const ref = useOutsideClick(() => setOpen(false));
  const activeOrg = me.orgs.find((o) => o.id === me.active_org_id) ?? me.orgs[0];

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      /* limpiamos la sesión igual del lado del cliente */
    }
    router.replace("/login");
  }

  async function onSwitchOrg(orgId: string) {
    if (orgId === me.active_org_id) return;
    try {
      await switchOrg(orgId);
      window.location.reload();
    } catch {
      /* ignore */
    }
  }

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("menu.title")}
        title={t("menu.title")}
        className="grid h-9 w-9 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <Kebab />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-64 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          {/* Usuario */}
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {me.user.name?.trim() || t("menu.noName")}
            </p>
            <p className="truncate text-xs text-neutral-400">{me.user.email}</p>
          </div>

          {/* Organización (si hay más de una) */}
          {me.orgs.length > 1 ? (
            <div className="px-3 pb-2 pt-1">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                {t("menu.org")}
              </label>
              <select
                value={activeOrg?.id}
                onChange={(e) => onSwitchOrg(e.target.value)}
                className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                {me.orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} · {o.role}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="px-3 pb-2 text-xs text-neutral-400">
              <Building2 className="mr-1 inline h-3.5 w-3.5" />
              {activeOrg?.name}
            </div>
          )}

          <MenuSep />

          {/* Tema */}
          <MenuItem onClick={toggleTheme} icon={dark ? Sun : Moon}>
            {dark ? t("menu.themeLight") : t("menu.themeDark")}
          </MenuItem>

          {/* Idioma (convención Escriba: en el menú, nunca suelto en el header) */}
          <div className="flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
            <Globe className="h-4 w-4 shrink-0" />
            <label htmlFor="enc-lang" className="sr-only">
              {t("menu.language")}
            </label>
            <select
              id="enc-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value as (typeof LANGS)[number])}
              className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              aria-label={t("menu.language")}
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {LANG_LABELS[l]}
                </option>
              ))}
            </select>
          </div>

          <MenuSep />

          {/* Secciones */}
          {NAV_ITEMS.filter((n) => !n.superOnly || me.user.is_superadmin).map((n) => (
            <MenuItem
              key={n.href}
              onClick={() => go(n.href)}
              icon={n.icon}
              active={pathname === n.href || (n.href === "/surveys" && pathname.startsWith("/surveys/"))}
            >
              {t(n.tkey)}
            </MenuItem>
          ))}

          <MenuSep />

          <MenuItem onClick={() => { setOpen(false); setAbout(true); }} icon={Info}>
            {t("menu.about")}
          </MenuItem>

          <MenuSep />

          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-60 dark:hover:bg-red-950/40"
          >
            {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            {t("menu.logout")}
          </button>
        </div>
      )}

      {about && <AboutModal onClose={() => setAbout(false)} />}
    </div>
  );
}

function MenuItem({
  onClick,
  icon: Icon,
  active,
  children,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm",
        active
          ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

function MenuSep() {
  return <div className="my-1 h-px bg-neutral-100 dark:bg-neutral-800" />;
}

function AboutModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>("…");
  useEffect(() => {
    fetch(getApiUrl("/api/health"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setVersion(d?.version || "—"))
      .catch(() => setVersion("—"));
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <EncuestumLogo size={40} />
          <div>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t("app.name")}</h2>
            <p className="text-xs text-neutral-400">{t("app.tagline")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto self-start rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="mt-5 space-y-2 text-sm">
          <Row label={t("about.version")} value={version} />
          <Row label={t("about.role")} value={t("about.role.value")} />
          <Row label={t("about.license")} value={t("about.license.value")} />
        </dl>
        <p className="mt-5 border-t border-neutral-100 pt-3 text-xs text-neutral-400 dark:border-neutral-800">
          {t("about.author")}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="font-medium text-neutral-800 dark:text-neutral-200">{value}</dd>
    </div>
  );
}


function DisconnectedScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-red-50 text-red-500">
          <WifiOff className="h-6 w-6" />
        </div>
        <div>
          <p className="text-base font-semibold text-neutral-800">
            {t("common.disconnected.title")}
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            {t("common.disconnected.body")}
          </p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-[#1e2a06] hover:opacity-90"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.retrying")}
        </button>
      </div>
    </div>
  );
}

function LoadingScreen() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <div className="flex flex-col items-center gap-3 text-neutral-400">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">{t("common.loading")}</p>
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  // "error" = couldn't reach the server (connection/5xx), distinct from "unauth"
  // (a real 401 → go to login). We retry instead of pretending you're logged out.
  const [status, setStatus] = useState<"loading" | "ready" | "unauth" | "error">("loading");

  const cancelledRef = useRef(false);
  const load = useCallback(() => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    getMe()
      .then((data) => {
        if (cancelledRef.current) return;
        if (!data) {
          setStatus("unauth");
          router.replace("/login");
          return;
        }
        setMe(data);
        setStatus("ready");
      })
      .catch(() => {
        // Network error / server unreachable — NOT an auth problem.
        if (cancelledRef.current) return;
        setStatus("error");
      });
  }, [router]);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  // While disconnected, keep trying in the background so the app recovers on its
  // own once the server is back (e.g. after a restart).
  useEffect(() => {
    if (status !== "error") return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [status, load]);

  if (status === "error") {
    return <DisconnectedScreen onRetry={load} />;
  }

  if (status !== "ready" || !me) {
    return <LoadingScreen />;
  }

  return (
    <MeProvider value={me}>
      <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {/* Estándar Escriba §3.2: en el header, SOLO el logo y el menú kebab. */}
        <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <Link
              href="/surveys"
              className="flex items-center gap-2 text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100"
            >
              <EncuestumLogo size={22} />
              Encuestum
            </Link>
            <AppMenu me={me} />
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </MeProvider>
  );
}
