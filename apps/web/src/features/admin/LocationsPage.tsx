import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HardDrive, Plus, Server, X } from "lucide-react";
import { api } from "@/api/client";
import { useStorage } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { SshKeyNote } from "@/features/sync/SshKeyNote";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { RemoteField, RemoteProvider, RemoteRoot, Root } from "@/types/kago";
import { t } from "@/lib/i18n";

/** The server names each field in English; this is how the interface words them. */
const fieldLabels: Record<string, string> = {
  Server: t("Server"),
  Port: t("Port"),
  Username: t("Username"),
  Password: t("Password"),
  Domain: t("Domain"),
  Address: t("Address"),
  "Server software": t("Server software"),
  "Sign in with Kago's SSH key": t("Sign in with Kago’s SSH key"),
  "Use TLS": t("Use TLS"),
  "Share and folder": t("Share and folder"),
  Folder: t("Folder"),
  Other: t("Other"),
  "Leave empty to show every share of the server.": t("Leave empty to show every share of the server.")
};
const label = (text: string) => fieldLabels[text] ?? text;

export function LocationsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const storage = useStorage();
  // `true` is a new location; a root is one being edited.
  const [editing, setEditing] = useState<RemoteRoot | true | null>(null);
  const refresh = () => Promise.all(["roots", "storage", "fs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const providers = storage.data?.providers ?? [];
  const providerLabel = (type: string) => providers.find((provider) => provider.type === type)?.label ?? type;
  const canAdd = Boolean(storage.data?.available) && providers.length > 0;

  async function setRootReadonly(root: Root, next: boolean) {
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "PATCH", body: JSON.stringify({ readonly: next }) });
      await refresh();
    });
  }

  async function remove(root: Root) {
    if (!(await confirmAction({ title: t("Remove {name}?", { name: root.name }), description: t("Its files stay where they are. Share links, permission rules and tags that point into it are removed."), confirmLabel: t("Remove"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "DELETE" });
      setEditing(null);
      await refresh();
    });
  }

  return (
    <Page
      title={t("Locations")}
      description={t("Every folder mounted under /data becomes a location. Folders on other machines can be added as remote locations.")}
      actions={canAdd && !editing ? <Button variant="default" onClick={() => setEditing(true)}><Plus />{t("Add remote location")}</Button> : null}
    >
      {storage.data && !storage.data.available ? <p className="m-0 text-muted">{t("Remote locations need rclone, which this server does not have.")}</p> : null}
      {editing ? (
        <Card
          title={editing === true ? t("Add remote location") : t("Connection of {name}", { name: editing.name })}
          action={<KagoIconButton label={t("Close")} onClick={() => setEditing(null)}><X /></KagoIconButton>}
        >
          <RemoteForm key={editing === true ? "new" : editing.id} providers={providers} root={editing === true ? null : editing} onSaved={async () => { setEditing(null); await refresh(); }} />
        </Card>
      ) : null}
      {roots.length > 0 ? (
        <RowList>
          {roots.map((root) => {
            const remote = storage.data?.roots.find((item) => item.id === root.id);
            return (
              <Row key={root.id} icon={root.provider === "local" ? <HardDrive /> : <Server />} title={root.name} subtitle={root.provider === "local" ? root.slug : `${providerLabel(root.provider)} · ${remoteAddress(remote)}`}>
                {root.readonly ? <KagoBadge>{t("Read-only")}</KagoBadge> : null}
                <Button onClick={() => void setRootReadonly(root, !root.readonly)}>{root.readonly ? t("Allow writing") : t("Make read-only")}</Button>
                {remote ? <Button onClick={() => setEditing(remote)}>{t("Edit")}</Button> : null}
                {root.provider !== "local" ? <Button variant="destructive" onClick={() => void remove(root)}>{t("Remove")}</Button> : null}
              </Row>
            );
          })}
        </RowList>
      ) : (
        <KagoEmptyState icon={<HardDrive />} title={t("No locations yet")} description={t("Create or mount a folder under /data and it will show up here.")}>
          {canAdd && !editing ? <Button variant="default" onClick={() => setEditing(true)}><Plus />{t("Add remote location")}</Button> : null}
        </KagoEmptyState>
      )}
    </Page>
  );
}

/** Where a remote location points, as one line: the machine, then the folder on it. */
function remoteAddress(root?: RemoteRoot) {
  if (!root) return "";
  const host = root.remote.params.host ?? root.remote.params.url ?? "";
  return [host, root.remote.base].filter(Boolean).join(host && !host.includes("/") && !root.remote.base.startsWith("/") ? "/" : " · ");
}

function RemoteForm({ providers, root, onSaved }: { providers: RemoteProvider[]; root: RemoteRoot | null; onSaved: () => Promise<void> }) {
  const [type, setType] = useState(root?.remote.type ?? providers[0]?.type ?? "");
  const [name, setName] = useState(root?.name ?? "");
  const [base, setBase] = useState(root?.remote.base ?? "");
  const [params, setParams] = useState<Record<string, string | boolean>>(() => ({ ...root?.remote.params, ...(root?.remote.params.key_file ? { key_file: true } : {}) }));
  const [readonly, setReadonly] = useState(false);
  const [busy, setBusy] = useState(false);
  const provider = providers.find((item) => item.type === type);
  if (!provider) return null;

  const config = { type, base, params };
  const kept = (field: RemoteField) => field.kind === "secret" && Boolean(root?.remote.secrets.includes(field.key));
  const missing = provider.fields.some((field) => field.required && !params[field.key] && !kept(field)) || (provider.path.required && !base.trim());
  const canSubmit = !missing && name.trim().length > 0 && !busy;
  const set = (key: string, value: string | boolean) => setParams((current) => ({ ...current, [key]: value }));

  async function test() {
    setBusy(true);
    await run(async () => {
      const result = await api<{ ok: boolean; error?: string }>("/api/storage/test", { method: "POST", body: JSON.stringify({ rootId: root?.id, config }) });
      if (result.ok) toast(t("Connected"));
      // The reason is the remote's own, in its own words.
      else toast(t("Couldn’t connect: {reason}", { reason: result.error ?? "" }), "error");
    });
    setBusy(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    const saved = await run(async () => {
      if (root) await api(`/api/roots/${root.id}/remote`, { method: "PUT", body: JSON.stringify({ name: name.trim(), config }) });
      else await api("/api/roots/remote", { method: "POST", body: JSON.stringify({ name: name.trim(), readonly, config }) });
      return true;
    }, t("Couldn’t save the location"));
    setBusy(false);
    if (saved) await onSaved();
  }

  return (
    <form className="grid grid-cols-2 gap-3" onSubmit={submit}>
      {/* What kind of remote a location is stays what it was made as; everything else about it can be changed. */}
      {root ? null : (
        <Field label={t("Kind")}>
          <Select value={type} onChange={(event) => { setType(event.target.value); setParams({}); setBase(""); }}>
            {providers.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label={t("Name")} className={root ? "col-span-2" : undefined}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {provider.fields.map((field) =>
        field.kind === "boolean" ? (
          <Checkbox key={field.key} className="col-span-2" label={label(field.label)} checked={Boolean(params[field.key])} onChange={(event) => set(field.key, event.target.checked)} />
        ) : (
          <Field key={field.key} label={label(field.label)}>
            {field.kind === "select" ? (
              <Select value={String(params[field.key] ?? field.options?.[0]?.value ?? "")} onChange={(event) => set(field.key, event.target.value)}>
                {field.options?.map((option) => <option key={option.value} value={option.value}>{label(option.label)}</option>)}
              </Select>
            ) : (
              <Input
                type={field.kind === "secret" ? "password" : "text"}
                inputMode={field.kind === "number" ? "numeric" : undefined}
                autoComplete={field.kind === "secret" ? "new-password" : "off"}
                value={String(params[field.key] ?? "")}
                placeholder={kept(field) ? t("Unchanged") : field.placeholder}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}
          </Field>
        )
      )}
      <Field label={label(provider.path.label)} hint={provider.path.hint ? label(provider.path.hint) : undefined} className="col-span-2"><Input value={base} placeholder={provider.path.placeholder} onChange={(event) => setBase(event.target.value)} /></Field>
      {type === "sftp" && params.key_file ? <SshKeyNote className="col-span-2" /> : null}
      {root ? null : <Checkbox className="col-span-2" label={t("Read-only")} checked={readonly} onChange={(event) => setReadonly(event.target.checked)} />}
      <div className="col-span-2 flex justify-end gap-2">
        <Button disabled={missing || busy} onClick={() => void test()}>{t("Test connection")}</Button>
        <Button type="submit" variant="default" disabled={!canSubmit}>{root ? t("Save") : t("Add location")}</Button>
      </div>
    </form>
  );
}
