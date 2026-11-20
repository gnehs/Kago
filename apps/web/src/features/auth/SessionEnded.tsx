import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useSetupStatus } from "@/api/hooks";
import { FormError } from "@/components/kago/auth-card";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoSpinner } from "@/components/kago/empty-state";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { errorMessage } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Actor } from "@/types/kago";
import { ssoLabel, ssoStartUrl } from "./sso";

/**
 * Asks for the password again over the desktop when the session ends under it: signed out from elsewhere, reset or
 * expired. The windows stay as they are behind it, so what was being written in one is still there afterwards.
 */
export function SessionEnded({ open, user }: { open: boolean; user: Actor }) {
  const queryClient = useQueryClient();
  const sso = useSetupStatus().data?.oidc ?? null;
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: user.email, password }) });
      setPassword("");
      // Everything asked for while signed out was refused, and is read again.
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err, t("Couldn’t sign in")));
    } finally {
      setBusy(false);
    }
  }

  return (
    // It has no way out but signing in: Escape and a click outside leave it where it is.
    <KagoDialog question scope={null} open={open} onClose={() => undefined} title={t("Your session has ended")}>
      <form className="flex min-h-0 flex-col" onSubmit={submit}>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-5">
          <p className="m-0 text-center text-muted text-pretty">{t("Sign in again as {email} to carry on. What you have open stays as it is.", { email: user.email })}</p>
          <Field label={t("Password")}>
            <KagoPasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />
          </Field>
          <FormError message={error} />
          {sso ? (
            <Button variant="outline" onClick={() => location.assign(ssoStartUrl())}>{ssoLabel(sso)}</Button>
          ) : null}
        </div>
        <footer className="grid shrink-0 grid-cols-2 gap-2 rounded-b-lg border-t border-line bg-elevated p-3">
          <Button size="lg" onClick={() => location.assign("/login?local=1")}>{t("Use another account")}</Button>
          <Button size="lg" type="submit" variant="default" disabled={busy || !password}>
            {busy ? <KagoSpinner className="text-inherit" /> : null}
            {t("Sign in")}
          </Button>
        </footer>
      </form>
    </KagoDialog>
  );
}
