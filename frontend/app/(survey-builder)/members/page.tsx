"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  Check,
  Copy,
  Globe,
  Loader2,
  Mail,
  Plus,
  Save,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import {
  addMember,
  createInvitation,
  createOrg,
  getMe,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  roleAtLeast,
  setSubdomain,
  switchOrg,
  updateMemberRole,
  type Invitation,
  type Me,
  type Member,
  type Role,
} from "@/utils/auth";
import { useAsyncData } from "@/lib/useAsyncData";
import { useI18n } from "@/lib/i18n";
import { LoadError, LoadSpinner } from "@/components/LoadError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

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

export default function MembersPage() {
  const { t } = useI18n();
  const roleLabel = (role: Role) => t(`members.role.${role}`);
  const { data, status, error, reload, setData } = useAsyncData(async () => {
    const meData = await getMe();
    if (!meData) throw new Error(t("members.error.session"));
    const members = await listMembers(meData.active_org_id);
    const active =
      meData.orgs.find((o) => o.id === meData.active_org_id) ?? meData.orgs[0];
    let invitations: Invitation[] | null = null;
    if (active && roleAtLeast(active.role, "admin")) {
      try {
        invitations = await listInvitations(meData.active_org_id);
      } catch {
        // Invitations are non-critical; ignore load failures here.
        invitations = [];
      }
    }
    return { me: meData, members, invitations };
  }, []);

  const me = data?.me ?? null;
  const members = data?.members ?? null;
  const invitations = data?.invitations ?? null;

  // Setters que actualizan el objeto cargado, conservando la firma de useState
  // (aceptan valor o función updater) para no tocar los handlers existentes.
  const setMe = useCallback(
    (updater: Me | ((prev: Me) => Me)) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              me:
                typeof updater === "function"
                  ? (updater as (p: Me) => Me)(prev.me)
                  : updater,
            }
          : prev!
      );
    },
    [setData]
  );
  const setMembers = useCallback(
    (updater: Member[] | ((prev: Member[]) => Member[])) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              members:
                typeof updater === "function"
                  ? (updater as (p: Member[]) => Member[])(prev.members)
                  : updater,
            }
          : prev!
      );
    },
    [setData]
  );
  const setInvitations = useCallback(
    (
      updater:
        | Invitation[]
        | ((prev: Invitation[] | null) => Invitation[] | null)
    ) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              invitations:
                typeof updater === "function"
                  ? (updater as (p: Invitation[] | null) => Invitation[] | null)(
                      prev.invitations
                    )
                  : updater,
            }
          : prev!
      );
    },
    [setData]
  );

  // Add-member form
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [adding, setAdding] = useState(false);

  // Create-org form
  const [newOrgName, setNewOrgName] = useState("");
  const [creatingOrg, setCreatingOrg] = useState(false);

  // Invitations
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviting, setInviting] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  const [pendingUser, setPendingUser] = useState<string | null>(null);

  // Subdomain
  const [subdomainInput, setSubdomainInput] = useState("");
  const [savingSubdomain, setSavingSubdomain] = useState(false);

  const activeOrg = me?.orgs.find((o) => o.id === me.active_org_id) ?? me?.orgs[0];
  const myRole: Role = activeOrg?.role ?? "member";
  const canManage = roleAtLeast(myRole, "admin");
  const canAssignOwner = myRole === "owner";

  // Keep the subdomain field in sync with the active org.
  useEffect(() => {
    setSubdomainInput(activeOrg?.subdomain ?? "");
  }, [activeOrg?.subdomain]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setAdding(true);
    try {
      const member = await addMember(me.active_org_id, newEmail.trim(), newRole);
      setMembers((prev) => (prev ? [...prev, member] : [member]));
      setNewEmail("");
      setNewRole("member");
      toast.success(t("members.toast.added"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("members.toast.addError"));
    } finally {
      setAdding(false);
    }
  }

  async function onChangeRole(userId: string, role: Role) {
    if (!me) return;
    setPendingUser(userId);
    try {
      const updated = await updateMemberRole(me.active_org_id, userId, role);
      setMembers((prev) =>
        prev ? prev.map((m) => (m.user_id === userId ? updated : m)) : prev
      );
      toast.success(t("members.toast.roleUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("members.toast.roleError"));
      // Reload to restore the true value in the select.
      void reload();
    } finally {
      setPendingUser(null);
    }
  }

  async function onRemove(member: Member) {
    if (!me) return;
    const isSelf = member.user_id === me.user.id;
    const msg = isSelf
      ? t("members.confirm.leave")
      : t("members.confirm.remove", { email: member.email });
    if (!window.confirm(msg)) return;
    setPendingUser(member.user_id);
    try {
      await removeMember(me.active_org_id, member.user_id);
      if (isSelf) {
        toast.success(t("members.toast.left"));
        window.location.reload();
        return;
      }
      setMembers((prev) => (prev ? prev.filter((m) => m.user_id !== member.user_id) : prev));
      toast.success(t("members.toast.removed"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("members.toast.removeError"));
    } finally {
      setPendingUser(null);
    }
  }

  async function onSwitchOrg(orgId: string) {
    if (!me || orgId === me.active_org_id) return;
    try {
      await switchOrg(orgId);
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("members.toast.switchError"));
    }
  }

  async function onCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setCreatingOrg(true);
    try {
      await createOrg(newOrgName.trim());
      toast.success(t("members.toast.orgCreated"));
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("members.toast.orgCreateError"));
      setCreatingOrg(false);
    }
  }

  async function persistSubdomain(value: string | null) {
    if (!me) return;
    setSavingSubdomain(true);
    try {
      const updated = await setSubdomain(me.active_org_id, value);
      setMe((prev) =>
        prev
          ? {
              ...prev,
              orgs: prev.orgs.map((o) => (o.id === updated.id ? updated : o)),
            }
          : prev
      );
      setSubdomainInput(updated.subdomain ?? "");
      toast.success(updated.subdomain ? t("members.toast.subdomainSaved") : t("members.toast.subdomainRemoved"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("members.toast.subdomainError")
      );
    } finally {
      setSavingSubdomain(false);
    }
  }

  async function onSaveSubdomain(e: React.FormEvent) {
    e.preventDefault();
    const value = subdomainInput.trim().toLowerCase();
    await persistSubdomain(value || null);
  }

  async function onRemoveSubdomain() {
    await persistSubdomain(null);
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setInviting(true);
    try {
      const invite = await createInvitation(
        me.active_org_id,
        inviteEmail.trim(),
        inviteRole
      );
      setInvitations((prev) => (prev ? [invite, ...prev] : [invite]));
      setInviteEmail("");
      setInviteRole("member");
      if (invite.accept_url) {
        toast.success(t("members.toast.inviteCreated"));
      } else {
        toast.success(t("members.toast.inviteSent"));
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("members.toast.inviteError")
      );
    } finally {
      setInviting(false);
    }
  }

  async function onRevokeInvite(invite: Invitation) {
    if (!me) return;
    if (!window.confirm(t("members.confirm.revoke", { email: invite.email }))) return;
    setPendingInvite(invite.id);
    try {
      await revokeInvitation(me.active_org_id, invite.id);
      setInvitations((prev) =>
        prev ? prev.filter((i) => i.id !== invite.id) : prev
      );
      toast.success(t("members.toast.inviteRevoked"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("members.toast.revokeError")
      );
    } finally {
      setPendingInvite(null);
    }
  }

  async function onCopyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("members.toast.linkCopied"));
    } catch {
      toast.error(t("members.toast.linkCopyError"));
    }
  }

  if (status === "loading") return <LoadSpinner />;
  if (status === "error") return <LoadError message={error} onRetry={reload} />;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">{t("members.title")}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("members.subtitle.prefix")}
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{activeOrg?.name}</span>
          {t("members.subtitle.suffix")}
        </p>
      </div>

      {/* Members list */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Users className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>{t("members.team.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {members && members.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    <th className="pb-2 font-medium">{t("members.team.col.member")}</th>
                    <th className="pb-2 font-medium">{t("members.team.col.role")}</th>
                    <th className="pb-2 font-medium">{t("members.team.col.since")}</th>
                    <th className="pb-2 text-right font-medium">{t("members.team.col.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {members.map((m) => {
                    const isSelf = m.user_id === me?.user.id;
                    const busy = pendingUser === m.user_id;
                    return (
                      <tr key={m.user_id}>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-neutral-900 dark:text-neutral-100">
                            {m.name?.trim() || m.email}
                            {isSelf && (
                              <span className="ml-2 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                                {t("members.you")}
                              </span>
                            )}
                          </div>
                          {m.name?.trim() && (
                            <div className="text-xs text-neutral-400 dark:text-neutral-500">{m.email}</div>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {canManage ? (
                            <Select
                              value={m.role}
                              disabled={busy}
                              onChange={(e) =>
                                onChangeRole(m.user_id, e.target.value as Role)
                              }
                              className="h-8 w-40 py-0"
                            >
                              <option value="member">{t("members.role.member")}</option>
                              <option value="admin">{t("members.role.admin")}</option>
                              <option value="owner" disabled={!canAssignOwner}>
                                {t("members.role.owner")}
                              </option>
                            </Select>
                          ) : (
                            <span className="text-neutral-700 dark:text-neutral-300">{roleLabel(m.role)}</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-neutral-500 dark:text-neutral-400">
                          {formatDate(m.joined_at)}
                        </td>
                        <td className="py-3 text-right">
                          {(canManage || isSelf) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => onRemove(m)}
                              className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700"
                            >
                              {busy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                              {isSelf ? t("members.action.leave") : t("members.action.remove")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-neutral-400 dark:text-neutral-500">
              {t("members.team.empty")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Subdomain */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Globe className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>{t("members.subdomain.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {canManage ? (
            <>
              <form
                onSubmit={onSaveSubdomain}
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
              >
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="subdomain">{t("members.subdomain.label")}</Label>
                  <div className="flex items-stretch">
                    <Input
                      id="subdomain"
                      value={subdomainInput}
                      onChange={(e) =>
                        setSubdomainInput(e.target.value.toLowerCase())
                      }
                      placeholder="acme"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className={me?.base_domain ? "rounded-r-none" : ""}
                    />
                    {me?.base_domain && (
                      <span className="inline-flex select-none items-center rounded-r-lg border border-l-0 border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 px-3 text-sm text-neutral-500 dark:text-neutral-400">
                        .{me.base_domain}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={savingSubdomain}>
                    {savingSubdomain ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {t("members.subdomain.save")}
                  </Button>
                  {activeOrg?.subdomain && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={savingSubdomain}
                      onClick={onRemoveSubdomain}
                    >
                      {t("members.subdomain.remove")}
                    </Button>
                  )}
                </div>
              </form>
              {!me?.base_domain && (
                <p className="text-xs text-amber-600">
                  {t("members.subdomain.envHint.prefix")}<code>ENCUESTUM_BASE_DOMAIN</code>{t("members.subdomain.envHint.suffix")}
                </p>
              )}
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                {t("members.subdomain.help")}
              </p>
            </>
          ) : activeOrg?.subdomain ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              {t("members.subdomain.readonlyLabel")}
              <span className="font-mono text-neutral-900 dark:text-neutral-100">
                {activeOrg.subdomain}
                {me?.base_domain ? `.${me.base_domain}` : ""}
              </span>
            </p>
          ) : (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">
              {t("members.subdomain.none")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Add member (admin+) */}
      {canManage && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <UserPlus className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
            <CardTitle>{t("members.add.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={onAdd}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="newEmail">{t("members.add.emailLabel")}</Label>
                <Input
                  id="newEmail"
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder={t("members.add.emailPlaceholder")}
                />
              </div>
              <div className="space-y-1.5 sm:w-48">
                <Label htmlFor="newRole">{t("members.role.label")}</Label>
                <Select
                  id="newRole"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                >
                  <option value="member">{t("members.role.member")}</option>
                  <option value="admin">{t("members.role.admin")}</option>
                  {canAssignOwner && <option value="owner">{t("members.role.owner")}</option>}
                </Select>
              </div>
              <Button type="submit" disabled={adding}>
                {adding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {t("members.add.submit")}
              </Button>
            </form>
            <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              {t("members.add.hint")}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Invitations (admin+) */}
      {canManage && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <Mail className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
            <CardTitle>{t("members.invitations.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <form
              onSubmit={onInvite}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="inviteEmail">{t("members.invite.emailLabel")}</Label>
                <Input
                  id="inviteEmail"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t("members.add.emailPlaceholder")}
                />
              </div>
              <div className="space-y-1.5 sm:w-48">
                <Label htmlFor="inviteRole">{t("members.role.label")}</Label>
                <Select
                  id="inviteRole"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                >
                  <option value="member">{t("members.role.member")}</option>
                  <option value="admin">{t("members.role.admin")}</option>
                  {canAssignOwner && <option value="owner">{t("members.role.owner")}</option>}
                </Select>
              </div>
              <Button type="submit" disabled={inviting}>
                {inviting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {t("members.invite.submit")}
              </Button>
            </form>
            <p className="-mt-4 text-xs text-neutral-400 dark:text-neutral-500">
              {t("members.invite.hint")}
            </p>

            <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4">
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t("members.invitations.pending")}
              </h3>
              {invitations && invitations.length > 0 ? (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {invitations.map((inv) => {
                    const busy = pendingInvite === inv.id;
                    return (
                      <li
                        key={inv.id}
                        className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                            {inv.email}
                          </p>
                          <p className="text-xs text-neutral-400 dark:text-neutral-500">
                            {t("members.invitations.meta", {
                              role: roleLabel(inv.role),
                              date: formatDate(inv.created_at),
                            })}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {inv.accept_url && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onCopyLink(inv.accept_url as string)}
                            >
                              <Copy className="h-4 w-4" />
                              {t("members.invite.copyLink")}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => onRevokeInvite(inv)}
                            className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700"
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                            {t("members.invite.revoke")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-neutral-400 dark:text-neutral-500">
                  {t("members.invitations.empty")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Organizations */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Building2 className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
          <CardTitle>{t("members.orgs.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {me?.orgs.map((org) => {
              const isActive = org.id === me.active_org_id;
              return (
                <li
                  key={org.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">{org.name}</p>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500">{roleLabel(org.role)}</p>
                  </div>
                  {isActive ? (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                      <Check className="h-4 w-4" /> {t("members.orgs.active")}
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onSwitchOrg(org.id)}
                    >
                      {t("members.orgs.switch")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4">
            <form
              onSubmit={onCreateOrg}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="newOrgName">{t("members.orgs.newLabel")}</Label>
                <Input
                  id="newOrgName"
                  type="text"
                  required
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder={t("members.orgs.newPlaceholder")}
                />
              </div>
              <Button type="submit" variant="outline" disabled={creatingOrg}>
                {creatingOrg ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {t("members.orgs.create")}
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
