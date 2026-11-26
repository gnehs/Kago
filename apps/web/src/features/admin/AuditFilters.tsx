import { useState } from "react";
import { CalendarDays, Check, ChevronDown, UserRound } from "lucide-react";
import { KagoMenuCheckItem, KagoDropdownMenu, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoPopover } from "@/components/kago/popover";
import { Input } from "@/components/ui/input";
import { personName } from "@/lib/peopleModel";
import { cn } from "@/lib/utils";
import { ANY_DATE, type DateRange } from "@/lib/auditModel";
import type { UserAccount } from "@/types/kago";
import { t } from "@/lib/i18n";

/** Whose events to read: everyone, the server itself, visitors through share links, or one person. `actor` is "" for everyone. */
export function PersonFilter({ actor, users, onChange }: { actor: string; users: readonly UserAccount[]; onChange: (actor: string) => void }) {
  const sorted = [...users].sort((a, b) => personName(a).localeCompare(personName(b), undefined, { numeric: true }));
  const chosen = actor === "" ? t("Everyone") : actor === "system" ? t("System") : actor === "share_link" ? t("Share link visitors") : (users.find((user) => user.id === actor) ? personName(users.find((user) => user.id === actor)!) : t("A deleted user"));
  return (
    <KagoDropdownMenu
      raised
      wide
      align="start"
      label={t("Filter by person")}
      className="max-w-44"
      menu={
        <>
          <KagoMenuCheckItem checked={actor === ""} onClick={() => onChange("")}>{t("Everyone")}</KagoMenuCheckItem>
          <KagoMenuSeparator />
          <KagoMenuCheckItem checked={actor === "system"} onClick={() => onChange("system")}>{t("System")}</KagoMenuCheckItem>
          <KagoMenuCheckItem checked={actor === "share_link"} onClick={() => onChange("share_link")}>{t("Share link visitors")}</KagoMenuCheckItem>
          {sorted.length > 0 ? <KagoMenuSeparator /> : null}
          {sorted.map((user) => <KagoMenuCheckItem key={user.id} checked={actor === user.id} onClick={() => onChange(user.id)}>{personName(user)}</KagoMenuCheckItem>)}
        </>
      }
    >
      <UserRound className="size-3.5 shrink-0 text-muted" />
      <span className="truncate">{chosen}</span>
      <ChevronDown className="size-3.5 shrink-0 text-muted" />
    </KagoDropdownMenu>
  );
}

const presets: Array<{ preset: "today" | "yesterday" | "week" | "month"; label: () => string }> = [
  { preset: "today", label: () => t("Today") },
  { preset: "yesterday", label: () => t("Yesterday") },
  { preset: "week", label: () => t("Last 7 days") },
  { preset: "month", label: () => t("Last 30 days") }
];

const dateLabel = (range: DateRange): string => {
  if (range.kind === "any") return t("Date");
  if (range.kind === "preset") return presets.find((item) => item.preset === range.preset)!.label();
  if (range.from && range.to) return `${range.from} – ${range.to}`;
  return range.from ? t("Since {date}", { date: range.from }) : range.to ? t("Until {date}", { date: range.to }) : t("Date");
};

/** When to read: a stretch ending now, or two dates, either of which may be left open. */
export function DateFilter({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  const [open, setOpen] = useState(false);
  const custom = range.kind === "custom" ? range : { kind: "custom" as const, from: "", to: "" };
  const choose = (next: DateRange) => {
    onChange(next);
    setOpen(false);
  };
  const row = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-hover focus-ring";
  const setDates = (patch: Partial<typeof custom>) => {
    const next = { ...custom, ...patch };
    onChange(next.from || next.to ? next : ANY_DATE);
  };
  const panel = (
    <div className="flex flex-col gap-0.5">
      <button type="button" className={row} onClick={() => choose(ANY_DATE)}>
        {range.kind === "any" ? <Check className="size-4" /> : <span className="size-4" />}
        {t("Any time")}
      </button>
      {presets.map((item) => (
        <button key={item.preset} type="button" className={row} onClick={() => choose({ kind: "preset", preset: item.preset })}>
          {range.kind === "preset" && range.preset === item.preset ? <Check className="size-4" /> : <span className="size-4" />}
          {item.label()}
        </button>
      ))}
      <p className="m-0 mt-2 px-2 pb-1 text-xs font-semibold text-muted">{t("Custom range")}</p>
      <label className="flex items-center gap-2 px-2 text-xs text-muted">
        <span className="w-10 shrink-0">{t("Since")}</span>
        <Input type="date" value={custom.from} max={custom.to || undefined} onChange={(event) => setDates({ from: event.target.value })} />
      </label>
      <label className="mt-1 flex items-center gap-2 px-2 text-xs text-muted">
        <span className="w-10 shrink-0">{t("Until")}</span>
        <Input type="date" value={custom.to} min={custom.from || undefined} onChange={(event) => setDates({ to: event.target.value })} />
      </label>
    </div>
  );
  return (
    <KagoPopover raised wide label={t("Filter by date")} open={open} onOpenChange={setOpen} panel={panel} panelClassName="w-60">
      <CalendarDays className="size-3.5 shrink-0 text-muted" />
      <span className={cn(range.kind !== "any" && "font-medium")}>{dateLabel(range)}</span>
      <ChevronDown className="size-3.5 shrink-0 text-muted" />
    </KagoPopover>
  );
}
