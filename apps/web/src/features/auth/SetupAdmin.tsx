import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { KagoSpinner } from "@/components/kago/empty-state";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/format";
import { AuthCard, FormError } from "./AuthCard";
import { t } from "@/lib/i18n";

export function SetupAdmin() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ email, displayName: displayName || email.split("@")[0] || "Admin", password })
      });
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
    } catch (err) {
      setError(errorMessage(err, t("Setup failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t("Welcome to Kago")} subtitle={t("Create the first administrator")}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Email">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label={t("Display name")}>
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
        </Field>
        <Field label={t("Password")} hint={t("At least 8 characters")}>
          <KagoPasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="default" size="lg" className="mt-1" disabled={busy || !email || password.length < 8}>
          {busy ? <KagoSpinner className="text-inherit" /> : null}
          {t("Create administrator")}
        </Button>
      </form>
    </AuthCard>
  );
}
