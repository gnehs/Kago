import { useEffect, useState } from "react";
import { Cog, Link2 } from "lucide-react";
import { useAuditRun } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { Detail, DetailList } from "@/components/kago/details";
import { KagoSpinner } from "@/components/kago/empty-state";
import { taskTypeName } from "@/features/tasks/taskUtils";
import { actorOf, describe, factsOf, placeOf, timeSpan, type Actor, type FactLabel, type Names, type Tail } from "@/lib/auditModel";
import { errorMessage, formatUnixClock, formatUnixDateTime, formatUnixTime24 } from "@/lib/format";
import { startOfDay } from "@/lib/days";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import type { AuditLog } from "@/types/kago";
import { t } from "@/lib/i18n";
import { sentenceMessage } from "./auditText";

/** What a part of a sentence stands for when the row does not say: a deleted user, a group that is gone. */
const slotDefaults: Record<string, () => string> = {
  person: () => t("a deleted user"),
  group: () => t("a deleted group"),
  who: () => t("someone"),
  place: () => t("a location"),
  from: () => t("a folder"),
  to: () => t("somewhere else"),
  name: () => t("unnamed"),
  path: () => t("a file"),
  count: () => t("several")
};

/** Each name a message may use, standing for itself, so that the message comes back with its places marked and the card can set each in its own weight. */
const SLOTS = { actor: "{actor}", person: "{person}", group: "{group}", who: "{who}", place: "{place}", from: "{from}", to: "{to}", name: "{name}", path: "{path}", count: "{count}" };

const actorText = (actor: Actor) => {
  switch (actor.kind) {
    case "user":
      return actor.name;
    case "deleted_user":
      return t("A deleted user");
    case "share_link":
      return t("Share link");
    case "system":
      return t("System");
    case "someone":
      return t("Someone");
  }
};

const tailText = (tail: Tail): string => (typeof tail === "string" ? tail : "taskType" in tail ? taskTypeName(tail.taskType) : tail.more ? t("{count}+ folders", { count: tail.folders }) : t("{count} folder | {count} folders", { count: tail.folders }));

const factLabels: Record<FactLabel, () => string> = {
  email: () => t("Email"),
  path: () => t("Path"),
  from: () => t("Origin"),
  to: () => t("Destination"),
  sources: () => t("Items"),
  tags: () => t("Tags"),
  reason: () => t("Reason"),
  request: () => t("Request"),
  source: () => t("Source"),
  browser: () => t("Browser")
};

/** Who is drawn at the head of a row: their picture, or for what is not a person a glyph in the same round plate. */
function ActorMark({ actor, picture }: { actor: Actor; picture: string | null }) {
  if (actor.kind === "user") return <KagoAvatar name={actor.name} picture={picture} className="size-5 text-[10px]" />;
  if (actor.kind === "share_link" || actor.kind === "system") {
    return (
      <span aria-hidden className="kago-badge flex size-5 shrink-0 items-center justify-center rounded-full text-muted">
        {actor.kind === "share_link" ? <Link2 className="size-3" /> : <Cog className="size-3" />}
      </span>
    );
  }
  return <KagoAvatar name="?" className="size-5 text-[10px] text-muted" />;
}

const WIDE = /[\u2E80-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * The words between two names, without the space a translation leaves beside a name where the name turned out to be
 * written in the same script as the words: "Mei-Ling Chen 的請求" is set apart, "有人的請求" is not.
 */
function unspaced(words: string, before = "", after = "") {
  let text = words;
  if (text.startsWith(" ") && WIDE.test(before.slice(-1)) && WIDE.test(text.charAt(1))) text = text.slice(1);
  if (text.endsWith(" ") && WIDE.test(after.charAt(0)) && WIDE.test(text.charAt(text.length - 2))) text = text.slice(0, -1);
  return text;
}

/** The sentence of a row with its actor in the heavier weight and what it is about in the muted colour. */
function Sentence({ row, names, quiet }: { row: AuditLog; names: Names; quiet: boolean }) {
  const sentence = describe(row, names);
  const actor = actorOf(row);
  const parts = sentenceMessage[sentence.id](SLOTS)
    .split(/(\{\w+\})/)
    .map((part) => {
      const slot = /^\{(\w+)\}$/.exec(part)?.[1];
      if (!slot) return { text: part };
      return { slot, text: slot === "actor" ? actorText(actor) : (sentence.slots[slot as keyof typeof sentence.slots] ?? slotDefaults[slot]?.() ?? "") };
    });
  const tails = sentence.tail.map(tailText);
  return (
    <span className="min-w-0 flex-1 truncate">
      {parts.map((part, index) => {
        if (!part.slot) return unspaced(part.text, parts[index - 1]?.text, parts[index + 1]?.text);
        return <span key={index} className={part.slot !== "actor" || quiet ? "text-muted" : "font-medium"}>{part.text}</span>;
      })}
      {tails.length ? <span className="text-muted"> · {tails.join(" · ")}</span> : null}
    </span>
  );
}

/** The word at the end of a row that did not go through. A row that did says nothing. */
function Outcome({ result }: { result: AuditLog["result"] }) {
  if (result === "success") return null;
  return <span className="shrink-0 text-xs text-danger">{result === "failure" ? t("Failed") : t("Refused")}</span>;
}

/** When a run began and ended: the clock times of one day, or the whole of both where it went past midnight; and how many rows it was. */
function runTime(row: AuditLog, count: number) {
  const { from, to } = timeSpan(row);
  const format = startOfDay(from) === startOfDay(to) ? formatUnixTime24 : formatUnixDateTime;
  return t("{from} – {to}, {count} times", { from: format(from), to: format(to), count });
}

/** One member of a run: when it was and what it was about, for rows that are all the same thing. */
function MemberRow({ row, names }: { row: AuditLog; names: Names }) {
  const what = placeOf(row, names) ?? describe(row, names).tail.map(tailText).join(" · ");
  return (
    <li className="flex h-6.5 items-center gap-2">
      <span className="w-18 shrink-0 text-faint tabular-nums">{formatUnixClock(row.created_at)}</span>
      <span className="min-w-0 flex-1 truncate">{what || row.ip || ""}</span>
      {row.result === "success" ? null : <span className="shrink-0 text-danger">{row.result === "failure" ? t("Failed") : t("Refused")}</span>}
    </li>
  );
}

/** The members of an opened run: five at first, fetched when it was opened, and a "more…" for each fifty after. */
function RunMembers({ row, names }: { row: AuditLog; names: Names }) {
  const burst = row.burst!;
  const members = useAuditRun(burst.id, burst.count, true);
  const failed = members.error;
  useEffect(() => {
    if (failed) toast(errorMessage(failed, t("Something went wrong")), "error");
  }, [failed]);
  const rows = members.data?.pages.flat() ?? [];
  const left = burst.count - rows.length;
  return (
    <div className="mt-2 border-t border-line pt-1.5">
      {failed ? <p className="m-0 py-1 text-muted">{t("The run is no longer kept.")}</p> : null}
      {members.isLoading ? <div className="flex h-6.5 items-center"><KagoSpinner /></div> : null}
      {rows.length > 0 ? <ul className="m-0 flex list-none flex-col p-0">{rows.map((member) => <MemberRow key={member.id} row={member} names={names} />)}</ul> : null}
      {members.hasNextPage && !failed ? (
        <button type="button" className="mt-0.5 flex h-6.5 items-center gap-1.5 rounded-md text-muted outline-none hover:text-ink focus-ring" disabled={members.isFetchingNextPage} onClick={() => void members.fetchNextPage()}>
          {members.isFetchingNextPage ? <KagoSpinner className="text-inherit" /> : null}
          {t("{count} more…", { count: left })}
        </button>
      ) : null}
    </div>
  );
}

/** What an opened row tells: when, where it came from, what it was about, and for a run, its members. */
function Details({ row, names }: { row: AuditLog; names: Names }) {
  const facts = factsOf(row, names);
  const folders = row.burst && row.burst.folders.length > 1 ? row.burst.folders.map((folder) => placeOf({ root_id: folder.root_id, root_name: null, path: folder.path }, names)).filter(Boolean) : [];
  return (
    <div className="border-t border-line bg-elevated py-2 pr-3 pl-13 text-xs text-muted">
      <DetailList>
        <Detail label={t("Time")}>{row.burst ? runTime(row, row.burst.count) : formatUnixDateTime(row.created_at)}</Detail>
        {facts.map((fact) => <Detail key={fact.label} label={factLabels[fact.label]()}>{fact.value}</Detail>)}
        {folders.length > 0 ? <Detail label={t("Folders")}>{`${folders.slice(0, 5).join(", ")}${row.burst!.folders_truncated || folders.length > 5 ? "…" : ""}`}</Detail> : null}
      </DetailList>
      {row.burst ? <RunMembers row={row} names={names} /> : null}
    </div>
  );
}

/**
 * An event as a card of one line: when, who, and a sentence of what they did and to what. A row that did not go
 * through says so at its end; a run says how many rows it stands for. It opens in place onto where it came from.
 */
export function AuditCard({ row, names, avatars }: { row: AuditLog; names: Names; avatars: ReadonlyMap<string, number | null> }) {
  const [open, setOpen] = useState(false);
  const actor = actorOf(row);
  const quiet = row.signal === "low";
  const picture = row.actor_id ? avatarUrl(row.actor_id, avatars.get(row.actor_id)) : null;
  return (
    <li className={cn("kago-card overflow-hidden rounded-md border border-line", quiet && "bg-elevated")}>
      <button type="button" aria-expanded={open} className="flex h-8 w-full items-center gap-2 pr-2 pl-2.5 text-left outline-none hover:bg-hover focus-ring focus-visible:ring-inset" onClick={() => setOpen((value) => !value)}>
        <span className="min-w-10 shrink-0 text-xs text-faint tabular-nums">{formatUnixTime24(row.created_at)}</span>
        <ActorMark actor={actor} picture={picture} />
        <Sentence row={row} names={names} quiet={quiet} />
        {row.burst ? <span className="shrink-0 rounded-full bg-hover px-1.5 text-xs text-muted tabular-nums">×{row.burst.count}</span> : null}
        <Outcome result={row.result} />
      </button>
      {open ? <Details row={row} names={names} /> : null}
    </li>
  );
}
