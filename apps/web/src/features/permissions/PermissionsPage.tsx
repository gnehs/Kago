import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, usePermissions, useUsers } from "@/api/hooks";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { Card, Page } from "@/features/workspace/Page";
import { normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";
import type { Root } from "@/types/kago";
import { permissionActions, permissionPresets, type PermissionAction } from "./permissionUtils";
import { RuleList } from "./RuleList";

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
      toast("已新增權限規則");
    }, "新增規則失敗");
  }

  if (roots.length === 0) {
    return (
      <Page title="權限">
        <KagoEmptyState icon={<KeyRound />} title="還沒有任何位置" description="/data 底下有資料夾後，才能設定權限。" />
      </Page>
    );
  }

  return (
    <Page title="權限" description="沒有被明確允許的動作一律拒絕；同一路徑上「禁止」優先於「允許」。">
      <Card title="新增規則">
        <form className="flex flex-col gap-4" onSubmit={save}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="套用對象">
              <Select value={principalType} onChange={(event) => { setPrincipalType(event.target.value as "user" | "group"); setPrincipalId(""); }}>
                <option value="group">群組</option>
                <option value="user">使用者</option>
              </Select>
            </Field>
            <Field label={principalType === "group" ? "群組" : "使用者"}>
              <Select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
                <option value="">請選擇</option>
                {principalType === "group"
                  ? groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)
                  : users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
              </Select>
            </Field>
            <Field label="位置">
              <Select value={rootId} onChange={(event) => setSelectedRootId(event.target.value)}>
                {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
              </Select>
            </Field>
            <Field label="路徑" hint={normalizedPath ? undefined : "路徑格式無效"}>
              <Input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} placeholder="/public" />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted">快速套用</span>
            {permissionPresets.map((preset) => (
              <Button key={preset.label} onClick={() => setDecisions(Object.fromEntries(preset.allow.map((key) => [key, "allow"])))}>{preset.label}</Button>
            ))}
            <Button variant="ghost" onClick={() => setDecisions({})}>清除</Button>
          </div>

          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">動作</th>
                <th className="w-16 py-1 text-center font-medium">允許</th>
                <th className="w-16 py-1 text-center font-medium">禁止</th>
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
                        className="size-3.5 accent-(--kago-accent)"
                        aria-label={`${decision === "allow" ? "允許" : "禁止"}${action.label}`}
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
            <Checkbox label="包含所有子資料夾" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
            <Button type="submit" variant="default" disabled={!canSave}>新增規則</Button>
          </div>
        </form>
      </Card>

      <Card title={`「${roots.find((root) => root.id === rootId)?.name ?? ""}」的規則`}>
        {rules.error ? <span className="text-danger">無法讀取權限規則</span> : null}
        {rules.data?.length === 0 ? <span className="text-faint">這個位置還沒有任何規則，只有管理員可以存取。</span> : null}
        {rules.data?.length ? <RuleList rules={rules.data} /> : null}
      </Card>
    </Page>
  );
}
