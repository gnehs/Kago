import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useSetupStatus } from "@/api/hooks";
import { KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/format";
import { AuthCard, FormError } from "@/components/kago/auth-card";
import { readSsoReturn, signedOutHere, ssoErrorMessage, ssoLabel, ssoStartUrl } from "./sso";
import { t } from "@/lib/i18n";

export function Login() {
  const sso = useSetupStatus().data?.oidc ?? null;
  // Decided once, as the page opens. The password form is always there to fall back on: `?local=1` asks for it, and
  // a sign-in that the provider turned down, or one that has just been signed out of, is not sent round again.
  const [came] = useState(readSsoReturn);
  const [leaving] = useState(() => Boolean(sso?.autoRedirect) && !came.error && !new URLSearchParams(location.search).has("local") && !signedOutHere());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() => (came.error ? ssoErrorMessage(came.error) : ""));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (leaving) location.replace(ssoStartUrl());
  }, [leaving]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    } catch (err) {
      setError(errorMessage(err, t("Couldn’t sign in")));
      setRefused((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  if (leaving) return <div className="h-full bg-canvas"><KagoLoading /></div>;

  return (
    <AuthCard title="Kago" subtitle={t("Sign in to continue")} refused={refused}>
      {sso ? (
        <div className="mb-4 flex flex-col gap-4">
          <Button variant="default" size="lg" onClick={() => location.assign(ssoStartUrl())}>{ssoLabel(sso)}</Button>
          <div className="flex items-center gap-3 text-xs text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">{t("or with a password")}</div>
        </div>
      ) : null}
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Email">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus={!sso} />
        </Field>
        <Field label={t("Password")}>
          <KagoPasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant={sso ? "outline" : "default"} size="lg" className="mt-1" disabled={busy || !email || !password}>
          {busy ? <KagoSpinner className="text-inherit" /> : null}
          {t("Sign in")}
        </Button>
      </form>
    </AuthCard>
  );
}
