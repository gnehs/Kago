import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Clock, Ellipsis, FileDiff, History, Pause, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "@/api/client";
import { useSyncJobs } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { isActiveTask, taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { Card, Page, Row, RowList } from "@/components/kago/page";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { formatUnixDate } from "@/lib/format";
import { displayPath, normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { Actor, FileTask, Root, SyncEndpoint, SyncJob, SyncSchedule } from "@/types/kago";
import { RunsDialog } from "./RunsDialog";
import { describeTrial, TrialDialog } from "./TrialDialog";
import { t } from "@/lib/i18n";

const weekdays = [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")];

function describeSchedule(schedule: SyncSchedule | null) {
  if (!schedule) return t("Runs only when started");
  if (schedule.kind === "daily") return t("Every day at {time}", { time: schedule.time });
  if (schedule.kind === "weekly") return t("Every {weekday} at {time}", { weekday: weekdays[schedule.weekday] ?? "", time: schedule.time });
  return schedule.minutes % 60 === 0
    ? t("Every {count} hour | Every {count} hours", { count: schedule.minutes / 60 })
    : t("Every {count} minute | Every {count} minutes", { count: schedule.minutes });
}

/** The glyph for how a sync's last run ended, or for the run it is in the middle of. */
function statusGlyph(status: string | null) {
  if (status === "done") return <Check />;
  if (status === "running") return <RefreshCw className="animate-spin" />;
  if (status === "queued") return <Clock />;
  if (status === "pausing" || status === "paused") return <Pause />;
  if (status === "cancelled") return <Ban />;
  if (status === "failed" || status === "interrupted") return <X />;
  return <RefreshCw />;
}

export function SyncPage({ roots, user }: { roots: Root[]; user: Actor }) {
  const queryClient = useQueryClient();
  const jobs = useSyncJobs();
  const [editing, setEditing] = useState<SyncJob | true | null>(null);
  const [trialOf, setTrialOf] = useState<string | null>(null);
  const [runsOf, setRunsOf] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sync-jobs"] });
  const describeEndpoint = (endpoint: SyncEndpoint) => displayPath(roots.find((root) => root.slug === endpoint.rootSlug)?.name ?? endpoint.rootSlug, endpoint.path);

  async function start(job: SyncJob) {
    await run(async () => {
      await api<FileTask>(`/api/sync-jobs/${job.id}/run`, { method: "POST" });
      toast(t("{name} started", { name: job.name }));
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["tasks"] })]);
    }, t("Couldn’t start the sync"));
  }

  async function remove(job: SyncJob) {
    if (!(await confirmAction({ title: t("Delete {name}?", { name: job.name }), description: t("Files it has already synced stay where they are."), confirmLabel: t("Delete"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/sync-jobs/${job.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  const addButton = roots.length > 0 ? <Button variant="default" onClick={() => setEditing(true)}><Plus />{t("Add sync")}</Button> : null;

  return (
    <Page
      title={t("Sync")}
      description={t("Keep a folder of one location the same as a folder of another.")}
      actions={jobs.data?.length && !editing ? addButton : null}
    >
      {editing ? (
        <Card title={editing === true ? t("Add sync") : t("Edit {name}", { name: editing.name })} action={<KagoIconButton label={t("Close")} onClick={() => setEditing(null)}><X /></KagoIconButton>}>
          <SyncForm key={editing === true ? "new" : editing.id} roots={roots} job={editing === true ? null : editing} onSaved={async () => { setEditing(null); await refresh(); }} />
        </Card>
      ) : null}
      {jobs.isLoading ? <KagoLoading /> : null}
      {jobs.data?.length === 0 && !editing ? (
        <KagoEmptyState icon={<RefreshCw />} title={t("No syncs yet")} description={t("A sync copies what is new or changed from one folder to another, when you start it or on a schedule.")}>
          {addButton}
        </KagoEmptyState>
      ) : null}
      {jobs.data?.length ? (
        <RowList>
          {jobs.data.map((job) => {
            const last = job.last_status ? taskStatus({ status: job.last_status } as FileTask) : null;
            const running = job.last_status === "queued" || job.last_status === "running";
            return (
              <Row
                key={job.id}
                // How its last run ended is shown by the icon at the head of the row; the end of the row is for what can be done.
                icon={<KagoStatusIcon tone={last?.tone} label={last?.label ?? t("No runs yet")}>{statusGlyph(job.last_status)}</KagoStatusIcon>}
                title={job.name}
                subtitle={
                  <>
                    {/* Where it goes and when it runs each get a line: on one they push each other out of sight. */}
                    <span className="block truncate">{`${describeEndpoint(job.source)} → ${describeEndpoint(job.destination)}`}</span>
                    <span className="block truncate">
                      {[
                        // A run that is under way, or waiting, is said in words too: the icon alone has to be pointed at.
                        last && isActiveTask({ status: job.last_status } as FileTask) ? last.label : null,
                        job.enabled ? describeSchedule(job.schedule) : t("Schedule paused"),
                        job.last_error ? taskErrorLabel(job.last_error) : job.last_run_at ? t("Last run {date}", { date: formatUnixDate(job.last_run_at) }) : null,
                        job.created_by !== user.id ? t("Someone else’s") : null
                      ].filter(Boolean).join(" · ")}
                    </span>
                    {/* What a trial run found is the whole point of it, so it has a line to itself. */}
                    {job.last_trial ? <span className="block truncate">{describeTrial(job.last_trial)}</span> : null}
                  </>
                }
              >
                <Button disabled={running} onClick={() => void start(job)}>{t("Run now")}</Button>
                {/* Running it is what a row is for; the rest is asked for now and then, and waits in the menu, whose button is the same kind of button. */}
                <KagoDropdownMenu
                  raised
                  label={t("More actions")}
                  menu={
                    <>
                      {job.last_trial ? <KagoMenuItem icon={<FileDiff />} onClick={() => setTrialOf(job.id)}>{t("See changes")}</KagoMenuItem> : null}
                      <KagoMenuItem icon={<History />} disabled={!job.last_run_at} onClick={() => setRunsOf(job.id)}>{t("History")}</KagoMenuItem>
                      <KagoMenuItem icon={<Pencil />} onClick={() => setEditing(job)}>{t("Edit")}</KagoMenuItem>
                      <KagoMenuSeparator />
                      <KagoMenuItem icon={<Trash2 />} destructive onClick={() => void remove(job)}>{t("Delete")}</KagoMenuItem>
                    </>
                  }
                >
                  <Ellipsis />
                </KagoDropdownMenu>
              </Row>
            );
          })}
        </RowList>
      ) : null}
      <RunsDialog job={jobs.data?.find((job) => job.id === runsOf) ?? null} onClose={() => setRunsOf(null)} />
      <TrialDialog job={jobs.data?.find((job) => job.id === trialOf && job.last_trial) ?? null} onClose={() => setTrialOf(null)} />
    </Page>
  );
}

type EndpointDraft = { rootSlug: string; path: string };

const draftOf = (endpoint: SyncEndpoint | undefined, roots: Root[]): EndpointDraft => ({ rootSlug: endpoint?.rootSlug ?? roots[0]?.slug ?? "", path: endpoint?.path ?? "/" });

function endpointOf(draft: EndpointDraft): SyncEndpoint | null {
  const path = normalizeLogicalPath(draft.path);
  return draft.rootSlug && path ? { kind: "location", rootSlug: draft.rootSlug, path } : null;
}

function SyncForm({ roots, job, onSaved }: { roots: Root[]; job: SyncJob | null; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(job?.name ?? "");
  const [source, setSource] = useState(() => draftOf(job?.source, roots));
  // A new sync starts out between two different locations when there are two.
  const [destination, setDestination] = useState(() => draftOf(job?.destination, roots.length > 1 ? [roots[1]!, ...roots] : roots));
  const [mode, setMode] = useState(job?.options.mode ?? "copy");
  const [dryRun, setDryRun] = useState(job?.options.dryRun ?? false);
  const [when, setWhen] = useState<"manual" | SyncSchedule["kind"]>(job?.schedule?.kind ?? "manual");
  const interval = job?.schedule?.kind === "interval" ? job.schedule.minutes : 60;
  const [every, setEvery] = useState(String(interval % 60 === 0 ? interval / 60 : interval));
  const [unit, setUnit] = useState<"minutes" | "hours">(interval % 60 === 0 ? "hours" : "minutes");
  const [time, setTime] = useState(job?.schedule && job.schedule.kind !== "interval" ? job.schedule.time : "03:00");
  const [weekday, setWeekday] = useState(job?.schedule?.kind === "weekly" ? job.schedule.weekday : 1);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);

  const minutes = Number(every) * (unit === "hours" ? 60 : 1);
  const schedule: SyncSchedule | null = when === "manual" ? null : when === "interval" ? { kind: "interval", minutes } : when === "daily" ? { kind: "daily", time } : { kind: "weekly", weekday, time };
  const from = endpointOf(source);
  const to = endpointOf(destination);
  const canSubmit = name.trim().length > 0 && from !== null && to !== null && (when !== "interval" || (Number.isInteger(minutes) && minutes >= 5));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const body = JSON.stringify({ name: name.trim(), source: from, destination: to, options: { mode, dryRun }, schedule, enabled });
    const saved = await run(async () => {
      await api(job ? `/api/sync-jobs/${job.id}` : "/api/sync-jobs", { method: job ? "PUT" : "POST", body });
      return true;
    }, t("Couldn’t save the sync"));
    if (saved) await onSaved();
  }

  return (
    <form className="grid grid-cols-2 gap-3" onSubmit={submit}>
      <Field label={t("Name")} className="col-span-2"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <EndpointFields label={t("From")} roots={roots} draft={source} onChange={setSource} />
      <EndpointFields label={t("To")} roots={roots} draft={destination} onChange={setDestination} />
      <Field label={t("What to do")} hint={mode === "mirror" ? t("Whatever the source no longer has is deleted from the destination.") : t("Nothing is ever deleted from the destination.")}>
        <Select value={mode} onChange={(event) => setMode(event.target.value as "copy" | "mirror")}>
          <option value="copy">{t("Copy new and changed files")}</option>
          <option value="mirror">{t("Make the destination identical")}</option>
        </Select>
      </Field>
      <Field label={t("When")}>
        <Select value={when} onChange={(event) => setWhen(event.target.value as typeof when)}>
          <option value="manual">{t("Only when I start it")}</option>
          <option value="interval">{t("Every so often")}</option>
          <option value="daily">{t("Every day")}</option>
          <option value="weekly">{t("Every week")}</option>
        </Select>
      </Field>
      {when === "interval" ? (
        <>
          <Field label={t("Every")} hint={t("Five minutes at the least.")}><Input inputMode="numeric" value={every} onChange={(event) => setEvery(event.target.value)} /></Field>
          <Field label={t("Unit")}>
            <Select value={unit} onChange={(event) => setUnit(event.target.value as "minutes" | "hours")}>
              <option value="minutes">{t("Minutes")}</option>
              <option value="hours">{t("Hours")}</option>
            </Select>
          </Field>
        </>
      ) : null}
      {when === "weekly" ? (
        <Field label={t("Day")}>
          <Select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
            {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </Select>
        </Field>
      ) : null}
      {when === "daily" || when === "weekly" ? (
        <Field label={t("Time")} hint={t("By the server’s clock.")}><Input type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></Field>
      ) : null}
      <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-2">
        <Checkbox label={t("Trial run: report what would change, change nothing")} checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
        {when === "manual" ? null : <Checkbox label={t("Run on schedule")} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
      </div>
      <div className="col-span-2 flex justify-end">
        <Button type="submit" variant="default" disabled={!canSubmit}>{job ? t("Save") : t("Add sync")}</Button>
      </div>
    </form>
  );
}

/** One end of a sync: a folder of a location. */
function EndpointFields({ label, roots, draft, onChange }: { label: string; roots: Root[]; draft: EndpointDraft; onChange: (draft: EndpointDraft) => void }) {
  return (
    <fieldset className="col-span-2 m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 border-0 p-0">
      <Field label={label}>
        <Select value={draft.rootSlug} onChange={(event) => onChange({ ...draft, rootSlug: event.target.value })}>
          {roots.map((root) => <option key={root.id} value={root.slug}>{root.name}</option>)}
        </Select>
      </Field>
      <Field label={t("Path")}><Input value={draft.path} placeholder="/" onChange={(event) => onChange({ ...draft, path: event.target.value })} /></Field>
    </fieldset>
  );
}
