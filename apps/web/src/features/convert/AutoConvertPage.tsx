import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Clock, Ellipsis, Eye, FileVideo, FolderTree, History, Pause, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { create } from "zustand";
import { api } from "@/api/client";
import { useConvertJobs, useConvertSupport } from "@/api/hooks";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { FolderField } from "@/components/kago/folder-picker";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { Card, Page, Row, RowList } from "@/components/kago/page";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { isActiveTask, taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatUnixDate } from "@/lib/format";
import { baseName, displayPath, normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Actor, ConvertJob, ConvertJobOptions, ConvertSpec, FileTask, Root } from "@/types/kago";
import { ConvertFields, specIsValid } from "./ConvertFields";
import { ConvertRunsDialog } from "./ConvertRunsDialog";
import { CONVERT_FORMATS, DEFAULT_EXTENSIONS, describeSpec, kindOfFormat, parseExtensions, specFor, supportedFormats } from "./convertSpec";
import { t } from "@/lib/i18n";

type Folder = { rootSlug: string; path: string };

/** A destination chosen from a folder's window, waiting for the page to open a new job with it. */
const useDraftStore = create<{ destination: Folder | null }>(() => ({ destination: null }));

/** Opens the page with a new job that puts what it converts in the given folder. */
export function autoConvertInto(destination: Folder) {
  useDraftStore.setState({ destination });
  useWorkspaceStore.getState().openApp("settings", "convert");
}

/** The glyph for how a job's last run ended, or for the run it is in the middle of. */
function statusGlyph(job: ConvertJob) {
  const status = job.last_status;
  if (status === "running") return <RefreshCw className="animate-spin" />;
  if (status === "queued") return <Clock />;
  if (status === "pausing" || status === "paused") return <Pause />;
  if (status === "cancelled") return <Ban />;
  if (status === "failed" || status === "interrupted") return <X />;
  if (status === "done") return <Check />;
  return job.watch ? <Eye /> : <FileVideo />;
}

export function AutoConvertPage({ roots, user }: { roots: Root[]; user: Actor }) {
  const queryClient = useQueryClient();
  const jobs = useConvertJobs();
  const support = useConvertSupport();
  const draft = useDraftStore((state) => state.destination);
  const [editing, setEditing] = useState<ConvertJob | true | null>(null);
  const [destination, setDestination] = useState<Folder | null>(null);
  const [runsOf, setRunsOf] = useState<string | null>(null);
  // What each job has been asked for and has not answered yet. Copying a large folder's structure takes a while.
  const [busy, setBusy] = useState<Record<string, "start" | "structure">>({});
  const during = async (job: ConvertJob, what: "start" | "structure", action: () => Promise<unknown>) => {
    setBusy((current) => ({ ...current, [job.id]: what }));
    try {
      await action();
    } finally {
      setBusy(({ [job.id]: _, ...rest }) => rest);
    }
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["convert-jobs"] });
  const describeFolder = (folder: Folder) => displayPath(roots.find((root) => root.slug === folder.rootSlug)?.name ?? folder.rootSlug, folder.path);

  // A folder sent here from its window starts a new job, whatever the page was showing.
  useEffect(() => {
    if (!draft) return;
    setDestination(draft);
    setEditing(true);
    useDraftStore.setState({ destination: null });
  }, [draft]);

  const start = (job: ConvertJob) => during(job, "start", () =>
    run(async () => {
      await api<FileTask>(`/api/convert-jobs/${job.id}/run`, { method: "POST" });
      toast(t("{name} started", { name: job.name }));
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["tasks"] })]);
    }, t("Couldn’t start the conversion")));

  const copyStructure = (job: ConvertJob) => during(job, "structure", () =>
    run(async () => {
      const { created } = await api<{ created: number }>(`/api/convert-jobs/${job.id}/structure`, { method: "POST" });
      toast(created > 0 ? t("Created {count} folder in the input folder | Created {count} folders in the input folder", { count: created }) : t("The input folder already has every folder of the destination"));
      await queryClient.invalidateQueries({ queryKey: ["fs"] });
    }, t("Couldn’t copy the folder structure")));

  async function remove(job: ConvertJob) {
    if (!(await confirmAction({ title: t("Delete this auto-convert?"), subject: { icon: <KagoStatusIcon large><FileVideo /></KagoStatusIcon>, name: job.name, detail: `${describeFolder(job.input)} → ${describeFolder(job.destination)}` }, description: t("Files it has already converted stay where they are."), confirmLabel: t("Delete"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/convert-jobs/${job.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  const close = () => {
    setEditing(null);
    setDestination(null);
  };
  const addButton = roots.length > 0 ? <Button variant="default" onClick={() => setEditing(true)}><Plus />{t("Add auto-convert")}</Button> : null;

  return (
    <Page
      title={t("Auto-convert")}
      description={t("Drop files into an input folder and find them converted in another, in the same folders they were dropped in.")}
      actions={jobs.data?.length && !editing ? addButton : null}
    >
      {editing ? (
        <Card title={editing === true ? t("Add auto-convert") : t("Edit {name}", { name: editing.name })} action={<KagoIconButton label={t("Close")} onClick={close}><X /></KagoIconButton>}>
          <JobForm key={editing === true ? `new:${destination?.rootSlug}:${destination?.path}` : editing.id} roots={roots} job={editing === true ? null : editing} destination={destination} onSaved={async () => { close(); await refresh(); }} />
        </Card>
      ) : null}
      {jobs.isLoading ? <KagoLoading /> : null}
      {jobs.data?.length === 0 && !editing ? (
        <KagoEmptyState icon={<FileVideo />} title={t("No auto-converts yet")} description={t("An auto-convert watches an input folder and puts a converted copy of whatever lands there in the destination, for a library you want kept in one format.")}>
          {addButton}
        </KagoEmptyState>
      ) : null}
      {jobs.data?.length ? (
        <RowList>
          {jobs.data.map((job) => {
            const last = job.last_status ? taskStatus({ status: job.last_status } as FileTask) : null;
            const running = job.last_status === "queued" || job.last_status === "running";
            const structuring = busy[job.id] === "structure";
            return (
              <Row
                key={job.id}
                icon={structuring
                  ? <KagoStatusIcon label={t("Copying the folder structure…")}><RefreshCw className="animate-spin" /></KagoStatusIcon>
                  : <KagoStatusIcon tone={last?.tone} label={last?.label ?? (job.watch ? t("Watching") : t("No runs yet"))}>{statusGlyph(job)}</KagoStatusIcon>}
                title={job.name}
                subtitle={
                  <>
                    <span className="block truncate">{`${describeFolder(job.input)} → ${describeFolder(job.destination)}`}</span>
                    <span className="block truncate">
                      {[
                        describeSpec(job.spec, support.data?.hardware?.device),
                        job.watch ? t("Watching the input folder") : t("Runs only when started"),
                        job.created_by !== user.id ? t("Someone else’s") : null
                      ].filter(Boolean).join(" · ")}
                    </span>
                    {/* How it last went has a line to itself: on one with the rest it is the first thing pushed out of sight. */}
                    <span className="block truncate">
                      {structuring ? t("Copying the folder structure…") : [
                        last && isActiveTask({ status: job.last_status } as FileTask) ? last.label : null,
                        job.last_error ? taskErrorLabel(job.last_error) : job.last_run_at ? t("Last run {date}", { date: formatUnixDate(job.last_run_at) }) : null,
                        job.failed > 0 ? t("{count} file failed | {count} files failed", { count: job.failed }) : null
                      ].filter(Boolean).join(" · ") || t("No runs yet")}
                    </span>
                  </>
                }
              >
                <Button disabled={running || job.id in busy} onClick={() => void start(job)}>{busy[job.id] === "start" ? <KagoSpinner className="text-inherit" /> : null}{t("Run now")}</Button>
                <KagoDropdownMenu
                  raised
                  label={t("More actions")}
                  menu={
                    <>
                      <KagoMenuItem icon={<FolderTree />} disabled={job.id in busy} onClick={() => void copyStructure(job)}>{t("Copy the folder structure to the input folder")}</KagoMenuItem>
                      <KagoMenuItem icon={<History />} disabled={!job.last_run_at} onClick={() => setRunsOf(job.id)}>{t("History")}</KagoMenuItem>
                      <KagoMenuItem icon={<Pencil />} onClick={() => { setDestination(null); setEditing(job); }}>{t("Edit")}</KagoMenuItem>
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
      <ConvertRunsDialog job={jobs.data?.find((job) => job.id === runsOf) ?? null} onClose={() => setRunsOf(null)} />
    </Page>
  );
}

const draftOf = (folder: Folder | null | undefined, roots: Root[]): Folder => ({ rootSlug: folder?.rootSlug ?? roots[0]?.slug ?? "", path: folder?.path ?? "/" });

function folderOf(draft: Folder): Folder | null {
  const path = normalizeLogicalPath(draft.path);
  return draft.rootSlug && path ? { rootSlug: draft.rootSlug, path } : null;
}

function JobForm({ roots, job, destination, onSaved }: { roots: Root[]; job: ConvertJob | null; /** Where a new job is to put things, when that was chosen before coming here. */ destination: Folder | null; onSaved: () => Promise<void> }) {
  const support = useConvertSupport();
  const [name, setName] = useState(job?.name ?? (destination ? baseName(destination.path) || (roots.find((root) => root.slug === destination.rootSlug)?.name ?? "") : ""));
  const [input, setInput] = useState(() => draftOf(job?.input, roots));
  const [output, setOutput] = useState(() => draftOf(job?.destination ?? destination, roots));
  const [spec, setSpec] = useState<ConvertSpec>(() => job?.spec ?? specFor("mp4"));
  const [options, setOptions] = useState<ConvertJobOptions>(() => job?.options ?? { keepSmaller: true, after: "keep", copyOthers: true, extensions: null });
  // A job from before the endings could be chosen went by the kind of file, which is what the list starts as.
  const [endings, setEndings] = useState(() => (job?.options.extensions ?? DEFAULT_EXTENSIONS[kindOfFormat(spec.format)]).join(", "));
  const [watch, setWatch] = useState(job?.watch ?? true);
  // A job made for a folder that is already in use starts with that folder's own layout to drop things into.
  const [structure, setStructure] = useState(!job && destination !== null);
  const [saving, setSaving] = useState<"job" | "structure" | null>(null);

  const from = folderOf(input);
  const to = folderOf(output);
  const extensions = parseExtensions(endings);
  const canSubmit = name.trim().length > 0 && from !== null && to !== null && specIsValid(spec) && extensions.length > 0;

  function changeSpec(next: ConvertSpec) {
    const was = DEFAULT_EXTENSIONS[kindOfFormat(spec.format)];
    const kind = kindOfFormat(next.format);
    // Endings nobody has touched follow the format to another kind of file.
    if (kind !== kindOfFormat(spec.format) && extensions.join() === was.join()) setEndings(DEFAULT_EXTENSIONS[kind].join(", "));
    setSpec(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    const body = JSON.stringify({ name: name.trim(), input: from, destination: to, spec, options: { ...options, extensions }, watch });
    setSaving("job");
    const saved = await run(() => api<ConvertJob>(job ? `/api/convert-jobs/${job.id}` : "/api/convert-jobs", { method: job ? "PUT" : "POST", body }), t("Couldn’t save the auto-convert"));
    if (!saved) return setSaving(null);
    if (structure) {
      setSaving("structure");
      await run(async () => {
        const { created } = await api<{ created: number }>(`/api/convert-jobs/${saved.id}/structure`, { method: "POST" });
        if (created > 0) toast(t("Created {count} folder in the input folder | Created {count} folders in the input folder", { count: created }));
      }, t("Couldn’t copy the folder structure"));
    }
    await onSaved();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label={t("Name")}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <FolderField label={t("Input folder")} hint={t("Where you drop what is to be converted.")} roots={roots} value={input} onChange={setInput} />
      <FolderField label={t("Destination")} hint={t("Where the converted files end up, in the same folders they were dropped in.")} roots={roots} value={output}
        writable
        onChange={(folder) => {
          setOutput(folder);
          // A job is most often called after where it puts things.
          if (!name.trim()) setName(baseName(folder.path) || (roots.find((root) => root.slug === folder.rootSlug)?.name ?? ""));
        }}
      />
      <ConvertFields spec={spec} formats={supportedFormats(CONVERT_FORMATS, support.data)} support={support.data} onChange={changeSpec} />
      <Field label={t("File extensions to convert")} hint={options.copyOthers ? t("Separated by commas or spaces. Files with any other extension are copied to the destination as they are.") : t("Separated by commas or spaces. Files with any other extension are left alone.")}>
        <Input value={endings} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="mp4, mkv, mov" onChange={(event) => setEndings(event.target.value)} />
      </Field>
      <Field label={t("Once a file has reached the destination")} hint={options.after === "delete" ? t("Deleted for good, without passing through the Trash.") : undefined}>
        <Select value={options.after} onChange={(event) => setOptions({ ...options, after: event.target.value as ConvertJobOptions["after"] })}>
          <option value="keep">{t("Leave it in the input folder")}</option>
          <option value="trash">{t("Move it to the Trash")}</option>
          <option value="delete">{t("Delete it")}</option>
        </Select>
      </Field>
      <div className="flex flex-col gap-2">
        <Checkbox label={t("Watch the input folder and convert new files by itself")} checked={watch} onChange={(event) => setWatch(event.target.checked)} />
        <Checkbox label={t("If the conversion comes out no smaller, put the original in the destination instead")} checked={options.keepSmaller} onChange={(event) => setOptions({ ...options, keepSmaller: event.target.checked })} />
        <Checkbox label={t("Copy files with other extensions to the destination as they are")} checked={options.copyOthers} onChange={(event) => setOptions({ ...options, copyOthers: event.target.checked })} />
        <Checkbox label={t("Copy the destination’s folder structure into the input folder now (folders only, no files)")} checked={structure} onChange={(event) => setStructure(event.target.checked)} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="default" disabled={!canSubmit || saving !== null}>
          {saving ? <KagoSpinner className="text-inherit" /> : null}
          {saving === "structure" ? t("Copying the folder structure…") : job ? t("Save") : t("Add auto-convert")}
        </Button>
      </div>
    </form>
  );
}
