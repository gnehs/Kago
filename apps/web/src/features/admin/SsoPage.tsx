import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, X } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, useSsoConfig } from "@/api/hooks";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Card, Page, SettingRow } from "@/components/kago/page";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { copyText } from "@/lib/utils";
import { toast } from "@/stores/toast";
import type { SsoConfig } from "@/types/kago";
import { roleLabels } from "./UsersPage";

type Form = Omit<SsoConfig, "hasClientSecret" | "redirectUri">;

const formOf = ({ hasClientSecret: _hasClientSecret, redirectUri: _redirectUri, ...config }: SsoConfig): Form => ({
  ...config,
  // The address this page was opened at is the one people reach Kago by; it is only a suggestion until saved.
  publicUrl: config.publicUrl || location.origin
});

/** Where the provider is told to send people back to, worked out from what is typed so it can be registered before saving. */
function redirectUriOf(publicUrl: string): string | null {
  try {
    return `${new URL(publicUrl).origin}/api/auth/oidc/callback`;
  } catch {
    return null;
  }
}

/** Sign-in through an OpenID Connect provider: which one, who it may let in, and what its groups mean here. */
export function SsoPage() {
  const queryClient = useQueryClient();
  const saved = useSsoConfig();
  const groups = useGroups();
  const [form, setForm] = useState<Form | null>(null);
  // Never sent back by the server: empty means the one already kept stays.
  const [secret, setSecret] = useState("");
  const [forgetSecret, setForgetSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (saved.data) setForm((current) => current ?? formOf(saved.data));
  }, [saved.data]);

  if (!form || !saved.data) return <Page title={t("Single sign-on")}>{saved.isError ? <p className="m-0 text-danger">{t("Couldn’t load the single sign-on settings")}</p> : <KagoLoading />}</Page>;

  const set = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const setMapping = (index: number, patch: Partial<Form["groupMappings"][number]>) => set({ groupMappings: form.groupMappings.map((mapping, at) => (at === index ? { ...mapping, ...patch } : mapping)) });
  const redirectUri = redirectUriOf(form.publicUrl);
  const hasSecret = saved.data.hasClientSecret && !forgetSecret;
  const body = () =>
    JSON.stringify({
      ...form,
      // Rows still being filled in are not rules yet.
      groupMappings: form.groupMappings.filter((mapping) => mapping.external.trim() && mapping.groupId),
      clientSecret: secret ? secret : forgetSecret ? null : undefined
    });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    await run(async () => {
      const next = await api<SsoConfig>("/api/sso", { method: "PUT", body: body() });
      queryClient.setQueryData(["sso"], next);
      // The sign-in page learns of single sign-on from the same answer that says whether Kago is set up.
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      setForm(formOf(next));
      setSecret("");
      setForgetSecret(false);
      toast(next.enabled ? t("Single sign-on is on") : t("Single sign-on settings saved"));
    }, t("Couldn’t save the single sign-on settings"));
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    await run(async () => {
      const found = await api<{ issuer: string; unlistedScopes: string[] }>("/api/sso/test", { method: "POST", body: body() });
      if (found.unlistedScopes.length > 0) toast(t("The provider answered, but does not list these scopes: {scopes}", { scopes: found.unlistedScopes.join(", ") }), "error");
      else toast(t("The provider answered as {issuer}", { issuer: found.issuer }));
    }, t("Couldn’t reach the provider"));
    setBusy(false);
  }

  return (
    <Page title={t("Single sign-on")} description={t("Let people sign in through an OpenID Connect provider such as Pocket ID, Authentik or Keycloak. It only says who someone is; what they may do stays with Kago’s users, groups and permissions.")}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Card title={t("Provider")}>
          <div className="grid grid-cols-2 gap-3">
            <Checkbox className="col-span-2" label={t("Offer single sign-on on the sign-in page")} checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
            <Field label={t("Issuer URL")} hint={t("The provider’s address, as its own settings show it.")} className="col-span-2">
              <Input type="url" autoComplete="off" spellCheck={false} placeholder="https://id.example.com" value={form.issuer} onChange={(event) => set({ issuer: event.target.value })} />
            </Field>
            <Field label={t("Client ID")}>
              <Input autoComplete="off" spellCheck={false} value={form.clientId} onChange={(event) => set({ clientId: event.target.value })} />
            </Field>
            <Field label={t("Client secret")} hint={hasSecret ? t("One is saved. Type a new one to replace it.") : t("Leave empty for a public client, which PKCE alone protects.")}>
              <div className="flex gap-2">
                <KagoPasswordInput autoComplete="new-password" placeholder={hasSecret ? "••••••••" : ""} value={secret} onChange={(event) => setSecret(event.target.value)} />
                {hasSecret && !secret ? <Button onClick={() => setForgetSecret(true)}>{t("Remove")}</Button> : null}
              </div>
            </Field>
            <Field label={t("Name on the sign-in button")} hint={t("For example “Pocket ID”.")}>
              <Input autoComplete="off" maxLength={60} value={form.name} onChange={(event) => set({ name: event.target.value })} />
            </Field>
            <Field label={t("Scopes")} hint={t("Add what the provider needs for groups (often “groups”), and “offline_access” to have sessions checked with it as they go.")}>
              <Input autoComplete="off" spellCheck={false} value={form.scopes} onChange={(event) => set({ scopes: event.target.value })} />
            </Field>
            <Field label={t("Kago’s address")} hint={t("Where people reach Kago. The provider sends them back here.")} className="col-span-2">
              <Input type="url" autoComplete="off" spellCheck={false} value={form.publicUrl} onChange={(event) => set({ publicUrl: event.target.value })} />
            </Field>
            {redirectUri ? (
              <div className="col-span-2 flex flex-col gap-1.5">
                <span className="text-xs text-muted">{t("Register this redirect URI with the provider:")}</span>
                <div className="flex items-center gap-2">
                  <code className="kago-well min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-xs">{redirectUri}</code>
                  <Button onClick={() => void copyText(redirectUri).then(() => setCopied(true))}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? t("Copied") : t("Copy")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <Card title={t("Accounts")} description={t("An identity signs in to the Kago account it is linked to. One seen for the first time is linked to the account with the same email address, if the provider says the address is verified.")}>
          <div className="flex flex-col gap-4">
            <SettingRow label={t("Create accounts for new people")} description={t("Off, only people who already have a Kago account can sign in this way. On, anyone else the provider lets through gets a new one.")}>
              <Checkbox label={t("Create automatically")} checked={form.autoCreate} onChange={(event) => set({ autoCreate: event.target.checked })} />
            </SettingRow>
            {form.autoCreate ? (
              <SettingRow label={t("Role of new accounts")} description={t("Nobody becomes an administrator this way; that is given by hand under Users.")}>
                <Select aria-label={t("Role of new accounts")} className="w-40" value={form.defaultRole} onChange={(event) => set({ defaultRole: event.target.value as Form["defaultRole"] })}>
                  <option value="USER">{roleLabels.USER}</option>
                  <option value="GUEST">{roleLabels.GUEST}</option>
                </Select>
              </SettingRow>
            ) : null}
            <SettingRow label={t("Go straight to the provider")} description={t("Someone who is not signed in is sent to the provider without seeing Kago’s sign-in page. The password form stays at /login?local=1.")}>
              <Checkbox label={t("Redirect automatically")} checked={form.autoRedirect} onChange={(event) => set({ autoRedirect: event.target.checked })} />
            </SettingRow>
          </div>
        </Card>

        <Card title={t("Groups")} description={t("Put people into Kago’s groups by the groups the provider reports. Memberships given by hand are left alone.")}>
          <div className="flex flex-col gap-4">
            <SettingRow label={t("Sync groups at sign-in")} description={t("Only the groups mapped below are touched. A provider’s group never makes anyone an administrator.")}>
              <Checkbox label={t("Sync groups")} checked={form.syncGroups} onChange={(event) => set({ syncGroups: event.target.checked })} />
            </SettingRow>
            {form.syncGroups ? (
              <>
                <Field label={t("Groups claim")} hint={t("The name under which the provider lists someone’s groups.")}>
                  <Input autoComplete="off" spellCheck={false} className="max-w-60" value={form.groupsClaim} onChange={(event) => set({ groupsClaim: event.target.value })} />
                </Field>
                {form.groupMappings.length > 0 ? (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {form.groupMappings.map((mapping, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <Input aria-label={t("Group at the provider")} autoComplete="off" spellCheck={false} placeholder={t("Group at the provider")} value={mapping.external} onChange={(event) => setMapping(index, { external: event.target.value })} />
                        <span className="shrink-0 text-muted" aria-hidden>→</span>
                        <Select aria-label={t("Group in Kago")} value={mapping.groupId} onChange={(event) => setMapping(index, { groupId: event.target.value })}>
                          <option value="">{t("Choose a group")}</option>
                          {groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                        </Select>
                        <KagoIconButton label={t("Remove this mapping")} onClick={() => set({ groupMappings: form.groupMappings.filter((_mapping, at) => at !== index) })}><X /></KagoIconButton>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex items-center gap-3">
                  <Button disabled={!groups.data?.length} onClick={() => set({ groupMappings: [...form.groupMappings, { external: "", groupId: "" }] })}><Plus />{t("Add mapping")}</Button>
                  {groups.data?.length === 0 ? <span className="text-xs text-muted">{t("Add a group under Groups first.")}</span> : null}
                </div>
              </>
            ) : null}
          </div>
        </Card>

        <Card title={t("If the provider is down")}>
          <p className="m-0 text-muted">{t("Signing in with a password keeps working at /login?local=1 for every account that has one. An administrator who cannot sign in at all can be given a new password on the server itself:")}</p>
          <code className="kago-well mt-2 block truncate rounded-md px-2.5 py-1.5 text-xs">docker exec -it kago kago-entrypoint node dist/recover.js you@example.com</code>
        </Card>

        <div className="flex justify-end gap-2">
          <Button disabled={busy || !form.issuer} onClick={() => void test()}>{t("Test connection")}</Button>
          <Button type="submit" variant="default" disabled={busy}>{t("Save")}</Button>
        </div>
      </form>
    </Page>
  );
}
