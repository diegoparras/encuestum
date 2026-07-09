"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  BarChart3,
  Building2,
  Check,
  ChevronDown,
  ClipboardList,
  Loader2,
  LogOut,
  Shield,
  Sparkles,
  Users,
  Webhook,
} from "lucide-react";
import { getMe, logout, switchOrg, type Me } from "@/utils/auth";
import { MeProvider } from "./MeContext";
import { cn } from "@/lib/utils";

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

function OrgSwitcher({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useOutsideClick(() => setOpen(false));
  const active = me.orgs.find((o) => o.id === me.active_org_id) ?? me.orgs[0];

  async function pick(orgId: string) {
    if (orgId === me.active_org_id) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await switchOrg(orgId);
      window.location.reload();
    } catch {
      setSwitching(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className="inline-flex max-w-[200px] items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
      >
        {switching ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : (
          <Building2 className="h-4 w-4 shrink-0 text-neutral-400" />
        )}
        <span className="truncate font-medium">{active?.name ?? "Organización"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
          <p className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
            Organizaciones
          </p>
          {me.orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => pick(org.id)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{org.name}</span>
                <span className="block text-xs text-neutral-400">{org.role}</span>
              </span>
              {org.id === me.active_org_id && (
                <Check className="h-4 w-4 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu({ me }: { me: Me }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const ref = useOutsideClick(() => setOpen(false));
  const label = me.user.name?.trim() || me.user.email;
  const initial = (label[0] ?? "?").toUpperCase();

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      /* ignore — clear session client-side regardless */
    }
    router.replace("/login");
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initial}
        </span>
        <ChevronDown className="h-4 w-4 text-neutral-400" />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-neutral-900">
              {me.user.name?.trim() || "Sin nombre"}
            </p>
            <p className="truncate text-xs text-neutral-400">{me.user.email}</p>
          </div>
          <div className="my-1 h-px bg-neutral-100" />
          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-60"
          >
            {loggingOut ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

function NavLink({
  href,
  active,
  icon: Icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-neutral-100 text-neutral-900"
          : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </Link>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unauth">("loading");

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setStatus("unauth");
          router.replace("/login");
          return;
        }
        setMe(data);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("unauth");
        router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (status !== "ready" || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="flex flex-col items-center gap-3 text-neutral-400">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">Cargando…</p>
        </div>
      </div>
    );
  }

  return (
    <MeProvider value={me}>
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex items-center gap-6">
              <Link
                href="/surveys"
                className="flex items-center gap-2 text-lg font-bold tracking-tight text-neutral-900"
              >
                <span
                  className="inline-block h-5 w-5 rounded-md"
                  style={{ backgroundColor: "#e25a4e" }}
                  aria-hidden
                />
                Encuestum
              </Link>
              <nav className="hidden items-center gap-1 sm:flex">
                <NavLink
                  href="/surveys"
                  active={pathname === "/surveys" || pathname.startsWith("/surveys/")}
                  icon={ClipboardList}
                >
                  Encuestas
                </NavLink>
                <NavLink href="/members" active={pathname === "/members"} icon={Users}>
                  Miembros
                </NavLink>
                <NavLink
                  href="/panel"
                  active={pathname === "/panel"}
                  icon={BarChart3}
                >
                  Panel
                </NavLink>
                <NavLink
                  href="/integrations"
                  active={pathname === "/integrations"}
                  icon={Webhook}
                >
                  Integraciones
                </NavLink>
                <NavLink href="/ai" active={pathname === "/ai"} icon={Sparkles}>
                  IA
                </NavLink>
                {me.user.is_superadmin && (
                  <NavLink
                    href="/admin"
                    active={pathname === "/admin"}
                    icon={Shield}
                  >
                    Admin
                  </NavLink>
                )}
              </nav>
            </div>
            <div className="flex items-center gap-2">
              <OrgSwitcher me={me} />
              <UserMenu me={me} />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </MeProvider>
  );
}
