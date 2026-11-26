import { useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Trash2, Undo2 } from "lucide-react";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoSpinner } from "@/components/kago/empty-state";
import { FileIcon, FileTile } from "@/components/kago/file-icon";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem } from "@/components/kago/menu";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { formatSize, formatUnixDay, formatUnixTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { commonPlace, MEMBERS_FIRST, MEMBERS_MORE, placeText, totalOf, trashFolder, trashName, type Deletion, type TrashSection } from "@/lib/trashModel";
import { cn } from "@/lib/utils";
import type { TrashItem } from "@/types/kago";

/** What a card needs to know about the window around it, and what it can ask of it. */
export type TrashView = {
  now: number;
  meId: string | undefined;
  /** The viewer is an administrator, who is shown everyone's items and so is told whose each is. */
  showDeleter: boolean;
  /** Where an item came from, as the location is named now; null where that location cannot be named. */
  rootName: (rootId: string) => string | null;
  local: (rootId: string) => boolean;
  /** Items a task is already putting back or deleting. */
  busy: ReadonlySet<string>;
  restore: (items: readonly TrashItem[]) => void;
  destroy: (items: readonly TrashItem[]) => void;
};

const iconOf = (item: TrashItem) => ({ kind: item.kind ?? "file", type: "", name: trashName(item) }) as const;

/** The day's time within today and yesterday, where the day itself is the heading; a date under "Earlier". */
const whenText = (deletedAt: number, section: TrashSection, now: number) => (section === "earlier" ? formatUnixDay(deletedAt, now) : formatUnixTime(deletedAt));

/** How big, as far as that is known: the size, the least it is, that it is being worked out, or a quiet dash for never. */
function SizeCell({ items, view, count }: { items: readonly TrashItem[]; view: TrashView; /** The entries inside a folder, where one is shown alone. */ count?: boolean }) {
  const total = totalOf(items, (item) => view.local(item.original_root_id), view.now);
  const entries = count && items.length === 1 && items[0]!.item_count !== null ? items[0]!.item_count : null;
  let figure;
  if (total.complete) figure = <span>{formatSize(total.bytes)}</span>;
  else if (total.bytes > 0) figure = <KagoTooltip label={total.measuring ? t("At least {size}. The rest is still being measured.", { size: formatSize(total.bytes) }) : t("At least {size}. Not every size is known.", { size: formatSize(total.bytes) })}><span>{`≥ ${formatSize(total.bytes)}`}</span></KagoTooltip>;
  else if (total.measuring) figure = <KagoTooltip label={t("Measuring size…")}><span className="flex"><KagoSpinner className="size-3.5" /></span></KagoTooltip>;
  else figure = <KagoTooltip label={t("Size unknown")}><span className="text-faint" aria-label={t("Size unknown")}>–</span></KagoTooltip>;
  return (
    <span className="flex shrink-0 flex-col items-end text-xs leading-tight text-muted tabular-nums">
      {figure}
      {entries !== null ? <span className="text-[11px] text-faint">{t("{count} item | {count} items", { count: entries })}</span> : null}
    </span>
  );
}

function Deleter({ item, view }: { item: TrashItem; view: TrashView }) {
  if (!view.showDeleter || item.deleted_by === view.meId) return null;
  const who = item.deleter.display_name || item.deleter.email;
  return (
    <KagoTooltip label={t("Deleted by {name}", { name: who })}>
      <span className="flex shrink-0"><KagoAvatar name={who} picture={avatarUrl(item.deleter.id, item.deleter.avatar_at)} className="size-[18px] text-[10px]" /></span>
    </KagoTooltip>
  );
}

const cardClass = "kago-card flex h-[46px] shrink-0 items-center gap-2.5 pr-1.5 text-ink";

function MoreMenu({ onDelete, disabled }: { onDelete: () => void; disabled: boolean }) {
  return (
    <KagoDropdownMenu raised label={t("More actions")} className="size-6" menu={<KagoMenuItem icon={<Trash2 />} destructive disabled={disabled} onClick={onDelete}>{t("Delete for good…")}</KagoMenuItem>}>
      <Ellipsis />
    </KagoDropdownMenu>
  );
}

/** One item that was thrown away on its own: what it was, where it lay and when, how big, and the way back. */
export function TrashCard({ item, section, view }: { item: TrashItem; section: TrashSection; view: TrashView }) {
  const busy = view.busy.has(item.id);
  const place = placeText(view.rootName(item.original_root_id), trashFolder(item));
  return (
    <li className={cn(cardClass, "rounded-md border border-line pl-2.5")}>
      <FileTile item={iconOf(item)} className="size-6.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <KagoTooltip label={trashName(item)}><span className="min-w-0 truncate font-medium">{trashName(item)}</span></KagoTooltip>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="truncate">{[place ? t("was in {place}", { place }) : null, whenText(item.deleted_at, section, view.now)].filter(Boolean).join(" · ")}</span>
          <Deleter item={item} view={view} />
        </span>
      </div>
      <SizeCell items={[item]} view={view} count />
      <Button className="h-6 shrink-0 px-2 text-xs" disabled={busy} onClick={() => view.restore([item])}>{t("Restore")}</Button>
      <MoreMenu disabled={busy} onDelete={() => view.destroy([item])} />
    </li>
  );
}

/**
 * Several items that went in with one deletion, as one card that puts them all back, and opens onto them. A folder of
 * hundreds is not hundreds of lines: a few show, and the rest are asked for in steps.
 */
export function TrashGroupCard({ deletion, section, view }: { deletion: Deletion; section: TrashSection; view: TrashView }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(MEMBERS_FIRST);
  const { items } = deletion;
  const first = items[0]!;
  const busy = items.some((item) => view.busy.has(item.id));
  const common = commonPlace(items);
  const place = common ? placeText(view.rootName(common.rootId), common.folder) : t("several places");
  const members = items.slice(0, shown);
  return (
    <li className="kago-card shrink-0 overflow-hidden rounded-md border border-line text-ink">
      <div className={cn(cardClass, "pl-1.5")}>
        <KagoIconButton label={open ? t("Hide items") : t("Show items")} size="sm" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </KagoIconButton>
        <FileTile item={iconOf(first)} className="size-6.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate font-medium">{t("{name} and {count} more", { name: trashName(first), count: items.length - 1 })}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="truncate">{[place ? t("was in {place}", { place }) : null, whenText(deletion.deletedAt, section, view.now)].filter(Boolean).join(" · ")}</span>
            <Deleter item={first} view={view} />
          </span>
        </div>
        <SizeCell items={items} view={view} />
        <Button className="h-6 shrink-0 px-2 text-xs" disabled={busy} onClick={() => view.restore(items)}><Undo2 />{t("Restore all")}</Button>
        <MoreMenu disabled={busy} onDelete={() => view.destroy(items)} />
      </div>
      {open ? (
        <ul className="m-0 flex list-none flex-col border-t border-line bg-elevated p-0 py-1">
          {members.map((item) => (
            <li key={item.id} className="flex h-7 items-center gap-2 pr-1.5 pl-[52px] text-xs">
              <FileIcon item={iconOf(item)} className="size-4 shrink-0" />
              <KagoTooltip label={trashName(item)}><span className="min-w-0 flex-1 truncate">{trashName(item)}</span></KagoTooltip>
              <SizeCell items={[item]} view={view} />
              <Button className="h-5 shrink-0 px-2 text-xs" disabled={view.busy.has(item.id)} onClick={() => view.restore([item])}>{t("Restore")}</Button>
              <MoreMenu disabled={view.busy.has(item.id)} onDelete={() => view.destroy([item])} />
            </li>
          ))}
          {items.length > shown ? (
            <li className="flex h-7 items-center pl-[52px]">
              <Button className="h-5 px-2 text-xs" onClick={() => setShown((count) => count + MEMBERS_MORE)}>{t("{count} more…", { count: items.length - shown })}</Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
