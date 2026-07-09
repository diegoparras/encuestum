"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  BarChart3,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Users,
} from "lucide-react";
import { getMe, type Me } from "@/utils/auth";
import {
  downloadOrgExport,
  orgOverview,
  type OrgOverview,
} from "@/utils/panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  closed: "Cerrada",
};

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
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <div className="text-2xl font-bold tracking-tight text-neutral-900">
            {value.toLocaleString("es")}
          </div>
          <div className="text-xs text-neutral-500">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PanelPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [data, setData] = useState<OrgOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const activeOrg = me?.orgs.find((o) => o.id === me.active_org_id) ?? me?.orgs[0];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const meData = await getMe();
      if (!meData) {
        setError("Tu sesión expiró.");
        return;
      }
      setMe(meData);
      const overview = await orgOverview(meData.active_org_id);
      setData(overview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los datos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onExport() {
    if (!me) return;
    setExporting(true);
    try {
      await downloadOrgExport(me.active_org_id);
      toast.success("Exportación lista");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo exportar");
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-neutral-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-red-600">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => void load()}>
            Reintentar
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Panel</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Resumen de{" "}
            <span className="font-medium text-neutral-700">{activeOrg?.name}</span>.
          </p>
        </div>
        <Button onClick={onExport} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Exportar todo a Excel
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard icon={FileText} label="Encuestas" value={data.surveys} />
        <MetricCard icon={MessageSquare} label="Respuestas" value={data.responses} />
        <MetricCard icon={Users} label="Miembros" value={data.members} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <BarChart3 className="h-5 w-5 text-neutral-400" />
          <CardTitle>Encuestas por estado</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {(["draft", "published", "closed"] as const).map((s) => (
              <div key={s} className="rounded-lg border border-neutral-200 p-4 text-center">
                <div className="text-2xl font-bold text-neutral-900">
                  {data.by_status[s].toLocaleString("es")}
                </div>
                <div className="mt-1 text-xs text-neutral-500">{STATUS_LABEL[s]}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Encuestas recientes</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                    <th className="pb-2 font-medium">Encuesta</th>
                    <th className="pb-2 font-medium">Estado</th>
                    <th className="pb-2 font-medium">Respuestas</th>
                    <th className="pb-2 font-medium">Actualizada</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {data.recent.map((s) => (
                    <tr key={s.id}>
                      <td className="py-3 pr-4">
                        <Link
                          href={`/surveys/${s.id}`}
                          className="font-medium text-neutral-900 hover:text-primary hover:underline"
                        >
                          {s.title?.trim() || "(sin título)"}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-neutral-500">
                        {STATUS_LABEL[s.status] ?? s.status}
                      </td>
                      <td className="py-3 pr-4 text-neutral-700">
                        {s.responses.toLocaleString("es")}
                      </td>
                      <td className="py-3 text-neutral-500">{formatDate(s.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-neutral-400">
              Todavía no hay encuestas en esta organización.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
