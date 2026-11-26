import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { useUsers } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoSearchField } from "@/components/kago/search-field";
import { Button } from "@/components/ui/button";
import { candidatesFor, personName } from "@/lib/peopleModel";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { Group } from "@/types/kago";
import { t } from "@/lib/i18n";

/** Puts people into a group: those not in it yet, found by name or address and ticked, however many at once. */
export function AddMembersDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  return (
    <KagoDialog open={group !== null} onClose={onClose} title={group ? t("Add members to {name}", { name: group.name }) : ""} className="w-[min(460px,calc(100%-32px))]">
      {group ? <Picker key={group.id} group={group} onClose={onClose} /> : null}
    </KagoDialog>
  );
}

function Picker({ group, onClose }: { group: Group; onClose: () => void }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const everyone = users.data ? candidatesFor(users.data, group, "") : [];
  const found = users.data ? candidatesFor(users.data, group, query) : [];
  // Someone put in by a search that has since moved on stays chosen, and is counted: what is added is what is ticked.
  const ticked = chosen.filter((id) => everyone.some((user) => user.id === id));

  const toggle = (id: string) => setChosen((was) => (was.includes(id) ? was.filter((item) => item !== id) : [...was, id]));

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (ticked.length === 0 || busy) return;
    setBusy(true);
    const left = [...ticked];
    const done = await run(async () => {
      while (left.length > 0) {
        await api(`/api/groups/${group.id}/members`, { method: "POST", body: JSON.stringify({ userId: left[0] }) });
        left.shift();
      }
      return true;
    }, t("Couldn’t add to the group"));
    await queryClient.invalidateQueries({ queryKey: keys.groups() });
    setBusy(false);
    // What was not added before a failure stays ticked, to try again.
    if (done) onClose();
    else setChosen(left);
  }

  return (
    <form className="flex min-h-0 flex-col gap-3 p-4 pt-3" onSubmit={add}>
      {everyone.length > 0 ? <KagoSearchField label={t("Search users")} value={query} onChange={setQuery} /> : null}
      <div className="flex h-64 min-h-0 flex-col overflow-y-auto rounded-md border border-line bg-elevated p-1">
        {users.isLoading ? <KagoLoading /> : null}
        {users.data && everyone.length === 0 ? <KagoEmptyState className="flex-1 py-4" icon={<UsersRound />} title={t("Everyone is in this group already")} /> : null}
        {everyone.length > 0 && found.length === 0 ? <KagoEmptyState className="flex-1 py-4" icon={<Search />} title={t("No users match “{query}”", { query: query.trim() })} /> : null}
        {found.map((user) => (
          <label key={user.id} className="flex h-9 shrink-0 items-center gap-2.5 rounded-sm px-2 hover:bg-hover">
            <input type="checkbox" className="kago-checkbox" checked={chosen.includes(user.id)} onChange={() => toggle(user.id)} />
            <KagoAvatar name={personName(user)} picture={avatarUrl(user.id, user.avatar_at)} className={cn("size-6 text-[11px]", user.disabled && "text-faint")} />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className={cn("truncate", user.disabled ? "text-muted" : "font-medium")}>{personName(user)}</span>
              <span className="truncate text-xs text-muted">{user.disabled ? `${t("Disabled")} · ${user.email}` : user.email}</span>
            </span>
          </label>
        ))}
      </div>
      <KagoDialogActions>
        <span role="status" className="mr-auto flex min-w-0 items-center text-xs text-muted">{ticked.length > 0 ? t("{count} chosen", { count: ticked.length }) : t("Tick who to add")}</span>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={ticked.length === 0 || busy}>{busy ? <KagoSpinner className="text-inherit" /> : null}{ticked.length > 0 ? t("Add {count} member | Add {count} members", { count: ticked.length }) : t("Add")}</Button>
      </KagoDialogActions>
    </form>
  );
}
