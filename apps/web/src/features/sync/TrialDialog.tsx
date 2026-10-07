import { useMemo, useState, type ReactNode } from "react";
import { Check, Clock, Copy, FolderMinus, FolderPlus, Trash2 } from "lucide-react";
import { useSyncTrial } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoTooltip } from "@/components/kago/tooltip";
import { KagoVirtualList } from "@/components/kago/virtual-list";
import { Button } from "@/components/ui/button";
import { kindOfExtension, type FileKind } from "@/features/files/fileKind";
import { formatSize } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SyncChange, SyncJob, SyncTrial, SyncTrialSummary } from "@/types/kago";

type Action = SyncChange["action"];

/** What a trial run would have changed, in a few words. */
export function describeTrial(trial: SyncTrialSummary) {
  const parts = [
    trial.copy ? t("{count} to copy ({size})", { count: trial.copy, size: formatSize(trial.bytes) }) : null,
    trial.touch ? t("{count} to re-date", { count: trial.touch }) : null,
    trial.delete ? t("{count} to delete", { count: trial.delete }) : null,
    trial.mkdir ? t("{count} folder to make | {count} folders to make", { count: trial.mkdir }) : null,
    trial.rmdir ? t("{count} folder to remove | {count} folders to remove", { count: trial.rmdir }) : null
  ].filter(Boolean);
  return parts.length > 0 ? t("Trial run: {changes}", { changes: parts.join(" · ") }) : t("Trial run: nothing would change");
}

const actions: Record<Action, { label: string; tone: "neutral" | "accent" | "danger"; icon: ReactNode }> = {
  copy: { label: t("Copy"), tone: "accent", icon: <Copy /> },
  touch: { label: t("Re-date"), tone: "neutral", icon: <Clock /> },
  delete: { label: t("Delete"), tone: "danger", icon: <Trash2 /> },
  mkdir: { label: t("New folder"), tone: "accent", icon: <FolderPlus /> },
  rmdir: { label: t("Remove folder"), tone: "danger", icon: <FolderMinus /> }
};
const tileOrder: Action[] = ["copy", "delete", "mkdir", "rmdir", "touch"];
const tones = { neutral: "text-muted", accent: "text-accent", danger: "text-danger" };

/**
 * The families a copy is counted under, in the order they are drawn. The order is fixed, and so is each colour:
 * neighbours here are the ones that stay apart for eyes that mix red and green.
 */
const families = [
  { key: "image", label: t("Image"), color: "var(--kago-kind-image)" },
  { key: "video", label: t("Video"), color: "var(--kago-kind-video)" },
  { key: "audio", label: t("Audio"), color: "var(--kago-kind-audio)" },
  { key: "code", label: t("Code"), color: "var(--kago-kind-code)" },
  { key: "document", label: t("Document"), color: "var(--kago-kind-document)" },
  { key: "sheet", label: t("Spreadsheet"), color: "var(--kago-kind-sheet)" },
  { key: "archive", label: t("Archive"), color: "var(--kago-kind-archive)" },
  { key: "other", label: t("Other"), color: "var(--kago-text-faint)" }
] as const;
type Family = (typeof families)[number]["key"];

const familyOf: Partial<Record<FileKind, Family>> = { image: "image", video: "video", audio: "audio", code: "code", pdf: "document", document: "document", slides: "document", sheet: "sheet", archive: "archive" };

const share = (part: number, whole: number) => {
  const percent = whole > 0 ? (part / whole) * 100 : 0;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
};

/** One number of the trial run, and a way to see only the changes it counts. */
function Tile({ action, count, detail, pressed, onPress }: { action: Action; count: number; detail?: string; pressed: boolean; onPress: () => void }) {
  const { label, tone, icon } = actions[action];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={count === 0}
      onClick={onPress}
      className={cn(
        "kago-card flex min-w-0 flex-col gap-0.5 rounded-md border border-line px-3 py-2 text-left outline-none transition-colors",
        "enabled:hover:border-line-strong focus-visible:border-accent aria-pressed:border-accent aria-pressed:bg-accent-soft disabled:opacity-55"
      )}
    >
      <span className={cn("flex items-center gap-1.5 text-xs font-medium [&>.lucide]:size-3.5", count > 0 ? tones[tone] : "text-faint")}>
        {icon}
        <span className="truncate text-muted">{label}</span>
      </span>
      <strong className="text-2xl leading-7 font-semibold tabular-nums">{count.toLocaleString()}</strong>
      <span className="h-4 truncate text-xs text-muted">{detail}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-xs font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** What would be copied, as one bar divided among the kinds of file, and the same again in words. */
function Composition({ trial }: { trial: SyncTrial }) {
  const parts = useMemo(() => {
    const sums = new Map<Family, { count: number; bytes: number }>();
    for (const { extension, count, bytes } of trial.stats.extensions) {
      const family = familyOf[kindOfExtension(extension)] ?? "other";
      const sum = sums.get(family) ?? { count: 0, bytes: 0 };
      sums.set(family, { count: sum.count + count, bytes: sum.bytes + bytes });
    }
    return families.flatMap((family) => (sums.has(family.key) ? [{ ...family, ...sums.get(family.key)! }] : []));
  }, [trial]);
  // A copy of nothing but empty files still has something to divide: how many they are.
  const bySize = trial.bytes > 0;
  const whole = bySize ? trial.bytes : trial.copy;
  const weight = (part: { count: number; bytes: number }) => (bySize ? part.bytes : part.count);

  return (
    <Section title={t("What would be copied")}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {parts.filter((part) => weight(part) > 0).map((part) => (
          <KagoTooltip key={part.key} label={`${part.label} · ${formatSize(part.bytes)} · ${share(weight(part), whole)}`}>
            <span className="min-w-1 rounded-[2px]" style={{ flexGrow: weight(part), flexBasis: 0, background: part.color }} />
          </KagoTooltip>
        ))}
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center gap-2 text-xs">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: part.color }} />
            <span className="truncate">{part.label}</span>
            <span className="text-faint tabular-nums">{t("{count} file | {count} files", { count: part.count })}</span>
            <span className="ml-auto shrink-0 text-muted tabular-nums">{formatSize(part.bytes)}</span>
            <span className="w-8 shrink-0 text-right text-faint tabular-nums">{share(weight(part), whole)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The folders at the top that most would change in: how much would be copied into each, and how much deleted. */
function Folders({ trial }: { trial: SyncTrial }) {
  const { folders, moreFolders } = trial.stats;
  const most = Math.max(...folders.map((folder) => folder.copy + folder.delete), 1);
  return (
    <Section title={t("Where the changes are")}>
      {/* Every row is a grid of its own, so its columns are of set widths: the bars then share one left edge. */}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {folders.map((folder) => (
          <li key={folder.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-2 text-xs">
            <span className={cn("truncate", folder.name ? null : "text-muted")} title={folder.name}>{folder.name || t("Top of the folder")}</span>
            <KagoTooltip
              label={[folder.copy ? t("{count} to copy ({size})", { count: folder.copy, size: formatSize(folder.bytes) }) : null, folder.delete ? t("{count} to delete", { count: folder.delete }) : null].filter(Boolean).join(" · ")}
            >
              <span className="flex h-2 min-w-0">
                <span className="flex min-w-0 gap-0.5" style={{ width: `${((folder.copy + folder.delete) / most) * 100}%` }}>
                  {folder.copy ? <span className="min-w-1 rounded-[2px] bg-accent" style={{ flexGrow: folder.copy, flexBasis: 0 }} /> : null}
                  {folder.delete ? <span className="min-w-1 rounded-[2px] bg-danger" style={{ flexGrow: folder.delete, flexBasis: 0 }} /> : null}
                </span>
              </span>
            </KagoTooltip>
            <span className="text-right text-muted tabular-nums">{(folder.copy + folder.delete).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-accent" />{t("Copy")}</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-danger" />{t("Delete")}</span>
        {moreFolders > 0 ? <span className="ml-auto">{t("and {count} more folder | and {count} more folders", { count: moreFolders })}</span> : null}
      </p>
    </Section>
  );
}

const ROW_HEIGHT = 28;

function Report({ trial }: { trial: SyncTrial }) {
  const [only, setOnly] = useState<Action | null>(null);
  const shown = useMemo(() => (only ? trial.changes.filter((change) => change.action === only) : trial.changes), [trial, only]);
  const total = trial.copy + trial.delete + trial.mkdir + trial.rmdir + trial.touch;
  if (total === 0) return <KagoEmptyState icon={<Check />} title={t("Nothing would change")} description={t("The destination already has everything this sync would bring.")} />;

  const details: Partial<Record<Action, string>> = { copy: formatSize(trial.bytes), delete: trial.stats.freed > 0 ? formatSize(trial.stats.freed) : undefined };
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2">
        {tileOrder.filter((action) => action !== "touch" || trial.touch > 0).map((action) => (
          <Tile key={action} action={action} count={trial[action]} detail={details[action]} pressed={only === action} onPress={() => setOnly(only === action ? null : action)} />
        ))}
      </div>
      {trial.copy + trial.delete > 0 ? (
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {trial.copy > 0 ? <Composition trial={trial} /> : null}
          <Folders trial={trial} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-col gap-1.5">
        <div className="flex h-5 items-center gap-2 text-xs text-muted">
          <span>{only ? `${actions[only].label} · ` : null}{t("{count} change | {count} changes", { count: only ? trial[only] : total })}</span>
          {only ? <button type="button" className="text-accent hover:underline" onClick={() => setOnly(null)}>{t("Show all")}</button> : null}
          {trial.truncated ? <span className="ml-auto">{t("Only the first {count} changes are listed.", { count: trial.changes.length })}</span> : null}
        </div>
        {/* A new filter starts again from the top. */}
        <KagoVirtualList key={only ?? "all"} items={shown} rowHeight={ROW_HEIGHT} className="kago-well h-64 shrink-0 rounded-md">
          {(change) => (
            <div className="flex h-full items-center gap-2 border-b border-line px-2">
              <KagoBadge tone={actions[change.action].tone}>{actions[change.action].label}</KagoBadge>
              <span className="min-w-0 flex-1 truncate" title={change.path}>{change.path}</span>
              {change.action === "copy" && change.size !== undefined ? <span className="shrink-0 text-xs text-muted tabular-nums">{formatSize(change.size)}</span> : null}
            </div>
          )}
        </KagoVirtualList>
      </div>
    </>
  );
}

/** What the job's last trial run would have changed: what it adds up to, and every change of it. */
export function TrialDialog({ job, onClose }: { job: SyncJob | null; onClose: () => void }) {
  const trial = useSyncTrial(job);
  // The last job stays on show while its dialog fades out.
  const [shown, setShown] = useState(job);
  if (job && job !== shown) setShown(job);
  return (
    <KagoDialog open={job !== null} onClose={onClose} title={t("What {name} would change", { name: shown?.name ?? "" })} className="w-[min(720px,calc(100vw-32px))]">
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3">
        {trial.isLoading ? <KagoLoading /> : null}
        {trial.isError ? <p className="m-0 text-danger">{t("Couldn’t load the trial run")}</p> : null}
        {trial.data ? <Report trial={trial.data} /> : null}
        <div className="flex justify-end">
          <Button onClick={onClose}>{t("Close")}</Button>
        </div>
      </div>
    </KagoDialog>
  );
}
