import { useEffect, useRef, useState } from "react";
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
import { permissionLevels, type PermissionLevel } from "./permissionUtils";
import { RuleList } from "./RuleList";
import { t } from "@/lib/i18n";

export function PermissionsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const groups = useGroups();
  const [selectedRootId, setSelectedRootId] = useState("");
  const rootId = selectedRootId || roots[0]?.id || "";
  const [pathPrefix, setPathPrefix] = useState("/");
  const [principalType, setPrincipalType] = useState<"user" | "group">("group");
  const [principalId, setPrincipalId] = useState("");
  const [level, setLevel] = useState<PermissionLevel>("view");
  const [recursive, setRecursive] = useState(true);
  const [creating, setCreating] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  // The form opens under the rules, which may be a long list: it is brought into view rather than left below the fold.
  useEffect(() => {
    if (creating) form.current?.closest("section")?.scrollIntoView({ block: "start" });
  }, [creating]);
  const rootName = roots.find((root) => root.id === rootId)?.name ?? "";
  const rules = usePermissions(rootId, Boolean(rootId));
  const normalizedPath = normalizeLogicalPath(pathPrefix);
  const canSave = Boolean(rootId && principalId && normalizedPath);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    await run(async () => {
      await api("/api/permissions", { method: "POST", body: JSON.stringify({ principalType, principalId, rootId, pathPrefix: normalizedPath, level, recursive }) });
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
      description={t("Nobody but administrators can reach a folder until a rule grants it. When several rules apply, the highest one counts.")}
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
      <Card className="scroll-mt-5" title={t("Add a rule to “{rootName}”", { rootName })} action={<KagoIconButton label={t("Cancel adding")} onClick={() => setCreating(false)}><X /></KagoIconButton>}>
        <form ref={form} className="flex flex-col gap-4" onSubmit={save}>
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

          <Field label={t("Access")} hint={permissionLevels.find((item) => item.key === level)?.description}>
            <Select value={level} onChange={(event) => setLevel(event.target.value as PermissionLevel)}>
              {permissionLevels.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </Select>
          </Field>

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
