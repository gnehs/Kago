import { Ban, CalendarClock, Copy, Ellipsis, Gauge, Link2, Lock, RefreshCw, Trash2 } from "lucide-react";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { FileTile } from "@/components/kago/file-icon";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { displayPath } from "@/lib/paths";
import { parseShareMode, shareEnds, shareExpiry, shareFix, shareFigure, shareIsDropBox, shareIsFolder, shareName } from "@/lib/shareModel";
import { cn } from "@/lib/utils";
import type { ShareLink } from "@/types/kago";
import { endText, expiryText, figureText, shareIconItem, visitorCan } from "./shareUtils";
import { t } from "@/lib/i18n";

/** What can be done to a card; the page answers each, since it asks the questions and holds the dialogs. */
export type ShareCardActions = {
  copy: (share: ShareLink) => void;
  rotate: (share: ShareLink) => void;
  /** `enable` is set where the same save also has to switch the link on. */
  changeExpiry: (share: ShareLink, enable?: boolean) => void;
  changeLimit: (share: ShareLink, enable?: boolean) => void;
  setDisabled: (share: ShareLink, disabled: boolean) => void;
  remove: (share: ShareLink) => void;
};

/**
 * A share as a card of two lines: its name, and under it what a visitor can do and until when, or, for one that has
 * stopped, why. It has one button, the thing most wanted of it: copying the link, or for a link that no longer works
 * what brings it back. The rest is in the menu. `creator` is set where the card is someone else's.
 */
export function ShareCard({ share, rootName, now, creator, actions }: { share: ShareLink; rootName: string; now: number; /** Who made it, when that is not the person looking. */ creator?: boolean; actions: ShareCardActions }) {
  const ends = shareEnds(share, now);
  const end = ends[0];
  const fix = shareFix(ends);
  const expiry = shareExpiry(share, now);
  const figure = shareFigure(share);
  const name = shareName(share, rootName);
  const dropBox = shareIsDropBox(share);
  const folder = shareIsFolder(share);
  const who = share.creator.display_name || share.creator.email;
  // The one button: bring a stopped link back by what stopped it, copy a working one, or give one that cannot be copied a link that can.
  // A link that was switched off and has also run out is not brought back by switching it on: what it ran out of is given in the same save.
  const main = fix
    ? fix.open === "expiry"
      ? { label: fix.enable ? t("Extend and enable") : t("Extend"), run: () => actions.changeExpiry(share, fix.enable) }
      : fix.open === "limit"
        ? { label: fix.enable ? t("Raise limit and enable") : t("Raise limit"), run: () => actions.changeLimit(share, fix.enable) }
        : { label: t("Enable"), run: () => actions.setDisabled(share, false) }
    : share.token
      ? { label: t("Copy link"), icon: <Copy />, run: () => actions.copy(share) }
      : { label: t("New link"), icon: <Link2 />, run: () => actions.rotate(share), why: t("This link was made before Kago kept links, so it can’t be copied. A new link can.") };
  const rotateMain = !fix && !share.token;
  const button = (
    <Button className="h-6 shrink-0 px-2 text-xs" onClick={main.run}>
      {"icon" in main ? main.icon : null}
      {main.label}
    </Button>
  );

  return (
    <li className={cn("kago-card flex h-[46px] shrink-0 items-center gap-2.5 rounded-md border border-line pr-1.5 pl-2.5 text-ink", end && "bg-elevated")}>
      <FileTile item={shareIconItem(share, rootName)} className="size-6.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <KagoTooltip label={displayPath(rootName, share.path)}>
          <span className={cn("min-w-0 truncate", end ? "text-muted" : "font-medium")}>{name}</span>
        </KagoTooltip>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          {end ? (
            <span className="truncate">{ends.map((one) => endText(one, folder)).join(" · ")}</span>
          ) : (
            <span className="truncate">
              {visitorCan(parseShareMode(share.permission_json), folder)} · <span className={cn(expiry.kind === "in" && expiry.soon && "text-warning")}>{expiryText(expiry)}</span>
            </span>
          )}
          {share.has_password ? (
            <KagoTooltip label={t("Password protected")}>
              <Lock className="size-3 shrink-0" aria-label={t("Password protected")} />
            </KagoTooltip>
          ) : null}
        </span>
      </div>
      {figure && !end ? (
        <KagoTooltip label={figure.kind === "limit" ? (folder ? t("{count} of {max} visitors", { count: figure.used, max: figure.max }) : t("{count} of {max} downloads", { count: figure.used, max: figure.max })) : figureText(figure, folder)}>
          <span className="shrink-0 text-xs text-muted tabular-nums">{figureText(figure, folder)}</span>
        </KagoTooltip>
      ) : null}
      {creator ? (
        <KagoTooltip label={t("Made by {name}", { name: who })}>
          <span className="flex shrink-0"><KagoAvatar name={who} picture={avatarUrl(share.creator.id, share.creator.avatar_at)} className="size-[18px] text-[10px]" /></span>
        </KagoTooltip>
      ) : null}
      {"why" in main ? <KagoTooltip label={main.why}>{button}</KagoTooltip> : button}
      <KagoDropdownMenu
        raised
        label={t("More actions")}
        className="size-6"
        menu={
          <>
            {rotateMain ? null : <KagoMenuItem icon={<RefreshCw />} onClick={() => actions.rotate(share)}>{t("New link…")}</KagoMenuItem>}
            {fix?.open === "expiry" ? null : <KagoMenuItem icon={<CalendarClock />} onClick={() => actions.changeExpiry(share)}>{t("Change expiry…")}</KagoMenuItem>}
            {dropBox || fix?.open === "limit" ? null : <KagoMenuItem icon={<Gauge />} onClick={() => actions.changeLimit(share)}>{folder ? t("Change visitor limit…") : t("Change download limit…")}</KagoMenuItem>}
            {fix?.enable ? null : <KagoMenuItem icon={<Ban />} onClick={() => actions.setDisabled(share, true)}>{t("Disable")}</KagoMenuItem>}
            <KagoMenuSeparator />
            <KagoMenuItem icon={<Trash2 />} destructive onClick={() => actions.remove(share)}>{t("Delete")}</KagoMenuItem>
          </>
        }
      >
        <Ellipsis />
      </KagoDropdownMenu>
    </li>
  );
}
