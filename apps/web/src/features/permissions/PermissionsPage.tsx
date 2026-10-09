import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, UserRound, UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, usePermissions, useUsers } from "@/api/hooks";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card, Page } from "@/components/kago/page";
import { normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import type { PermissionRule, Root } from "@/types/kago";
import { permissionLabel, type PermissionLevel } from "./permissionUtils";
import { t } from "@/lib/i18n";

type Principal = { type: PermissionRule["principal_type"]; id: string; name: string; admin?: boolean; groupIds?: string[] };

const nfc = (value: string) => value.normalize("NFC");
const higher = (a: PermissionRule | undefined, b: PermissionRule) => (!a || (a.level === "view" && b.level === "edit") ? b : a);

export function PermissionsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const groups = useGroups();
  const [selectedRootId, setSelectedRootId] = useState("");
  const rootId = selectedRootId || roots[0]?.id || "";
  const [pathInput, setPathInput] = useState("/");
  const [saving, setSaving] = useState("");
  const rules = usePermissions(rootId, Boolean(rootId));
  const normalizedPath = normalizeLogicalPath(pathInput);
  const path = nfc(normalizedPath ?? "/");

  const isHere = (rule: PermissionRule) => nfc(rule.path_prefix) === path;
  const covers = (rule: PermissionRule) => {
    const prefix = nfc(rule.path_prefix);
    return isHere(rule) || (Boolean(rule.recursive) && path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  };
  const rulesOf = (type: Principal["type"], id: string) => (rules.data ?? []).filter((rule) => rule.principal_type === type && rule.principal_id === id);

  /** What the principal already gets here without a tick on this row: from a folder above, or from a group they are in. */
  function granted(principal: Principal) {
    let best: PermissionRule | undefined;
    for (const rule of rulesOf(principal.type, principal.id)) if (covers(rule) && !isHere(rule)) best = higher(best, rule);
    for (const groupId of principal.groupIds ?? []) for (const rule of rulesOf("group", groupId)) if (covers(rule)) best = higher(best, rule);
    if (!best) return null;
    const source = best.principal_type === principal.type ? best.path_prefix : groups.data?.find((group) => group.id === best.principal_id)?.name ?? best.path_prefix;
    return t("Already gets {level} from {source}", { level: permissionLabel(best.level), source });
  }

  async function set(principal: Principal, level: PermissionLevel | null) {
    const key = `${principal.type}:${principal.id}`;
    setSaving(key);
    await run(async () => {
      await api("/api/permissions", { method: "PUT", body: JSON.stringify({ principalType: principal.type, principalId: principal.id, rootId, pathPrefix: path, level }) });
      await Promise.all(["permissions", "roots", "fs"].map((queryKey) => queryClient.invalidateQueries({ queryKey: [queryKey] })));
    }, t("Couldn’t change the permission"));
    setSaving((current) => (current === key ? "" : current));
  }

  if (roots.length === 0) {
    return (
      <Page title={t("Permissions")}>
        <KagoEmptyState icon={<KeyRound />} title={t("No locations yet")} description={t("Permissions can be set once there is a folder under /data.")} />
      </Page>
    );
  }

  const groupRows: Principal[] = (groups.data ?? []).map((group) => ({ type: "group", id: group.id, name: group.name }));
  const userRows: Principal[] = (users.data ?? []).map((user) => ({
    type: "user",
    id: user.id,
    name: user.email,
    admin: user.role === "ADMIN",
    groupIds: (groups.data ?? []).filter((group) => group.members.some((member) => member.id === user.id)).map((group) => group.id)
  }));
  const otherPaths = [...new Set((rules.data ?? []).map((rule) => rule.path_prefix))].filter((prefix) => nfc(prefix) !== path).sort();

  function row(principal: Principal) {
    const here = rulesOf(principal.type, principal.id).filter(isHere);
    const level = principal.admin ? "edit" : here.reduce<PermissionRule | undefined>(higher, undefined)?.level ?? null;
    const disabled = principal.admin || !normalizedPath || saving === `${principal.type}:${principal.id}`;
    const note = principal.admin
      ? t("Administrators can reach every location")
      : [here.length && here.every((rule) => !rule.recursive) ? t("This folder only, not its subfolders") : "", granted(principal) ?? ""].filter(Boolean).join(" · ");
    return (
      <li key={`${principal.type}:${principal.id}`} className="grid min-h-11 grid-cols-[1fr_3.5rem_3.5rem] items-center py-1.5">
        <div className="flex min-w-0 items-center gap-2.5 [&>.lucide]:shrink-0 [&>.lucide]:text-muted">
          {principal.type === "group" ? <UsersRound /> : <UserRound />}
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{principal.name}</span>
            {note ? <span className="truncate text-xs text-muted">{note}</span> : null}
          </div>
        </div>
        <span className="flex justify-center">
          <input type="checkbox" className="kago-checkbox" aria-label={t("{name}: View", { name: principal.name })} checked={level !== null} disabled={disabled} onChange={(event) => void set(principal, event.target.checked ? "view" : null)} />
        </span>
        <span className="flex justify-center">
          <input type="checkbox" className="kago-checkbox" aria-label={t("{name}: Edit", { name: principal.name })} checked={level === "edit"} disabled={disabled} onChange={(event) => void set(principal, event.target.checked ? "edit" : "view")} />
        </span>
      </li>
    );
  }

  return (
    <Page
      title={t("Permissions")}
      description={t("Tick what each group or user may do in a folder. With neither ticked they can’t see it at all; Edit includes View.")}
      actions={
        // The location is the scope of the whole page: the folder being set and the ticks listed for it.
        <Select aria-label={t("Location")} className="w-40" value={rootId} onChange={(event) => setSelectedRootId(event.target.value)}>
          {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
        </Select>
      }
    >
      <Card>
        <Field label={t("Folder")} hint={normalizedPath ? t("Applies to this folder and everything in it.") : t("That path isn’t valid")}>
          <Input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="/public" />
        </Field>
        {otherPaths.length ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">{t("Other folders with permissions")}</span>
            {otherPaths.map((prefix) => <Button key={prefix} className="h-6 px-2" onClick={() => setPathInput(prefix)}>{prefix}</Button>)}
          </div>
        ) : null}
      </Card>

      <Card>
        {rules.error ? <span className="text-danger">{t("Couldn’t load the permission rules")}</span> : null}
        <div className="-my-2.5">
          <div className="grid grid-cols-[1fr_3.5rem_3.5rem] pt-1.5 text-center text-xs text-muted">
            <span />
            <span>{t("View")}</span>
            <span>{t("Edit")}</span>
          </div>
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {groupRows.map(row)}
            {userRows.map(row)}
          </ul>
        </div>
      </Card>
    </Page>
  );
}
