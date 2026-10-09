import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { useIdentities } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoBadge } from "@/components/kago/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { roleLabels } from "@/features/admin/UsersPage";
import { Card, Page, Row, RowList, SettingRow } from "@/components/kago/page";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { Actor, SsoIdentity } from "@/types/kago";
import { setAvatar } from "./avatar";
import { startSsoLink } from "./sso";

/** The host of an issuer, which is how people know their provider; the whole of it when it is not an address. */
const issuerName = (issuer: string) => {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
};

/** The account of the person signed in: who they are to everyone else, and the ways into it. */
export function AccountPage({ user }: { user: Actor }) {
  const queryClient = useQueryClient();
  const account = useIdentities();
  // An account made through single sign-on has no password until one is set here; there is no current one to ask for.
  const hasPassword = account.data?.hasPassword ?? true;
  const identities = account.data?.identities ?? [];
  const sso = account.data?.sso ?? null;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit = (Boolean(currentPassword) || !hasPassword) && newPassword.length >= 8 && confirmPassword === newPassword;

  async function unlink(identity: SsoIdentity) {
    if (!(await confirmAction({ title: t("Unlink {provider}?", { provider: issuerName(identity.issuer) }), description: t("Other devices signed in through it are signed out. Signing in through it again links it back if its email address is this account’s."), confirmLabel: t("Unlink"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/auth/identities/${identity.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["auth", "identities"] });
    }, t("Couldn’t unlink the identity"));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: hasPassword ? currentPassword : undefined, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await queryClient.invalidateQueries({ queryKey: ["auth", "identities"] });
      toast(t("Password updated. Other devices have been signed out"));
    } catch (error) {
      toast(error instanceof ApiError && error.code === "INVALID_CURRENT_PASSWORD" ? t("The current password is incorrect") : t("Couldn’t change the password"), "error");
    }
  }

  return (
    <Page title={t("Account")} description={t("Who you are in Kago, and how you sign in.")}>
      <Card>
        <div className="flex items-center gap-3">
          <KagoAvatar name={user.displayName || user.email} picture={avatarUrl(user.id, user.avatar)} className="size-12 text-base" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{user.displayName}</span>
            <span className="truncate text-xs text-muted">{user.email}</span>
          </div>
          <KagoBadge tone={user.role === "ADMIN" ? "accent" : "neutral"}>{roleLabels[user.role]}</KagoBadge>
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <SettingRow label={t("Profile picture")} description={t("Right-click a picture in any folder and choose “Set as profile picture”. Kago keeps its own copy.")}>
            <Button variant="outline" disabled={!user.avatar} onClick={() => void run(() => setAvatar(queryClient, null))}>{user.avatar ? t("Remove") : t("None set")}</Button>
          </SettingRow>
        </div>
      </Card>
      {sso || identities.length > 0 ? (
        <Card title={t("Single sign-on")}>
          <div className="flex flex-col gap-3">
            {identities.length > 0 ? (
              <RowList bare>
                {identities.map((identity) => (
                  <Row key={identity.id} icon={<Fingerprint />} title={issuerName(identity.issuer)} subtitle={identity.email ?? identity.displayName ?? identity.subject}>
                    <Button variant="destructive" onClick={() => void unlink(identity)}>{t("Unlink")}</Button>
                  </Row>
                ))}
              </RowList>
            ) : null}
            {sso ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted">{identities.length > 0 ? t("You can sign in to this account through the identities above.") : t("Link your identity at the provider to sign in to this account without its password.")}</span>
                <Button onClick={() => void run(startSsoLink, t("Couldn’t start linking"))}>{identities.length > 0 ? t("Link another") : sso.name ? t("Link {name}", { name: sso.name }) : t("Link an identity")}</Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
      <Card title={t("Password")}>
        <form className="grid grid-cols-2 gap-3" onSubmit={submit}>
          {hasPassword ? (
            <Field label={t("Current password")} className="col-span-2 @md:col-span-1">
              <KagoPasswordInput autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </Field>
          ) : (
            <p className="col-span-2 m-0 text-xs text-muted">{t("This account has no password yet: it is signed in to through single sign-on only. Setting one gives it a second way in.")}</p>
          )}
          <Field label={t("New password")} hint={tooShort ? t("At least 8 characters") : undefined} className="col-start-1">
            <KagoPasswordInput autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </Field>
          <Field label={t("Confirm new password")} hint={mismatch ? t("The passwords don’t match") : undefined}>
            <KagoPasswordInput autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </Field>
          <div className="col-span-2 flex items-center justify-between gap-3">
            <span className="text-xs text-muted">{t("Other devices are signed out after the change.")}</span>
            <Button type="submit" variant="default" disabled={!canSubmit}>{hasPassword ? t("Change password") : t("Set a password")}</Button>
          </div>
        </form>
      </Card>
    </Page>
  );
}
