import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "@/api/client";
import { useUsers } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoBadge } from "@/components/kago/badge";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import { confirmAction, promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { UserAccount } from "@/types/kago";
import { t } from "@/lib/i18n";

type Role = UserAccount["role"];
export const roleLabels: Record<Role, string> = { ADMIN: t("Administrator"), USER: t("Standard user"), GUEST: t("Guest") };

export function UsersPage({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const [creating, setCreating] = useState(false);
  const canCreate = Boolean(email) && password.length >= 8;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    await run(async () => {
      await api("/api/users", { method: "POST", body: JSON.stringify({ email, displayName: displayName || email.split("@")[0], password, role }) });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("USER");
      setCreating(false);
      await refresh();
    }, t("Couldn’t add the user"));
  }

  async function setDisabled(user: UserAccount, disabled: boolean) {
    await run(async () => {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await refresh();
    });
  }

  async function resetPassword(user: UserAccount) {
    const password = await promptText({ title: t("Reset {name}’s password", { name: user.display_name }), description: t("At least 8 characters. This user is signed out everywhere and has to sign in again with the new password."), placeholder: t("New password"), confirmLabel: t("Reset password") });
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
    if (!(await confirmAction({ title: t("Unlink {name} from single sign-on?", { name: user.display_name }), description: user.has_password ? t("They can still sign in with their password. Signing in through the provider again links it back if its email address is this account’s.") : t("This account has no password: nobody can sign in to it until you reset its password."), confirmLabel: t("Unlink"), destructive: true }))) return;
    await run(async () => {
      for (const identity of user.identities) await api(`/api/users/${user.id}/identities/${identity.id}`, { method: "DELETE" });
      await refresh();
    }, t("Couldn’t unlink the identity"));
  }

  return (
    <Page
      title={t("Users")}
      description={t("Administrators can reach every location; other roles need permission rules.")}
      actions={creating ? null : <Button variant="default" onClick={() => setCreating(true)}><Plus />{t("Add user")}</Button>}
    >
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
            <Row key={user.id} icon={<KagoAvatar name={user.display_name || user.email} picture={avatarUrl(user.id, user.avatar_at)} />} title={user.display_name} subtitle={user.email}>
              <KagoBadge tone={user.role === "ADMIN" ? "accent" : "neutral"}>{roleLabels[user.role]}</KagoBadge>
              {user.identities.length > 0 ? <KagoBadge>{user.has_password ? t("Single sign-on") : t("Single sign-on only")}</KagoBadge> : null}
              {user.disabled ? <KagoBadge tone="danger">{t("Disabled")}</KagoBadge> : null}
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
