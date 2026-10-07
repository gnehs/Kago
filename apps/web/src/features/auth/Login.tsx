import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/format";
import { AuthCard, FormError } from "./AuthCard";
import { t } from "@/lib/i18n";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    } catch (err) {
      setError(errorMessage(err, t("Couldn’t sign in")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Kago" subtitle={t("Sign in to continue")}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Email">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus />
        </Field>
        <Field label={t("Password")}>
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="default" size="lg" className="mt-1" disabled={busy || !email || !password}>
          {t("Sign in")}
        </Button>
      </form>
    </AuthCard>
  );
}
