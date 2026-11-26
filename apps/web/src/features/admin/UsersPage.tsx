import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UserRound } from "lucide-react";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { useGroups, useUsers } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Page } from "@/components/kago/page";
import { KagoSearchField } from "@/components/kago/search-field";
import { useWindowScope } from "@/components/kago/window-scope";
import { Button } from "@/components/ui/button";
import { arrangeUsers, groupsOf, isLastAdmin, personName, type UserSection } from "@/lib/peopleModel";
import { run } from "@/lib/run";
import { confirmAction, promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { UserAccount } from "@/types/kago";
import { UserCard, type UserCardActions } from "./UserCard";
import { UserDialog, type UserDialogTarget } from "./UserDialog";
import { t } from "@/lib/i18n";

const sectionTitle = (section: UserSection, count: number) =>
  section === "admins" ? t("Administrators · {count}", { count }) : section === "users" ? t("Users · {count}", { count }) : t("Disabled · {count}", { count });

/**
 * Everyone who can sign in, by what they are: administrators, users, and the accounts that are switched off. Each card
 * says which groups the user is in and how they get in. The header holds the search and adding a user.
 */
export function UsersPage({ currentUserId }: { currentUserId: string }) {
  const scope = useWindowScope();
  const queryClient = useQueryClient();
  const users = useUsers();
  const groups = useGroups();
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<UserDialogTarget | null>(null);
  const all = users.data ?? [];
  const sections = arrangeUsers(all, query);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.users() });
  const subjectOf = (user: UserAccount) => ({ icon: <KagoAvatar name={personName(user)} picture={avatarUrl(user.id, user.avatar_at)} className="size-12 text-base" />, name: personName(user), detail: user.display_name ? user.email : undefined });

  async function setDisabled(user: UserAccount, disabled: boolean) {
    if (disabled && !(await confirmAction({ window: scope, title: t("Disable this user?"), subject: subjectOf(user), description: t("They are signed out everywhere, and the share links they created stop working until the account is enabled again."), confirmLabel: t("Disable"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await refresh();
    }, disabled ? t("Couldn’t disable the user") : t("Couldn’t enable the user"));
  }

  async function resetPassword(user: UserAccount) {
    const password = await promptText({ window: scope, title: t("Reset {name}’s password", { name: personName(user) }), description: t("At least 8 characters. This user is signed out everywhere and has to sign in again with the new password."), placeholder: t("New password"), confirmLabel: t("Reset password") });
    if (password === null) return;
    if (password.length < 8) {
      toast(t("The password needs at least 8 characters"), "error");
      return;
    }
    await run(async () => {
      await api(`/api/users/${user.id}/password`, { method: "POST", body: JSON.stringify({ password }) });
      toast(t("{name}’s password was reset", { name: personName(user) }));
    }, t("Couldn’t reset the password"));
  }

  async function unlinkSso(user: UserAccount) {
    if (!(await confirmAction({ window: scope, title: t("Unlink from single sign-on?"), subject: subjectOf(user), description: user.has_password ? t("They can still sign in with their password. Signing in through the provider again links it back if its email address is this account’s.") : t("This account has no password: nobody can sign in to it until you reset its password."), confirmLabel: t("Unlink"), destructive: true }))) return;
    await run(async () => {
      for (const identity of user.identities) await api(`/api/users/${user.id}/identities/${identity.id}`, { method: "DELETE" });
      await refresh();
    }, t("Couldn’t unlink the identity"));
  }

  const actions: UserCardActions = {
    edit: (user) => setDialog({ user, lastAdmin: isLastAdmin(all, user.id) }),
    resetPassword: (user) => void resetPassword(user),
    unlinkSso: (user) => void unlinkSso(user),
    setDisabled: (user, disabled) => void setDisabled(user, disabled)
  };

  return (
    <Page
      wide
      title={t("Users")}
      description={t("Administrators can reach every location; everyone else needs permission rules.")}
      search={<KagoSearchField label={t("Search users")} value={query} onChange={setQuery} />}
      actions={<Button variant="default" onClick={() => setDialog({ user: null })}><Plus />{t("Add user")}</Button>}
    >
      {users.isLoading ? <KagoLoading /> : null}
      {users.data && all.length === 0 ? <KagoEmptyState className="flex-1" icon={<UserRound />} title={t("No users yet")} /> : null}
      {all.length > 0 && sections.length === 0 ? <KagoEmptyState className="flex-1" icon={<Search />} title={t("No users match “{query}”", { query: query.trim() })} /> : null}
      {sections.map(({ section, users: list }) => (
        <section key={section} className="flex flex-col gap-1">
          <h2 className="m-0 px-1 pb-0.5 text-xs font-semibold text-muted">{sectionTitle(section, list.length)}</h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {list.map((user) => <UserCard key={user.id} user={user} groups={groupsOf(user.id, groups.data ?? [])} isMe={user.id === currentUserId} actions={actions} />)}
          </ul>
        </section>
      ))}

      <UserDialog target={dialog} onClose={() => setDialog(null)} />
    </Page>
  );
}
