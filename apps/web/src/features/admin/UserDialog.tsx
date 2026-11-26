import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { KagoSpinner } from "@/components/kago/empty-state";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { useWindowScope } from "@/components/kago/window-scope";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { personName } from "@/lib/peopleModel";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";
import { useWorkspaceStore } from "@/stores/workspace";
import type { UserAccount } from "@/types/kago";
import { roleLabels, type Role } from "./roles";
import { t } from "@/lib/i18n";

const MIN_PASSWORD = 8;

/** A user being made when `user` is null, otherwise the one being changed. */
export type UserDialogTarget = { user: UserAccount | null; /** The only enabled administrator: their role stays. */ lastAdmin?: boolean };

/** Adds a user, or changes the name and role of one. Where they are made they are told who can reach nothing yet. */
export function UserDialog({ target, onClose }: { target: UserDialogTarget | null; onClose: () => void }) {
  return (
    <KagoDialog open={target !== null} onClose={onClose} title={target?.user ? t("Edit {name}", { name: personName(target.user) }) : t("Add user")} className="w-[min(440px,calc(100%-32px))]">
      {target ? <UserForm key={target.user?.id ?? "new"} target={target} onClose={onClose} /> : null}
    </KagoDialog>
  );
}

function UserForm({ target, onClose }: { target: UserDialogTarget; onClose: () => void }) {
  const { user, lastAdmin } = target;
  const scope = useWindowScope();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(user?.role ?? "USER");
  const [busy, setBusy] = useState(false);

  // Said beside the button when it cannot be pressed, so that it is never dead without a reason.
  const problem = user
    ? displayName.trim() ? null : t("Enter a display name")
    : !email.includes("@") ? t("Enter an email address") : password.length < MIN_PASSWORD ? t("The password needs at least {count} characters", { count: MIN_PASSWORD }) : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    const saved = await run(async () => {
      if (user) {
        await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ displayName: displayName.trim(), role }) });
      } else {
        await api("/api/users", { method: "POST", body: JSON.stringify({ email, displayName: displayName.trim() || email.split("@")[0]!, password, role }) });
      }
      await queryClient.invalidateQueries({ queryKey: keys.users() });
      return true;
    }, user ? t("Couldn’t save the user") : t("Couldn’t add the user"));
    setBusy(false);
    if (!saved) return;
    onClose();
    // An administrator reaches everything; a standard user starts with nothing, and nothing says so.
    if (!user && role === "USER") {
      const name = displayName.trim() || email.split("@")[0]!;
      const open = () => (scope ? useWorkspaceStore.getState().setAppSection(scope, "permissions") : useWorkspaceStore.getState().openApp("settings", "permissions"));
      toast(t("{name} can’t see any location yet. Give them access in Permissions.", { name }), "info", { action: { label: t("Open Permissions"), run: open } });
    }
  }

  return (
    <form className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3" onSubmit={submit}>
      {user ? (
        <div className="flex min-w-0 items-center gap-2.5">
          <KagoAvatar name={personName(user)} picture={avatarUrl(user.id, user.avatar_at)} className="size-8" />
          <span className="min-w-0 truncate text-muted" title={user.email}>{user.email}</span>
        </div>
      ) : (
        <Field label="Email"><Input autoFocus type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
      )}
      <Field label={t("Display name")} hint={user ? undefined : t("Left empty, the part of the email before the @")}>
        <Input autoFocus={Boolean(user)} autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </Field>
      {user ? null : (
        <Field label={t("Initial password")} hint={t("At least {count} characters", { count: MIN_PASSWORD })}>
          <KagoPasswordInput autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
      )}
      <Field label={t("Role")} hint={lastAdmin ? t("The only enabled administrator can’t be made a standard user.") : undefined}>
        <Select value={role} disabled={lastAdmin} onChange={(event) => setRole(event.target.value as Role)}>
          {(Object.keys(roleLabels) as Role[]).map((value) => <option key={value} value={value}>{roleLabels[value]}</option>)}
        </Select>
      </Field>
      <KagoDialogActions>
        {problem ? <span role="status" className="mr-auto flex min-w-0 items-center text-xs text-muted">{problem}</span> : null}
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={Boolean(problem) || busy}>{busy ? <KagoSpinner className="text-inherit" /> : null}{user ? t("Save") : t("Add user")}</Button>
      </KagoDialogActions>
    </form>
  );
}
