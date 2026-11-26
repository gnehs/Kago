import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateEvent } from "@/api/invalidations";
import { KeyRound, UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, usePermissions, useUsers } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { Select } from "@/components/ui/input";
import { Card, Page, RowList } from "@/components/kago/page";
import { arrangeUsers, groupsOf, personName } from "@/lib/peopleModel";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { PermissionRule, Root } from "@/types/kago";
import { permissionLabel, type PermissionLevel } from "./permissionUtils";
import { t } from "@/lib/i18n";

type Principal = {
  type: PermissionRule["principal_type"];
  id: string;
  name: string;
  /** Of a group: how many are in it. */
  members?: number;
  /** Of a user: their address when the name is not it, their picture, and whether they are switched off. */
  email?: string;
  picture?: string | null;
  admin?: boolean;
  off?: boolean;
  groupIds?: string[];
};

const higher = (a: PermissionRule | undefined, b: PermissionRule) => (!a || (a.level === "view" && b.level === "edit") ? b : a);

export function PermissionsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const groups = useGroups();
  const [selectedRootId, setSelectedRootId] = useState("");
  const rootId = selectedRootId || roots[0]?.id || "";
  const [saving, setSaving] = useState("");
  const rules = usePermissions(rootId, Boolean(rootId));

  const ruleOf = (type: Principal["type"], id: string) => (rules.data ?? []).find((rule) => rule.principal_type === type && rule.principal_id === id);

  /** What the user already gets here without a tick on their own row: the most that a group they are in is given. */
  function granted(principal: Principal) {
    let best: PermissionRule | undefined;
    for (const groupId of principal.groupIds ?? []) {
      const rule = ruleOf("group", groupId);
      if (rule) best = higher(best, rule);
    }
    if (!best) return null;
    const source = groups.data?.find((group) => group.id === best.principal_id)?.name ?? best.principal_id;
    return t("Already gets {level} from {source}", { level: permissionLabel(best.level), source });
  }

  async function set(principal: Principal, level: PermissionLevel | null) {
    const key = `${principal.type}:${principal.id}`;
    setSaving(key);
    await run(async () => {
      await api("/api/permissions", { method: "PUT", body: JSON.stringify({ principalType: principal.type, principalId: principal.id, rootId, level }) });
      await invalidateEvent(queryClient, "permission.updated");
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

  const groupRows: Principal[] = [...(groups.data ?? [])]
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }))
    .map((group) => ({ type: "group", id: group.id, name: group.name, members: group.members.length }));
  // The people come in the order the Users page lists them: administrators, users, and the accounts switched off last.
  const userRows: Principal[] = arrangeUsers(users.data ?? [], "").flatMap(({ users: list }) =>
    list.map((user): Principal => ({
      type: "user",
      id: user.id,
      name: personName(user),
      email: user.display_name ? user.email : undefined,
      picture: avatarUrl(user.id, user.avatar_at),
      admin: user.role === "ADMIN",
      off: Boolean(user.disabled),
      groupIds: groupsOf(user.id, groups.data ?? []).map((group) => group.id)
    }))
  );

  function row(principal: Principal) {
    const level = principal.admin ? "edit" : ruleOf(principal.type, principal.id)?.level ?? null;
    const disabled = principal.admin || saving === `${principal.type}:${principal.id}`;
    const note = principal.admin ? t("Administrators can reach every location") : granted(principal);
    const line = [principal.off ? t("Disabled") : null, principal.members !== undefined ? t("{count} member | {count} members", { count: principal.members }) : null, principal.email, note].filter(Boolean).join(" · ");
    return (
      <li key={`${principal.type}:${principal.id}`} className="grid min-h-11 grid-cols-[1fr_3.5rem_3.5rem] items-center py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {principal.type === "group" ? <KagoStatusIcon className="size-6.5 [&>.lucide]:size-3.5"><UsersRound /></KagoStatusIcon> : <KagoAvatar name={principal.name} picture={principal.picture} className={cn("size-6.5", principal.off && "text-faint")} />}
          <div className="flex min-w-0 flex-col">
            <span className={cn("truncate", principal.off ? "text-muted" : "font-medium")}>{principal.name}</span>
            {line ? <span className="truncate text-xs text-muted">{line}</span> : null}
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

  const heading = (text: string) => <li className="flex min-h-0 pt-3 pb-1 text-xs font-semibold text-muted">{text}</li>;

  return (
    <Page
      title={t("Permissions")}
      description={t("Tick what each group or user may do in a location, and everything in it. With neither ticked they can’t see it at all; Edit includes View.")}
      actions={
        // The location is the scope of the whole page: the ticks listed are the ones for it.
        <Select aria-label={t("Location")} className="w-40" value={rootId} onChange={(event) => setSelectedRootId(event.target.value)}>
          {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
        </Select>
      }
    >
      <Card>
        {rules.error ? <span className="text-danger">{t("Couldn’t load the permission rules")}</span> : null}
        <div className="-my-2.5">
          <div className="grid grid-cols-[1fr_3.5rem_3.5rem] pt-1.5 text-center text-xs text-muted">
            <span />
            <span>{t("View")}</span>
            <span>{t("Edit")}</span>
          </div>
          <RowList bare>
            {groupRows.length > 0 ? heading(t("Groups · {count}", { count: groupRows.length })) : null}
            {groupRows.map(row)}
            {userRows.length > 0 ? heading(t("Users · {count}", { count: userRows.length })) : null}
            {userRows.map(row)}
          </RowList>
        </div>
      </Card>
    </Page>
  );
}
