"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  ShieldAlert,
  Users,
} from "lucide-react";
import { getMe, type Me } from "@/utils/auth";
import {
  adminOverview,
  downloadAdminExport,
  type AdminOverview,
} from "@/utils/panel";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <div className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            {value.toLocaleString("es")}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const meData = await getMe();
      if (!meData) {
        setError("Tu sesión expiró.");
        setStatus("error");
        return;
      }
      setMe(meData);
      if (!meData.user.is_superadmin) {
        setStatus("forbidden");
        return;
      }
      const overview = await adminOverview();
      setData(overview);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los datos");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onExport() {
    setExporting(true);
    try {
      await downloadAdminExport();
      toast.success("Exportación lista");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo exportar");
    } finally {
      setExporting(false);
    }
  }

  if (status === "loading") return <LoadSpinner />;

  if (status === "forbidden") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-8 w-8 text-neutral-300 dark:text-neutral-600" />
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">No tenés acceso</p>
          <p className="max-w-sm text-sm text-neutral-400 dark:text-neutral-500">
            Esta sección es exclusiva para administradores de la plataforma.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (status === "error") {
    return <LoadError message={error} onRetry={() => void load()} />;
  }

  if (!data) return null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            Administración
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Resumen global de la plataforma
            {me?.user.email ? ` · ${me.user.email}` : ""}.
          </p>
        </div>
        <Button onClick={onExport} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Exportar plataforma a Excel
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard icon={Building2} label="Organizaciones" value={data.orgs} />
        <MetricCard icon={Users} label="Usuarios" value={data.users} />
        <MetricCard icon={FileText} label="Encuestas" value={data.surveys} />
        <MetricCard icon={MessageSquare} label="Respuestas" value={data.responses} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Building2 className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>Organizaciones</CardTitle>
        </CardHeader>
        <CardContent>
          {data.organizations.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
                    <th className="pb-2 font-medium">Organización</th>
                    <th className="pb-2 font-medium">Encuestas</th>
                    <th className="pb-2 font-medium">Respuestas</th>
                    <th className="pb-2 font-medium">Miembros</th>
                    <th className="pb-2 font-medium">Creada</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {data.organizations.map((org) => (
                    <tr key={org.id}>
                      <td className="py-3 pr-4">
                        <div className="font-medium text-neutral-900 dark:text-neutral-100">{org.name}</div>
                        <div className="text-xs text-neutral-400 dark:text-neutral-500">{org.slug}</div>
                      </td>
                      <td className="py-3 pr-4 text-neutral-700 dark:text-neutral-300">
                        {org.surveys.toLocaleString("es")}
                      </td>
                      <td className="py-3 pr-4 text-neutral-700 dark:text-neutral-300">
                        {org.responses.toLocaleString("es")}
                      </td>
                      <td className="py-3 pr-4 text-neutral-700 dark:text-neutral-300">
                        {org.members.toLocaleString("es")}
                      </td>
                      <td className="py-3 text-neutral-500 dark:text-neutral-400">
                        {formatDate(org.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-neutral-400 dark:text-neutral-500">
              No hay organizaciones registradas.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
