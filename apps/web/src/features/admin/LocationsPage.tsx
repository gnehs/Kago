import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, Globe, HardDrive, Lock, Network, Plus, Server, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { api } from "@/api/client";
import { useStorage } from "@/api/hooks";
import { KagoChoice } from "@/components/kago/choice";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FieldGroup, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Card, Page, Row, RowList, Section } from "@/components/kago/page";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { RemoteField, RemoteProvider, RemoteRoot, Root } from "@/types/kago";
import { SshKeyNote } from "./SshKeyNote";
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
    if (!(await confirmAction({ title: t("Remove this location?"), subject: { icon: <KagoStatusIcon large>{root.readonly ? <Lock /> : <Server />}</KagoStatusIcon>, name: root.name, detail: [providerLabel(root.provider), remoteAddress(storage.data?.roots.find((item) => item.id === root.id))].filter(Boolean).join(" · ") }, description: t("Its files stay where they are. Share links, permission rules and tags that point into it are removed."), confirmLabel: t("Remove"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "DELETE" });
      setEditing(null);
      await refresh();
    });
  }

  // Kago's own rules cannot give what the disk withholds from the account the server runs as, so that is said here, where it is set up.
  const refusal = (root: Root) => {
    const access = storage.data?.local.find((item) => item.id === root.id);
    if (!access) return null;
    return !access.readable ? "read" : !access.writable && !root.readonly ? "write" : null;
  };
  const account = storage.data?.account;

  const local = roots.filter((root) => root.provider === "local");
  const remote = roots.filter((root) => root.provider !== "local");
  const addButton = canAdd && !editing ? <Button variant="default" onClick={() => setEditing(true)}><Plus />{t("Add remote location")}</Button> : null;
  /** What stands in the way of using a location, said before its address: the disk refusing Kago, or the location being read-only. */
  const hindrance = (root: Root, refused: "read" | "write" | null = null) =>
    refused === "read" ? <span className="text-danger">{t("No permission to read")} · </span> : refused === "write" ? <span className="text-warning">{t("No permission to write")} · </span> : root.readonly ? `${t("Read-only")} · ` : null;
  const readonlyButton = (root: Root) => <Button onClick={() => void setRootReadonly(root, !root.readonly)}>{root.readonly ? t("Allow writing") : t("Make read-only")}</Button>;

  return (
    <Page title={t("Locations")}>
      {/* A local location is a folder the server already has: it comes and goes with /data, and only how it is used is set here. */}
      <Section title={t("Local locations")} description={t("Every folder mounted under /data becomes a location.")}>
        {local.length > 0 ? (
          <RowList>
            {local.map((root) => (
              <Row
                key={root.id}
                icon={
                  refusal(root) ? (
                    <KagoStatusIcon tone={refusal(root) === "read" ? "danger" : "warning"} label={refusal(root) === "read" ? t("No permission to read") : t("No permission to write")}><TriangleAlert /></KagoStatusIcon>
                  ) : (
                    <KagoStatusIcon label={root.readonly ? t("Read-only") : undefined}>{root.readonly ? <Lock /> : <HardDrive />}</KagoStatusIcon>
                  )
                }
                title={root.name}
                subtitle={<>{hindrance(root, refusal(root))}{root.slug}</>}
              >
                {readonlyButton(root)}
              </Row>
            ))}
          </RowList>
        ) : (
          <KagoEmptyState className="kago-card rounded-lg border border-line" icon={<HardDrive />} title={t("No local locations yet")} description={t("Create or mount a folder under /data and it will show up here.")} />
        )}
        {account && local.some(refusal) ? (
          <p className="m-0 text-xs text-muted">
            {t("Kago runs on the server as UID {uid}, GID {gid}, and the disk doesn’t let that account into the folders marked above. On the host, give it access to them, or set PUID / PGID to the account that owns them. A location that is only meant to be read can be made read-only instead.", account)}
          </p>
        ) : null}
      </Section>
      {/* A remote location is a connection Kago keeps: it is added, edited and removed here. */}
      <Section title={t("Remote locations")} description={t("Folders on other machines, reached over the network.")} action={remote.length > 0 ? addButton : null}>
        {storage.data && !storage.data.available ? <p className="m-0 text-muted">{t("Remote locations need rclone, which this server does not have.")}</p> : null}
        {editing ? (
          <Card
            title={editing === true ? t("Add remote location") : t("Connection of {name}", { name: editing.name })}
            action={<KagoIconButton label={t("Close")} onClick={() => setEditing(null)}><X /></KagoIconButton>}
          >
            <RemoteForm key={editing === true ? "new" : editing.id} providers={providers} root={editing === true ? null : editing} onSaved={async () => { setEditing(null); await refresh(); }} />
          </Card>
        ) : null}
        {remote.length > 0 ? (
          <RowList>
            {remote.map((root) => {
              const connection = storage.data?.roots.find((item) => item.id === root.id);
              return (
                <Row key={root.id} icon={<KagoStatusIcon label={root.readonly ? t("Read-only") : undefined}>{root.readonly ? <Lock /> : <Server />}</KagoStatusIcon>} title={root.name} subtitle={<>{hindrance(root)}{[providerLabel(root.provider), remoteAddress(connection)].filter(Boolean).join(" · ")}</>}>
                  {readonlyButton(root)}
                  {connection ? <Button onClick={() => setEditing(connection)}>{t("Edit")}</Button> : null}
                  <Button variant="destructive" onClick={() => void remove(root)}>{t("Remove")}</Button>
                </Row>
              );
            })}
          </RowList>
        ) : canAdd && !editing ? (
          <KagoEmptyState className="kago-card rounded-lg border border-line" icon={<Server />} title={t("No remote locations yet")} description={t("Add a folder on another machine and it opens like any other location.")}>
            {addButton}
          </KagoEmptyState>
        ) : null}
      </Section>
    </Page>
  );
}

/** Where a remote location points, as one line: the machine, then the folder on it. */
function remoteAddress(root?: RemoteRoot) {
  if (!root) return "";
  const host = root.remote.params.host ?? root.remote.params.url ?? "";
  return [host, root.remote.base].filter(Boolean).join(host && !host.includes("/") && !root.remote.base.startsWith("/") ? "/" : " · ");
}

/** What stands for each kind of remote on its card; a kind the interface has not heard of is a server like any other. */
const providerIcons: Record<string, React.ReactNode> = { smb: <Network />, sftp: <SquareTerminal />, webdav: <Globe />, ftp: <ArrowDownUp /> };

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
        <FieldGroup label={t("Kind")} className="col-span-2">
          <KagoChoice
            label={t("Kind")}
            value={type}
            onChange={(next) => { if (next === type) return; setType(next); setParams({}); setBase(""); }}
            options={providers.map((item) => ({ value: item.type, label: item.label, icon: providerIcons[item.type] ?? <Server /> }))}
          />
        </FieldGroup>
      )}
      <Field label={t("Name")} className="col-span-2"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {provider.fields.map((field) =>
        field.kind === "boolean" ? (
          <Checkbox key={field.key} className="col-span-2" label={label(field.label)} checked={Boolean(params[field.key])} onChange={(event) => set(field.key, event.target.checked)} />
        ) : (
          <Field key={field.key} label={label(field.label)}>
            {field.kind === "select" ? (
              <Select value={String(params[field.key] ?? field.options?.[0]?.value ?? "")} onChange={(event) => set(field.key, event.target.value)}>
                {field.options?.map((option) => <option key={option.value} value={option.value}>{label(option.label)}</option>)}
              </Select>
            ) : field.kind === "secret" ? (
              <KagoPasswordInput autoComplete="new-password" value={String(params[field.key] ?? "")} placeholder={kept(field) ? t("Unchanged") : field.placeholder} onChange={(event) => set(field.key, event.target.value)} />
            ) : (
              <Input
                inputMode={field.kind === "number" ? "numeric" : undefined}
                autoComplete="off"
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
