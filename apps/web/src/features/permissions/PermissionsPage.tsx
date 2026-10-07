import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, X } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, usePermissions, useUsers } from "@/api/hooks";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { Card, Page } from "@/features/workspace/Page";
import { normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";
import type { Root } from "@/types/kago";
import { permissionActions, permissionPresets, type PermissionAction } from "./permissionUtils";
import { RuleList } from "./RuleList";
import { t } from "@/lib/i18n";

type Decision = "allow" | "deny";

export function PermissionsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const groups = useGroups();
  const [selectedRootId, setSelectedRootId] = useState("");
  const rootId = selectedRootId || roots[0]?.id || "";
  const [pathPrefix, setPathPrefix] = useState("/");
  const [principalType, setPrincipalType] = useState<"user" | "group">("group");
  const [principalId, setPrincipalId] = useState("");
  const [decisions, setDecisions] = useState<Partial<Record<PermissionAction, Decision>>>({ list: "allow", read: "allow", download: "allow" });
  const [recursive, setRecursive] = useState(true);
  const [creating, setCreating] = useState(false);
  const rootName = roots.find((root) => root.id === rootId)?.name ?? "";
  const rules = usePermissions(rootId, Boolean(rootId));
  const normalizedPath = normalizeLogicalPath(pathPrefix);
  const allow = permissionActions.filter((action) => decisions[action.key] === "allow").map((action) => action.key);
  const deny = permissionActions.filter((action) => decisions[action.key] === "deny").map((action) => action.key);
  const canSave = Boolean(rootId && principalId && normalizedPath) && allow.length + deny.length > 0;

  function toggle(action: PermissionAction, decision: Decision) {
    setDecisions((current) => ({ ...current, [action]: current[action] === decision ? undefined : decision }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    await run(async () => {
      await api("/api/permissions", { method: "POST", body: JSON.stringify({ principalType, principalId, rootId, pathPrefix: normalizedPath, allow, deny, recursive }) });
      await Promise.all(["permissions", "roots", "fs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      setCreating(false);
      toast(t("Permission rule added"));
    }, t("Couldn’t add the rule"));
  }

  if (roots.length === 0) {
    return (
      <Page title={t("Permissions")}>
        <KagoEmptyState icon={<KeyRound />} title={t("No locations yet")} description={t("Permissions can be set once there is a folder under /data.")} />
      </Page>
    );
  }

  return (
    <Page
      title={t("Permissions")}
      description={t("Anything not explicitly allowed is denied; on the same path, Deny wins over Allow.")}
      actions={
        // The location is the scope of the whole page: the rules listed and the rule being added.
        <Select aria-label={t("Location")} className="w-40" value={rootId} onChange={(event) => setSelectedRootId(event.target.value)}>
          {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
        </Select>
      }
    >
      <Card
        title={t("Rules for “{rootName}”", { rootName })}
        description={rules.data?.length ? t("{count} rule | {count} rules", { count: rules.data.length }) : undefined}
        action={creating ? null : <Button onClick={() => setCreating(true)}><Plus />{t("Add rule")}</Button>}
      >
        {rules.error ? <span className="text-danger">{t("Couldn’t load the permission rules")}</span> : null}
        {rules.data?.length === 0 ? <span className="text-faint">{t("This location has no rules yet; only administrators can reach it.")}</span> : null}
        {rules.data?.length ? <div className="-my-2.5"><RuleList rules={rules.data} /></div> : null}
      </Card>

      {creating ? (
      <Card title={t("Add a rule to “{rootName}”", { rootName })} action={<KagoIconButton label={t("Cancel adding")} onClick={() => setCreating(false)}><X /></KagoIconButton>}>
        <form className="flex flex-col gap-4" onSubmit={save}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Applies to")}>
              <Select value={principalType} onChange={(event) => { setPrincipalType(event.target.value as "user" | "group"); setPrincipalId(""); }}>
                <option value="group">{t("Group")}</option>
                <option value="user">{t("User")}</option>
              </Select>
            </Field>
            <Field label={principalType === "group" ? t("Group") : t("User")}>
              <Select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
                <option value="">{t("Choose…")}</option>
                {principalType === "group"
                  ? groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)
                  : users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
              </Select>
            </Field>
            <Field label={t("Path")} hint={normalizedPath ? undefined : t("That path isn’t valid")} className="col-span-2">
              <Input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} placeholder="/public" />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted">{t("Presets")}</span>
            {permissionPresets.map((preset) => (
              <Button key={preset.label} onClick={() => setDecisions(Object.fromEntries(preset.allow.map((key) => [key, "allow"])))}>{preset.label}</Button>
            ))}
            <Button variant="ghost" onClick={() => setDecisions({})}>{t("Clear")}</Button>
          </div>

          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">{t("Action")}</th>
                <th className="w-16 py-1 text-center font-medium">{t("Allow")}</th>
                <th className="w-16 py-1 text-center font-medium">{t("Deny")}</th>
              </tr>
            </thead>
            <tbody>
              {permissionActions.map((action) => (
                <tr key={action.key} className="border-t border-line">
                  <td className="py-1.5">{action.label}</td>
                  {(["allow", "deny"] as const).map((decision) => (
                    <td key={decision} className="text-center">
                      <input
                        type="checkbox"
                        className="kago-checkbox"
                        aria-label={decision === "allow" ? t("Allow: {action}", { action: action.label }) : t("Deny: {action}", { action: action.label })}
                        checked={decisions[action.key] === decision}
                        onChange={() => toggle(action.key, decision)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between">
            <Checkbox label={t("Include all subfolders")} checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
            <Button type="submit" variant="default" disabled={!canSave}>{t("Add rule")}</Button>
          </div>
        </form>
      </Card>
      ) : null}
    </Page>
  );
}
