import { useQueryClient } from "@tanstack/react-query";
import { Trash2, UserRound, UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, useUsers } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoIconButton } from "@/components/kago/icon-button";
import { run } from "@/lib/run";
import type { PermissionRule } from "@/types/kago";
import { permissionLabel } from "./permissionUtils";
import { t } from "@/lib/i18n";

export function RuleList({ rules }: { rules: PermissionRule[] }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const groups = useGroups();

  function principalName(rule: PermissionRule) {
    if (rule.principal_type === "user") return users.data?.find((user) => user.id === rule.principal_id)?.email ?? rule.principal_id;
    return groups.data?.find((group) => group.id === rule.principal_id)?.name ?? rule.principal_id;
  }

  async function remove(ruleId: string) {
    await run(async () => {
      await api(`/api/permissions/${ruleId}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["permissions"] });
    });
  }

  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
      {rules.map((rule) => (
        <li key={rule.id} className="flex items-start gap-2.5 py-2.5">
          {rule.principal_type === "group" ? <UsersRound className="mt-0.5 text-muted" /> : <UserRound className="mt-0.5 text-muted" />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-medium">{principalName(rule)}</span>
            <span className="truncate text-xs text-muted">{rule.path_prefix}{rule.recursive ? t(" (with subfolders)") : ""}</span>
          </div>
          <KagoBadge tone={rule.level === "edit" ? "success" : undefined}>{permissionLabel(rule.level)}</KagoBadge>
          <KagoIconButton label={t("Delete rule")} onClick={() => void remove(rule.id)}><Trash2 /></KagoIconButton>
        </li>
      ))}
    </ul>
  );
}
