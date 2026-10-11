import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronUp, X } from "lucide-react";
import { create } from "zustand";
import { api } from "@/api/client";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoVirtualList } from "@/components/kago/virtual-list";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FileItem, ImageMetadata, MediaInfo } from "@/types/kago";
import { makePart, partKinds, planRename, readsFrom, renameTemplates, sourcesOf, type PartKind, type PartSource, type RenameInfo, type RenamePart, type RenameProblem, type RenameRow } from "./batchRename";

/** The server renames at most this many at once. */
export const MAX_BATCH_RENAME = 1000;

export type BatchRenameChoice = Array<{ path: string; name: string }>;

type BatchRenameRequest = { id: number; rootSlug: string; items: FileItem[]; /** Every path listed beside them, whose names are taken. */ existing: string[]; resolve: (choice: BatchRenameChoice | null) => void };

// The pattern stays as it was left, for the next lot of files.
const useBatchRenameStore = create<{ request: BatchRenameRequest | null; parts: RenamePart[] }>(() => ({ request: null, parts: [makePart("original")] }));

let requests = 0;

/** Asks how to name several items, and resolves to the new name of each one that gets another. */
export function promptBatchRename(options: Omit<BatchRenameRequest, "id" | "resolve">) {
  return new Promise<BatchRenameChoice | null>((resolve) => {
    useBatchRenameStore.getState().request?.resolve(null);
    useBatchRenameStore.setState({ request: { ...options, id: ++requests, resolve } });
  });
}

function settle(choice: BatchRenameChoice | null) {
  useBatchRenameStore.getState().request?.resolve(choice);
  useBatchRenameStore.setState({ request: null });
}

const setParts = (parts: RenamePart[]) => useBatchRenameStore.setState({ parts });

/** How many files are asked about at once. */
const INFO_WINDOW = 4;
type InfoResult = UseQueryResult<ImageMetadata | MediaInfo>;
const infoResults = (results: InfoResult[]) => ({ data: results.map((result) => result.data), settled: results.filter((result) => !result.isPending).length });

/**
 * What the pattern needs read from the files, by path, and how far the reading has got. They are read a few
 * at a time, like the songs of an album, so a large selection does not set the server probing all of it at once.
 */
function useRenameInfo(rootSlug: string, items: FileItem[], sources: PartSource[]) {
  const wanted = useMemo(() => sources.flatMap((source) => items.filter((item) => readsFrom(source, item)).map((item) => ({ source, path: item.path }))), [items, sources]);
  const [reach, setReach] = useState(INFO_WINDOW);
  const { data, settled } = useQueries({
    // The same keys the inspector and the players ask under, so a file already read is not read again.
    queries: wanted.map(({ source, path }, index) => ({
      queryKey: source === "photo" ? ["fs", "exif", rootSlug, path] : ["media", "info", rootSlug, path],
      queryFn: () => api<ImageMetadata | MediaInfo>(`${source === "photo" ? "/api/fs/exif" : "/api/media/info"}?${new URLSearchParams({ rootSlug, path }).toString()}`),
      enabled: index < reach,
      retry: false,
      staleTime: 60_000
    })),
    combine: infoResults
  });
  useEffect(() => {
    if (settled + INFO_WINDOW > reach && reach < wanted.length) setReach(settled + INFO_WINDOW);
  }, [settled, reach, wanted.length]);
  const info = useMemo(() => {
    const byPath = new Map<string, RenameInfo>();
    wanted.forEach(({ source, path }, index) => {
      if (data[index]) byPath.set(path, { ...byPath.get(path), [source]: data[index] });
    });
    return byPath;
  }, [wanted, data]);
  return { info, settled, total: wanted.length };
}

const PROBLEMS: Record<RenameProblem, string> = { empty: t("No name"), invalid: t("Not a valid name"), long: t("Too long"), clash: t("Name taken") };

function PartCard({ part, kind, first, last, onChange, onMove, onRemove }: { part: RenamePart; kind: PartKind; first: boolean; last: boolean; onChange: (key: string, value: string | number | boolean) => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const fields = kind.fields.filter((field) => field.kind !== "check" || !field.when || field.when(part.options));
  // A part with one thing to set is named by its own heading.
  const bare = fields.length === 1;
  return (
    <li className="flex flex-col gap-1.5 rounded-md bg-elevated p-2 ring-1 ring-line">
      <div className="flex items-center gap-0.5">
        <span className="min-w-0 flex-1 truncate pl-0.5 text-xs font-medium text-muted">{kind.label}</span>
        <KagoIconButton label={t("Move up")} className="size-6" disabled={first} onClick={() => onMove(-1)}><ChevronUp /></KagoIconButton>
        <KagoIconButton label={t("Move down")} className="size-6" disabled={last} onClick={() => onMove(1)}><ChevronDown /></KagoIconButton>
        <KagoIconButton label={t("Remove")} className="size-6" onClick={onRemove}><X /></KagoIconButton>
      </div>
      {fields.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          {fields.map((field) => {
            const value = part.options[field.key];
            if (field.kind === "check") return <Checkbox key={field.key} className="col-span-2" label={field.label} checked={Boolean(value)} onChange={(event) => onChange(field.key, event.target.checked)} />;
            const control =
              field.kind === "select" ? (
                <Select aria-label={field.label} value={String(value)} onChange={(event) => onChange(field.key, event.target.value)}>
                  {field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </Select>
              ) : field.kind === "number" ? (
                <Input aria-label={field.label} type="number" inputMode="numeric" min={field.min} max={field.max} value={String(value)} onChange={(event) => onChange(field.key, event.target.value === "" ? "" : Number(event.target.value))} />
              ) : (
                <Input aria-label={field.label} value={String(value)} placeholder={field.placeholder} spellCheck={false} autoComplete="off" onChange={(event) => onChange(field.key, event.target.value)} />
              );
            return bare ? <div key={field.key} className="col-span-2">{control}</div> : <Field key={field.key} label={field.label} className={field.kind === "number" ? undefined : "col-span-2"}>{control}</Field>;
          })}
        </div>
      ) : null}
    </li>
  );
}

function PreviewRow({ row }: { row: RenameRow }) {
  return (
    <div className="grid h-7 grid-cols-[minmax(0,2fr)_auto_minmax(0,3fr)] items-center gap-2 px-2.5">
      <span className="truncate text-muted" title={row.item.name}>{row.item.name}</span>
      <ArrowRight className="size-3.5 text-faint" />
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("min-w-0 flex-1 truncate", row.problem ? "text-danger" : row.changed ? "text-ink" : "text-faint")} title={row.name}>{row.name}</span>
        {row.problem ? <span className="shrink-0 text-xs text-danger">{PROBLEMS[row.problem]}</span> : null}
      </span>
    </div>
  );
}

function BatchRenameForm({ request }: { request: BatchRenameRequest }) {
  const parts = useBatchRenameStore((state) => state.parts);
  const sourceList = sourcesOf(parts).join(" ");
  const sources = useMemo(() => (sourceList ? (sourceList.split(" ") as PartSource[]) : []), [sourceList]);
  const { info, settled, total } = useRenameInfo(request.rootSlug, request.items, sources);
  const drawn = useRef(new Map<string, string>());
  const plan = useMemo(() => planRename(request.items, parts, info, request.existing, drawn.current), [request, parts, info]);

  const reading = settled < total;
  const problems = plan.rows.filter((row) => row.problem).length;
  const renamed = plan.rows.filter((row) => row.changed);
  const canSubmit = !reading && !plan.error && problems === 0 && renamed.length > 0;
  const status = reading
    ? t("Reading file info… {done} of {total}", { done: settled, total })
    : plan.error ?? (problems > 0
      ? t("{count} name can’t be used | {count} names can’t be used", { count: problems })
      : renamed.length === 0
        ? t("No name would change")
        : t("{count} item will be renamed | {count} items will be renamed", { count: renamed.length }));

  const update = (index: number, next: RenamePart | null) => setParts(parts.flatMap((part, at) => (at === index ? next ?? [] : part)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...parts];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    setParts(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-3 sm:flex-row">
        <section className="flex min-h-0 flex-col gap-2 max-sm:max-h-[50%] sm:w-72 sm:shrink-0">
          <Select
            aria-label={t("Template")}
            value=""
            onChange={(event) => {
              const template = renameTemplates.find((entry) => entry.id === event.target.value);
              if (template) setParts(template.parts.map(([type, options]) => makePart(type, options)));
            }}
          >
            <option value="" disabled hidden>{t("Start from a template…")}</option>
            {renameTemplates.map((template) => <option key={template.id} value={template.id}>{`${template.label} · ${template.example}`}</option>)}
          </Select>
          {/* Room around the cards for the rings of what is inside them, which the scrolling would cut off. */}
          <ol className="-m-1 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-1">
            {parts.map((part, index) => {
              const kind = partKinds.find((entry) => entry.type === part.type);
              return kind ? (
                <PartCard
                  key={part.key}
                  part={part}
                  kind={kind}
                  first={index === 0}
                  last={index === parts.length - 1}
                  onChange={(key, value) => update(index, { ...part, options: { ...part.options, [key]: value } })}
                  onMove={(by) => move(index, by)}
                  onRemove={() => update(index, null)}
                />
              ) : null;
            })}
            {parts.length === 0 ? <li className="px-1 py-6 text-center text-xs text-pretty text-muted">{t("Pick a template, or add the parts the new names are made of.")}</li> : null}
          </ol>
          <Select
            aria-label={t("Add a part")}
            value=""
            onChange={(event) => {
              if (event.target.value) setParts([...parts, makePart(event.target.value)]);
            }}
          >
            <option value="" disabled hidden>{t("Add a part…")}</option>
            {[...new Set(partKinds.map((kind) => kind.group))].map((group) => (
              <optgroup key={group} label={group}>
                {partKinds.filter((kind) => kind.group === group).map((kind) => <option key={kind.type} value={kind.type}>{kind.label}</option>)}
              </optgroup>
            ))}
          </Select>
        </section>
        <section className="kago-well flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md" aria-label={t("Preview")}>
          <KagoVirtualList items={plan.rows} rowHeight={28} className="min-h-0 flex-1 py-1">
            {(row) => <PreviewRow row={row} />}
          </KagoVirtualList>
        </section>
      </div>
      <footer className="flex shrink-0 items-center gap-2 rounded-b-lg border-t border-line bg-elevated p-3">
        <span className={cn("min-w-0 flex-1 truncate pl-1 text-xs", !reading && (plan.error || problems > 0) ? "text-danger" : "text-muted")} role="status">{status}</span>
        <Button size="lg" onClick={() => settle(null)}>{t("Cancel")}</Button>
        <Button size="lg" variant="default" disabled={!canSubmit} onClick={() => settle(renamed.map((row) => ({ path: row.item.path, name: row.name })))}>{t("Rename")}</Button>
      </footer>
    </div>
  );
}

export function BatchRenameDialogHost() {
  const pending = useBatchRenameStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  useEffect(() => {
    if (pending) setRequest(pending);
  }, [pending]);

  if (!request) return null;
  return (
    <KagoDialog open={Boolean(pending)} onClose={() => settle(null)} title={t("Rename {count} item | Rename {count} items", { count: request.items.length })} className="h-[min(620px,calc(100vh-48px))] w-[min(860px,calc(100vw-32px))]">
      <BatchRenameForm key={request.id} request={request} />
    </KagoDialog>
  );
}
