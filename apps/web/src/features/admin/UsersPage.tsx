import { useState } from "react";
import { useWindowScope } from "@/components/kago/window-scope";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "@/api/client";
import { useUsers } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Card, Page, Row, RowList } from "@/components/kago/page";
import { run } from "@/lib/run";
import { confirmAction, promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { useWorkspaceStore } from "@/stores/workspace";
import type { UserAccount } from "@/types/kago";
import { t } from "@/lib/i18n";

type Role = UserAccount["role"];
export const roleLabels: Record<Role, string> = { ADMIN: t("Administrator"), USER: t("Standard user") };

export function UsersPage({ currentUserId }: { currentUserId: string }) {
  const scope = useWindowScope();
  const queryClient = useQueryClient();
  const users = useUsers();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<Role>("USER");
  const canCreate = Boolean(email) && password.length >= 8;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    await run(async () => {
      const name = displayName || email.split("@")[0]!;
      await api("/api/users", { method: "POST", body: JSON.stringify({ email, displayName: name, password, role }) });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("USER");
      setCreating(false);
      await refresh();
      // An administrator reaches everything; a standard user starts with nothing, and nothing says so.
      if (role === "USER") {
        const open = () => (scope ? useWorkspaceStore.getState().setAppSection(scope, "permissions") : useWorkspaceStore.getState().openApp("settings", "permissions"));
        toast(t("{name} can’t see any location yet. Give them access in Permissions.", { name }), "info", { action: { label: t("Open Permissions"), run: open } });
      }
    }, t("Couldn’t add the user"));
  }

  function startEdit(user: UserAccount) {
    setCreating(false);
    setEditing(user);
    setEditName(user.display_name);
    setEditRole(user.role);
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !editName.trim()) return;
    await run(async () => {
      await api(`/api/users/${editing.id}`, { method: "PATCH", body: JSON.stringify({ displayName: editName.trim(), role: editRole }) });
      setEditing(null);
      await refresh();
    }, t("Couldn’t save the user"));
  }

  async function setDisabled(user: UserAccount, disabled: boolean) {
    if (disabled && !(await confirmAction({ window: scope, title: t("Disable this user?"), subject: { icon: <KagoAvatar name={user.display_name || user.email} picture={avatarUrl(user.id, user.avatar_at)} className="size-12 text-base" />, name: user.display_name || user.email, detail: user.display_name ? user.email : undefined }, description: t("They are signed out everywhere, and the share links they created stop working until the account is enabled again."), confirmLabel: t("Disable"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await refresh();
    });
  }

  async function resetPassword(user: UserAccount) {
    const password = await promptText({ window: scope, title: t("Reset {name}’s password", { name: user.display_name }), description: t("At least 8 characters. This user is signed out everywhere and has to sign in again with the new password."), placeholder: t("New password"), confirmLabel: t("Reset password") });
    if (password === null) return;
    if (password.length < 8) {
      toast(t("The password needs at least 8 characters"), "error");
      return;
    }
    await run(async () => {
      await api(`/api/users/${user.id}/password`, { method: "POST", body: JSON.stringify({ password }) });
      toast(t("{name}’s password was reset", { name: user.display_name }));
    }, t("Couldn’t reset the password"));
  }

  async function unlinkSso(user: UserAccount) {
    if (!(await confirmAction({ window: scope, title: t("Unlink from single sign-on?"), subject: { icon: <KagoAvatar name={user.display_name || user.email} picture={avatarUrl(user.id, user.avatar_at)} className="size-12 text-base" />, name: user.display_name || user.email, detail: user.display_name ? user.email : undefined }, description: user.has_password ? t("They can still sign in with their password. Signing in through the provider again links it back if its email address is this account’s.") : t("This account has no password: nobody can sign in to it until you reset its password."), confirmLabel: t("Unlink"), destructive: true }))) return;
    await run(async () => {
      for (const identity of user.identities) await api(`/api/users/${user.id}/identities/${identity.id}`, { method: "DELETE" });
      await refresh();
    }, t("Couldn’t unlink the identity"));
  }

  return (
    <Page
      title={t("Users")}
      description={t("Administrators can reach every location; everyone else needs permission rules.")}
      actions={creating || editing ? null : <Button variant="default" onClick={() => { setEditing(null); setCreating(true); }}><Plus />{t("Add user")}</Button>}
    >
      {editing ? (
      <Card title={t("Edit {name}", { name: editing.display_name })} action={<KagoIconButton label={t("Cancel editing")} onClick={() => setEditing(null)}><X /></KagoIconButton>}>
        <form className="grid grid-cols-2 gap-3" onSubmit={saveEdit}>
          <Field label={t("Display name")}><Input autoFocus autoComplete="off" value={editName} onChange={(event) => setEditName(event.target.value)} /></Field>
          <Field label={t("Role")}>
            <Select value={editRole} onChange={(event) => setEditRole(event.target.value as Role)}>
              {(Object.keys(roleLabels) as Role[]).map((value) => <option key={value} value={value}>{roleLabels[value]}</option>)}
            </Select>
          </Field>
          <div className="col-span-2 flex justify-end"><Button type="submit" variant="default" disabled={!editName.trim()}>{t("Save")}</Button></div>
        </form>
      </Card>
      ) : null}
      {creating ? (
      <Card title={t("Add user")} action={<KagoIconButton label={t("Cancel adding")} onClick={() => setCreating(false)}><X /></KagoIconButton>}>
        <form className="grid grid-cols-2 gap-3" onSubmit={create}>
          <Field label="Email"><Input autoFocus type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label={t("Display name")}><Input autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          <Field label={t("Initial password")} hint={t("At least 8 characters")}><KagoPasswordInput autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Field label={t("Role")}>
            <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {(Object.keys(roleLabels) as Role[]).map((value) => <option key={value} value={value}>{roleLabels[value]}</option>)}
            </Select>
          </Field>
          <div className="col-span-2 flex justify-end"><Button type="submit" variant="default" disabled={!canCreate}>{t("Add user")}</Button></div>
        </form>
      </Card>
      ) : null}
      {users.isLoading ? <KagoLoading /> : null}
      {users.data?.length ? (
        <RowList>
          {users.data.map((user) => (
            <Row
              key={user.id}
              icon={<KagoAvatar name={user.display_name || user.email} picture={avatarUrl(user.id, user.avatar_at)} className={user.disabled ? "opacity-50" : undefined} />}
              title={user.display_name}
              // What kind of account it is reads as part of the line about it; only being switched off is set apart.
              subtitle={
                <>
                  {user.disabled ? <span className="text-danger">{t("Disabled")} · </span> : null}
                  {[user.email, roleLabels[user.role], user.identities.length > 0 ? (user.has_password ? t("Single sign-on") : t("Single sign-on only")) : null].filter(Boolean).join(" · ")}
                </>
              }
            >
              <Button onClick={() => startEdit(user)}>{t("Edit")}</Button>
              {user.identities.length > 0 ? <Button onClick={() => void unlinkSso(user)}>{t("Unlink")}</Button> : null}
              {user.id === currentUserId ? null : <Button onClick={() => void resetPassword(user)}>{t("Reset password")}</Button>}
              {user.id === currentUserId ? null : <Button onClick={() => void setDisabled(user, !user.disabled)}>{user.disabled ? t("Enable") : t("Disable")}</Button>}
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
