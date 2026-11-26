import { useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Pencil, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { MEMBERS_FIRST, MEMBERS_MORE, personName } from "@/lib/peopleModel";
import { cn } from "@/lib/utils";
import type { Group } from "@/types/kago";
import { t } from "@/lib/i18n";

/** What a card can ask of the page, which holds the dialogs. */
export type GroupCardActions = {
  addMembers: (group: Group) => void;
  removeMember: (group: Group, memberId: string) => void;
  rename: (group: Group) => void;
  remove: (group: Group) => void;
};

/** What the rules that name the group let it do, in words; null before the rules are known, "none" where no rule names it. */
export type GroupAccess = { edit: string[]; view: string[] } | null;

const join = (names: string[]) => names.reduce((text, name) => t("{first}, {second}", { first: text, second: name }));

/** "can edit Photos, can view Media", or nothing where the rules are not known yet. */
function accessText(access: NonNullable<GroupAccess>) {
  const parts = [access.edit.length > 0 ? t("can edit {places}", { places: join(access.edit) }) : null, access.view.length > 0 ? t("can view {places}", { places: join(access.view) }) : null].filter((part): part is string => part !== null);
  return parts.length > 0 ? join(parts) : null;
}

/**
 * A group as a card of two lines: its name, and under it how many are in it and what it can reach. A group that no rule
 * names does nothing, and says so in the warning colour. It starts closed, and opens onto its members. `open` is
 * forced by a search that found the group through someone in it.
 */
export function GroupCard({ group, members, access, disabled, open, onToggle, actions }: { group: Group; /** The members to list: all of them, or the ones a search found. */ members: Group["members"]; access: GroupAccess; /** The ids of the users who are switched off; a group does not know that of its members. */ disabled: ReadonlySet<string>; open: boolean; onToggle: () => void; actions: GroupCardActions }) {
  const [shown, setShown] = useState(MEMBERS_FIRST);
  const count = t("{count} member | {count} members", { count: group.members.length });
  const reach = access ? accessText(access) : null;
  const line = [count, reach].filter(Boolean).join(" · ");
  const stack = group.members.slice(0, 3);

  return (
    <li className="kago-card shrink-0 overflow-hidden rounded-md border border-line text-ink">
      <div className="flex h-[46px] items-center gap-2.5 pr-1.5 pl-1.5">
        <KagoIconButton label={open ? t("Hide members") : t("Show members")} size="sm" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </KagoIconButton>
        {/* One width for every card, so the names line up whether a group has one member or three. */}
        <span className="flex w-14 shrink-0">
          {stack.length > 0 ? (
            stack.map((member, index) => <KagoAvatar key={member.id} name={personName(member)} picture={avatarUrl(member.id, member.avatar_at)} className={cn("size-6 text-[11px] ring-2 ring-surface", index > 0 && "-ml-2", disabled.has(member.id) && "text-faint")} />)
          ) : (
            <KagoStatusIcon className="size-6 [&>.lucide]:size-3.5"><UsersRound /></KagoStatusIcon>
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <KagoTooltip label={group.name}><span className="min-w-0 truncate font-medium">{group.name}</span></KagoTooltip>
          <KagoTooltip label={access && !reach ? `${line} · ${t("no permissions yet")}` : line}>
            <span className="min-w-0 truncate text-xs text-muted">
              {line}
              {access && !reach ? <span className="text-warning">{line ? " · " : ""}{t("no permissions yet")}</span> : null}
            </span>
          </KagoTooltip>
        </div>
        <Button className="h-6 shrink-0 px-2 text-xs" onClick={() => actions.addMembers(group)}><UserPlus />{t("Add members")}</Button>
        <KagoDropdownMenu
          raised
          label={t("More actions")}
          className="size-6"
          menu={
            <>
              <KagoMenuItem icon={<Pencil />} onClick={() => actions.rename(group)}>{t("Rename…")}</KagoMenuItem>
              <KagoMenuSeparator />
              <KagoMenuItem icon={<Trash2 />} destructive onClick={() => actions.remove(group)}>{t("Delete…")}</KagoMenuItem>
            </>
          }
        >
          <Ellipsis />
        </KagoDropdownMenu>
      </div>
      {open ? (
        <ul className="m-0 flex list-none flex-col border-t border-line bg-elevated p-0 py-1">
          {members.length === 0 ? <li className="flex h-7 items-center pl-[52px] text-xs text-muted">{t("This group has no members yet.")}</li> : null}
          {members.slice(0, shown).map((member) => (
            <li key={member.id} className="flex h-8 items-center gap-2 pr-1.5 pl-[52px]">
              <KagoAvatar name={personName(member)} picture={avatarUrl(member.id, member.avatar_at)} className={cn("size-5 text-[10px]", disabled.has(member.id) && "text-faint")} />
              <KagoTooltip label={member.email}><span className={cn("min-w-0 truncate", disabled.has(member.id) && "text-muted")}>{personName(member)}</span></KagoTooltip>
              {disabled.has(member.id) ? <span className="shrink-0 text-faint">{t("Disabled")}</span> : null}
              <span className="flex-1" />
              <KagoIconButton label={t("Remove {member} from {group}", { member: personName(member), group: group.name })} size="sm" onClick={() => actions.removeMember(group, member.id)}><X /></KagoIconButton>
            </li>
          ))}
          {members.length > shown ? (
            <li className="flex h-7 items-center pl-[52px]">
              <Button className="h-5 px-2 text-xs" onClick={() => setShown((was) => was + MEMBERS_MORE)}>{t("{count} more members…", { count: members.length - shown })}</Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
