import { Ellipsis, Fingerprint, KeyRound, Link2Off, Pencil, UserRoundX } from "lucide-react";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoChip, KagoChips } from "@/components/kago/chip";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { groupChips, personName, signInOf } from "@/lib/peopleModel";
import { cn } from "@/lib/utils";
import type { Group, UserAccount } from "@/types/kago";
import { t } from "@/lib/i18n";

/** What can be done to a card; the page answers each, since it asks the questions and holds the dialogs. */
export type UserCardActions = {
  edit: (user: UserAccount) => void;
  resetPassword: (user: UserAccount) => void;
  unlinkSso: (user: UserAccount) => void;
  setDisabled: (user: UserAccount, disabled: boolean) => void;
};

/**
 * A user as a card of two lines: their name and their address under it. At the right, what they belong to and how they
 * get in: their groups, a mark for each way of signing in, and "You" on the viewer's own card. One button (Edit, or
 * Enable for an account that is switched off) and the menu for the rest. A disabled account is set apart by colour.
 */
export function UserCard({ user, groups, isMe, actions }: { user: UserAccount; groups: readonly Group[]; isMe: boolean; actions: UserCardActions }) {
  const off = Boolean(user.disabled);
  const name = personName(user);
  const { shown, rest } = groupChips(groups);
  const signIn = signInOf(user);
  const hasMenu = !isMe || signIn.sso;

  return (
    <li className={cn("kago-card flex h-[46px] shrink-0 items-center gap-2.5 rounded-md border border-line pr-1.5 pl-2.5 text-ink", off && "bg-elevated")}>
      <KagoAvatar name={name} picture={avatarUrl(user.id, user.avatar_at)} className={cn("size-6.5", off && "text-faint")} />
      <div className="flex min-w-0 flex-1 flex-col">
        <KagoTooltip label={name}><span className={cn("min-w-0 truncate", off ? "text-muted" : "font-medium")}>{name}</span></KagoTooltip>
        <KagoTooltip label={user.email}><span className="min-w-0 truncate text-xs text-muted">{user.email}</span></KagoTooltip>
      </div>
      {groups.length > 0 ? (
        <KagoChips className="hidden shrink-0 flex-nowrap @xl:flex">
          {shown.map((group) => <KagoChip key={group.id}><span className="max-w-28 truncate text-xs text-muted">{group.name}</span></KagoChip>)}
          {rest.length > 0 ? (
            <KagoChip>
              <KagoTooltip label={rest.map((group) => group.name).join(", ")}><span className="text-xs text-muted tabular-nums">+{rest.length}</span></KagoTooltip>
            </KagoChip>
          ) : null}
        </KagoChips>
      ) : null}
      <span className="flex shrink-0 items-center gap-1.5 text-muted [&>span]:flex">
        {signIn.password ? <KagoTooltip label={t("Signs in with a password")}><span><KeyRound className="size-3.5" aria-label={t("Signs in with a password")} /></span></KagoTooltip> : null}
        {signIn.sso ? <KagoTooltip label={t("Signs in through single sign-on")}><span><Fingerprint className="size-3.5" aria-label={t("Signs in through single sign-on")} /></span></KagoTooltip> : null}
      </span>
      {isMe ? <span className="shrink-0 text-xs text-muted">{t("You")}</span> : null}
      {off ? (
        <Button className="h-6 shrink-0 px-2 text-xs" onClick={() => actions.setDisabled(user, false)}>{t("Enable")}</Button>
      ) : (
        <Button className="h-6 shrink-0 px-2 text-xs" onClick={() => actions.edit(user)}>{t("Edit")}</Button>
      )}
      {hasMenu ? (
        <KagoDropdownMenu
          raised
          label={t("More actions")}
          className="size-6"
          menu={
            <>
              {off ? <KagoMenuItem icon={<Pencil />} onClick={() => actions.edit(user)}>{t("Edit")}</KagoMenuItem> : null}
              {isMe ? null : <KagoMenuItem icon={<KeyRound />} onClick={() => actions.resetPassword(user)}>{t("Reset password…")}</KagoMenuItem>}
              {signIn.sso ? <KagoMenuItem icon={<Link2Off />} onClick={() => actions.unlinkSso(user)}>{t("Unlink single sign-on…")}</KagoMenuItem> : null}
              {isMe || off ? null : (
                <>
                  <KagoMenuSeparator />
                  <KagoMenuItem icon={<UserRoundX />} destructive onClick={() => actions.setDisabled(user, true)}>{t("Disable")}</KagoMenuItem>
                </>
              )}
            </>
          }
        >
          <Ellipsis />
        </KagoDropdownMenu>
      ) : (
        <span className="size-6 shrink-0" aria-hidden />
      )}
    </li>
  );
}
