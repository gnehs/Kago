import { useState } from "react";
import { ScrollText } from "lucide-react";
import { useAudit, useGroups, useRoots, useUsers, type AuditEntry } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Page } from "@/components/kago/page";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { formatUnixDate } from "@/lib/format";
import { displayPath } from "@/lib/paths";
import type { AuditLog } from "@/types/kago";
import { t } from "@/lib/i18n";

const results: Record<AuditLog["result"], { label: string; tone: "success" | "danger" | "warning" }> = {
  success: { label: t("Success"), tone: "success" },
  failure: { label: t("Failed"), tone: "danger" },
  denied: { label: t("Denied"), tone: "warning" }
};

/** Every action the server writes; one it does not know here is shown as its code. */
const actions: Record<string, string> = {
  admin: t("Administrator action"),
  admin_recovery: t("Administrator recovered"),
  compress: t("Compressed files"),
  convert: t("Converted a file"),
  convert_job_create: t("Added an auto-convert"),
  convert_job_delete: t("Deleted an auto-convert"),
  convert_job_skipped: t("Skipped an auto-convert"),
  convert_job_update: t("Changed an auto-convert"),
  convert_structure: t("Converted a folder"),
  copy: t("Copied"),
  create_share: t("Created a share link"),
  create_task: t("Created a task"),
  delete: t("Deleted permanently"),
  delete_share: t("Deleted a share link"),
  delete_to_trash: t("Moved to the trash"),
  disable_share: t("Turned off a share link"),
  download: t("Downloaded"),
  download_via_share: t("Downloaded through a share link"),
  download_zip: t("Downloaded as a zip"),
  edit: t("Edited a file"),
  external_app_create: t("Added an app"),
  external_app_delete: t("Removed an app"),
  external_app_update: t("Changed an app"),
  extract: t("Extracted an archive"),
  group_create: t("Added a group"),
  group_delete: t("Deleted a group"),
  group_member_add: t("Added to a group"),
  group_member_remove: t("Removed from a group"),
  group_rename: t("Renamed a group"),
  login_failed: t("Sign-in failed"),
  login_success: t("Signed in"),
  logout: t("Signed out"),
  mkdir: t("Created a folder"),
  move: t("Moved"),
  password_change: t("Changed password"),
  password_reset: t("Reset a password"),
  permission_change: t("Changed a permission"),
  permission_denied: t("Access denied"),
  request_denied: t("Request denied"),
  request_failed: t("Request refused"),
  remux: t("Remuxed a video"),
  rename: t("Renamed"),
  restore_trash: t("Restored from the trash"),
  rotate_share: t("Made a new share link"),
  root_create: t("Added a location"),
  root_delete: t("Removed a location"),
  root_update: t("Changed a location"),
  session_revoked: t("Session ended"),
  set_avatar: t("Changed a picture"),
  set_wallpaper: t("Changed the wallpaper"),
  setup_admin: t("Created the first administrator"),
  share_access: t("Opened a share link"),
  share_auth_failed: t("Wrong share password"),
  shared_external_app: t("Opened a shared app"),
  shelf_access: t("Opened a shelf"),
  sso_link: t("Linked single sign-on"),
  sso_unlink: t("Unlinked single sign-on"),
  sso_update: t("Changed single sign-on"),
  sync: t("Synced"),
  sync_job_create: t("Added a sync"),
  sync_job_delete: t("Deleted a sync"),
  sync_job_skipped: t("Skipped a sync"),
  sync_job_update: t("Changed a sync"),
  tag_update: t("Changed tags"),
  task_access: t("Opened a task"),
  task_cancel: t("Cancelled a task"),
  task_failed: t("A task failed"),
  task_pause: t("Paused a task"),
  task_resume: t("Resumed a task"),
  task_retry: t("Retried a task"),
  task_start: t("Started a task"),
  tasks_clear: t("Cleared finished tasks"),
  thumbnail: t("Made a thumbnail"),
  trash_empty: t("Emptied the trash"),
  update_share: t("Changed a share link"),
  upload: t("Uploaded"),
  upload_via_share: t("Uploaded through a share link"),
  user_create: t("Added a user"),
  user_disable: t("Disabled or enabled a user"),
  user_update: t("Changed a user"),
  workspace_update: t("Changed the desktop")
};
const actionLabel = (action: string) => actions[action] ?? action;
const actionOptions = Object.keys(actions).sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));

type Names = { users: Map<string, string>; groups: Map<string, string>; roots: Map<string, string> };

/** What a row acted on, in words: its path, or the people, groups and locations named in what it carries. */
function target(log: AuditEntry, names: Names) {
  const rootName = log.root_id ? names.roots.get(log.root_id) : undefined;
  if (log.path) return rootName ? displayPath(rootName, log.path) : log.path;
  if (!log.target_json) return rootName ?? "—";
  let value: unknown;
  try {
    value = JSON.parse(log.target_json);
  } catch {
    return log.target_json;
  }
  if (!value || typeof value !== "object") return String(value);
  const entries = value as Record<string, unknown>;
  const text = (key: string) => (typeof entries[key] === "string" ? (entries[key] as string) : undefined);
  const parts = [
    text("userId") ? (names.users.get(text("userId")!) ?? text("userId")) : (text("display_name") ?? text("email")),
    text("groupId") ? (names.groups.get(text("groupId")!) ?? text("groupId")) : undefined,
    text("rootId") ? (names.roots.get(text("rootId")!) ?? text("rootId")) : (text("slug") ?? undefined),
    text("name"),
    text("path"),
    rootName
  ].filter(Boolean);
  if (parts.length) return [...new Set(parts)].join(" · ");
  const plain = Object.values(entries).filter((item): item is string | number => typeof item === "string" || typeof item === "number");
  return plain.length ? plain.slice(0, 3).join(" · ") : "—";
}

function who(log: AuditEntry) {
  if (log.actor_type === "share_link") return t("Share link");
  if (log.actor_type === "user") return log.actor_name ?? (log.actor_id ? t("Deleted user") : t("User"));
  return t("System");
}

export function AuditPage() {
  const [action, setAction] = useState("");
  const [result, setResult] = useState<AuditLog["result"] | "">("");
  const audit = useAudit({ action: action || undefined, result: result || undefined });
  const roots = useRoots().data;
  const users = useUsers().data;
  const groups = useGroups().data;
  const names: Names = {
    users: new Map(users?.map((user) => [user.id, user.display_name || user.email])),
    groups: new Map(groups?.map((group) => [group.id, group.name])),
    roots: new Map(roots?.map((root) => [root.id, root.name]))
  };
  const logs = audit.data?.pages.flat() ?? [];
  const filtered = Boolean(action || result);
  return (
    <Page title={t("Audit log")} description={t("Sign-ins, file operations, shares and permission changes, including attempts that failed or were denied.")}>
      <div className="flex flex-wrap gap-2">
        <Select aria-label={t("Filter by action")} className="w-auto" value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">{t("Any action")}</option>
          {actionOptions.map((code) => <option key={code} value={code}>{actionLabel(code)}</option>)}
        </Select>
        <Select aria-label={t("Filter by result")} className="w-auto" value={result} onChange={(event) => setResult(event.target.value as AuditLog["result"] | "")}>
          <option value="">{t("Any result")}</option>
          {(Object.keys(results) as Array<AuditLog["result"]>).map((value) => <option key={value} value={value}>{results[value].label}</option>)}
        </Select>
      </div>
      {audit.isLoading ? <KagoLoading /> : null}
      {audit.data && logs.length === 0 ? <KagoEmptyState icon={<ScrollText />} title={filtered ? t("No entries match") : t("No audit entries yet")} /> : null}
      {logs.length ? (
        <div className="kago-card overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-elevated/60 text-left text-xs whitespace-nowrap text-muted">
                <th className="px-3 py-2 font-medium">{t("Time")}</th>
                <th className="px-3 py-2 font-medium">{t("Action")}</th>
                <th className="px-3 py-2 font-medium">{t("Target")}</th>
                <th className="px-3 py-2 font-medium">{t("Source")}</th>
                <th className="px-3 py-2 font-medium">{t("Result")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const described = target(log, names);
                return (
                  <tr key={log.id} className="border-t border-line">
                    <td className="px-3 py-2 whitespace-nowrap text-muted tabular-nums">{formatUnixDate(log.created_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{actionLabel(log.action)}</td>
                    <td className="max-w-64 px-3 py-2 text-muted"><KagoTooltip label={described}><span className="block truncate">{described}</span></KagoTooltip></td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="block">{who(log)}</span>
                      {log.actor_email && log.actor_email !== who(log) ? <span className="block text-xs text-muted">{log.actor_email}</span> : null}
                      {log.ip ? <span className="block text-xs text-muted tabular-nums">{log.ip}</span> : null}
                    </td>
                    <td className="px-3 py-2"><KagoBadge tone={results[log.result].tone}>{results[log.result].label}</KagoBadge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {audit.hasNextPage ? (
        <div className="flex justify-center">
          <Button disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>{audit.isFetchingNextPage ? <KagoSpinner className="text-inherit" /> : null}{t("Load more")}</Button>
        </div>
      ) : null}
    </Page>
  );
}
