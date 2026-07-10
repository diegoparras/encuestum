"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
  BarChart3,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Users,
} from "lucide-react";
import { getMe } from "@/utils/auth";
import { downloadOrgExport, orgOverview } from "@/utils/panel";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const STATUS_KEYS = ["draft", "published", "closed"] as const;

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
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
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

export default function PanelPage() {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);

  const statusLabel = (s: string) =>
    (STATUS_KEYS as readonly string[]).includes(s) ? t(`panel.status.${s}`) : s;

  const { data, status, error, reload } = useAsyncData(async () => {
    const meData = await getMe();
    if (!meData) throw new Error(t("panel.error.session"));
    const overview = await orgOverview(meData.active_org_id);
    return { me: meData, overview };
  }, []);

  async function onExport() {
    if (!data) return;
    setExporting(true);
    try {
      await downloadOrgExport(data.me.active_org_id);
      toast.success(t("panel.toast.exportReady"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("panel.toast.exportError"));
    } finally {
      setExporting(false);
    }
  }

  if (status === "loading") return <LoadSpinner />;
  if (status === "error") return <LoadError message={error} onRetry={reload} />;
  if (!data) return null;

  const { me, overview } = data;
  const activeOrg = me.orgs.find((o) => o.id === me.active_org_id) ?? me.orgs[0];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">{t("panel.title")}</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {t("panel.subtitle.prefix")}
            <span className="font-medium text-neutral-700 dark:text-neutral-300">{activeOrg?.name}</span>
            {t("panel.subtitle.suffix")}
          </p>
        </div>
        <Button onClick={onExport} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {t("panel.export")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard icon={FileText} label={t("panel.metric.surveys")} value={overview.surveys} />
        <MetricCard icon={MessageSquare} label={t("panel.metric.responses")} value={overview.responses} />
        <MetricCard icon={Users} label={t("panel.metric.members")} value={overview.members} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <BarChart3 className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>{t("panel.byStatus.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {STATUS_KEYS.map((s) => (
              <div key={s} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-center">
                <div className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                  {overview.by_status[s].toLocaleString("es")}
                </div>
                <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{statusLabel(s)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("panel.recent.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.recent.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    <th className="pb-2 font-medium">{t("panel.recent.col.survey")}</th>
                    <th className="pb-2 font-medium">{t("panel.recent.col.status")}</th>
                    <th className="pb-2 font-medium">{t("panel.recent.col.responses")}</th>
                    <th className="pb-2 font-medium">{t("panel.recent.col.updated")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {overview.recent.map((s) => (
                    <tr key={s.id}>
                      <td className="py-3 pr-4">
                        <Link
                          href={`/surveys/${s.id}`}
                          className="font-medium text-neutral-900 dark:text-neutral-100 hover:text-primary hover:underline"
                        >
                          {s.title?.trim() || t("panel.recent.untitled")}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-neutral-500 dark:text-neutral-400">
                        {statusLabel(s.status)}
                      </td>
                      <td className="py-3 pr-4 text-neutral-700 dark:text-neutral-300">
                        {s.responses.toLocaleString("es")}
                      </td>
                      <td className="py-3 text-neutral-500 dark:text-neutral-400">{formatDate(s.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-neutral-400 dark:text-neutral-500">
              {t("panel.recent.empty")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
