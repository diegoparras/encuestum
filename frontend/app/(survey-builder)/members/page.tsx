"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  Check,
  Copy,
  Loader2,
  Mail,
  Plus,
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
  switchOrg,
  updateMemberRole,
  type Invitation,
  type Me,
  type Member,
  type Role,
} from "@/utils/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Miembro",
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

export default function MembersPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-member form
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [adding, setAdding] = useState(false);

  // Create-org form
  const [newOrgName, setNewOrgName] = useState("");
  const [creatingOrg, setCreatingOrg] = useState(false);

  // Invitations
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviting, setInviting] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  const [pendingUser, setPendingUser] = useState<string | null>(null);

  const activeOrg = me?.orgs.find((o) => o.id === me.active_org_id) ?? me?.orgs[0];
  const myRole: Role = activeOrg?.role ?? "member";
  const canManage = roleAtLeast(myRole, "admin");
  const canAssignOwner = myRole === "owner";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const meData = await getMe();
      if (!meData) {
        setError("Tu sesión expiró.");
        setLoading(false);
        return;
      }
      setMe(meData);
      const list = await listMembers(meData.active_org_id);
      setMembers(list);
      const active =
        meData.orgs.find((o) => o.id === meData.active_org_id) ?? meData.orgs[0];
      if (active && roleAtLeast(active.role, "admin")) {
        try {
          const invites = await listInvitations(meData.active_org_id);
          setInvitations(invites);
        } catch {
          // Invitations are non-critical; ignore load failures here.
          setInvitations([]);
        }
      } else {
        setInvitations(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los datos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setAdding(true);
    try {
      const member = await addMember(me.active_org_id, newEmail.trim(), newRole);
      setMembers((prev) => (prev ? [...prev, member] : [member]));
      setNewEmail("");
      setNewRole("member");
      toast.success("Miembro agregado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo agregar el miembro");
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
      toast.success("Rol actualizado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo cambiar el rol");
      // Reload to restore the true value in the select.
      void load();
    } finally {
      setPendingUser(null);
    }
  }

  async function onRemove(member: Member) {
    if (!me) return;
    const isSelf = member.user_id === me.user.id;
    const msg = isSelf
      ? "¿Seguro que querés salir de esta organización?"
      : `¿Quitar a ${member.email} de la organización?`;
    if (!window.confirm(msg)) return;
    setPendingUser(member.user_id);
    try {
      await removeMember(me.active_org_id, member.user_id);
      if (isSelf) {
        toast.success("Saliste de la organización");
        window.location.reload();
        return;
      }
      setMembers((prev) => (prev ? prev.filter((m) => m.user_id !== member.user_id) : prev));
      toast.success("Miembro quitado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo quitar el miembro");
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
      toast.error(err instanceof Error ? err.message : "No se pudo cambiar de organización");
    }
  }

  async function onCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setCreatingOrg(true);
    try {
      await createOrg(newOrgName.trim());
      toast.success("Organización creada");
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo crear la organización");
      setCreatingOrg(false);
    }
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
        toast.success("Invitación creada. Copiá el enlace para compartirlo.");
      } else {
        toast.success("Invitación enviada por correo");
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo crear la invitación"
      );
    } finally {
      setInviting(false);
    }
  }

  async function onRevokeInvite(invite: Invitation) {
    if (!me) return;
    if (!window.confirm(`¿Revocar la invitación de ${invite.email}?`)) return;
    setPendingInvite(invite.id);
    try {
      await revokeInvitation(me.active_org_id, invite.id);
      setInvitations((prev) =>
        prev ? prev.filter((i) => i.id !== invite.id) : prev
      );
      toast.success("Invitación revocada");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo revocar la invitación"
      );
    } finally {
      setPendingInvite(null);
    }
  }

  async function onCopyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Enlace copiado");
    } catch {
      toast.error("No se pudo copiar el enlace");
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Miembros</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Gestioná el equipo de{" "}
          <span className="font-medium text-neutral-700">{activeOrg?.name}</span>.
        </p>
      </div>

      {/* Members list */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Users className="h-5 w-5 text-neutral-400" />
          <CardTitle>Equipo</CardTitle>
        </CardHeader>
        <CardContent>
          {members && members.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                    <th className="pb-2 font-medium">Miembro</th>
                    <th className="pb-2 font-medium">Rol</th>
                    <th className="pb-2 font-medium">Desde</th>
                    <th className="pb-2 text-right font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {members.map((m) => {
                    const isSelf = m.user_id === me?.user.id;
                    const busy = pendingUser === m.user_id;
                    return (
                      <tr key={m.user_id}>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-neutral-900">
                            {m.name?.trim() || m.email}
                            {isSelf && (
                              <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
                                vos
                              </span>
                            )}
                          </div>
                          {m.name?.trim() && (
                            <div className="text-xs text-neutral-400">{m.email}</div>
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
                              <option value="member">Miembro</option>
                              <option value="admin">Administrador</option>
                              <option value="owner" disabled={!canAssignOwner}>
                                Propietario
                              </option>
                            </Select>
                          ) : (
                            <span className="text-neutral-700">{ROLE_LABEL[m.role]}</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-neutral-500">
                          {formatDate(m.joined_at)}
                        </td>
                        <td className="py-3 text-right">
                          {(canManage || isSelf) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => onRemove(m)}
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                            >
                              {busy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                              {isSelf ? "Salir" : "Quitar"}
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
            <p className="py-6 text-center text-sm text-neutral-400">
              Todavía no hay miembros.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Add member (admin+) */}
      {canManage && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <UserPlus className="h-5 w-5 text-neutral-400" />
            <CardTitle>Agregar miembro</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={onAdd}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="newEmail">Correo del usuario</Label>
                <Input
                  id="newEmail"
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="persona@ejemplo.com"
                />
              </div>
              <div className="space-y-1.5 sm:w-48">
                <Label htmlFor="newRole">Rol</Label>
                <Select
                  id="newRole"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                >
                  <option value="member">Miembro</option>
                  <option value="admin">Administrador</option>
                  {canAssignOwner && <option value="owner">Propietario</option>}
                </Select>
              </div>
              <Button type="submit" disabled={adding}>
                {adding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Agregar
              </Button>
            </form>
            <p className="mt-2 text-xs text-neutral-400">
              El usuario debe tener una cuenta registrada en Encuestum.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Invitations (admin+) */}
      {canManage && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <Mail className="h-5 w-5 text-neutral-400" />
            <CardTitle>Invitaciones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <form
              onSubmit={onInvite}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="inviteEmail">Invitar por email</Label>
                <Input
                  id="inviteEmail"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="persona@ejemplo.com"
                />
              </div>
              <div className="space-y-1.5 sm:w-48">
                <Label htmlFor="inviteRole">Rol</Label>
                <Select
                  id="inviteRole"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                >
                  <option value="member">Miembro</option>
                  <option value="admin">Administrador</option>
                  {canAssignOwner && <option value="owner">Propietario</option>}
                </Select>
              </div>
              <Button type="submit" disabled={inviting}>
                {inviting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                Invitar
              </Button>
            </form>
            <p className="-mt-4 text-xs text-neutral-400">
              La persona recibirá un correo. Si no configuraste el envío de
              emails, copiá el enlace de la invitación y compartilo.
            </p>

            <div className="border-t border-neutral-100 pt-4">
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Pendientes
              </h3>
              {invitations && invitations.length > 0 ? (
                <ul className="divide-y divide-neutral-100">
                  {invitations.map((inv) => {
                    const busy = pendingInvite === inv.id;
                    return (
                      <li
                        key={inv.id}
                        className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-neutral-900">
                            {inv.email}
                          </p>
                          <p className="text-xs text-neutral-400">
                            {ROLE_LABEL[inv.role]} · Invitada el{" "}
                            {formatDate(inv.created_at)}
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
                              Copiar enlace
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => onRevokeInvite(inv)}
                            className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                            Revocar
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-neutral-400">
                  No hay invitaciones pendientes.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Organizations */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Building2 className="h-5 w-5 text-neutral-400" />
          <CardTitle>Organizaciones</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y divide-neutral-100">
            {me?.orgs.map((org) => {
              const isActive = org.id === me.active_org_id;
              return (
                <li
                  key={org.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-neutral-900">{org.name}</p>
                    <p className="text-xs text-neutral-400">{ROLE_LABEL[org.role]}</p>
                  </div>
                  {isActive ? (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                      <Check className="h-4 w-4" /> Activa
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onSwitchOrg(org.id)}
                    >
                      Cambiar a esta
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="border-t border-neutral-100 pt-4">
            <form
              onSubmit={onCreateOrg}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="newOrgName">Nueva organización</Label>
                <Input
                  id="newOrgName"
                  type="text"
                  required
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Nombre de la organización"
                />
              </div>
              <Button type="submit" variant="outline" disabled={creatingOrg}>
                {creatingOrg ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Crear
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
