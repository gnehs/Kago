import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/format";
import { AuthCard, FormError } from "./AuthCard";

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
      setError(errorMessage(err, "初始化失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="歡迎使用 Kago" subtitle="建立第一位管理員">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Email">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label="顯示名稱">
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
        </Field>
        <Field label="密碼" hint="至少 8 個字元">
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="default" size="lg" className="mt-1" disabled={busy || !email || password.length < 8}>
          建立管理員
        </Button>
      </form>
    </AuthCard>
  );
}
