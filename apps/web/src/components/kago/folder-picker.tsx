import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderPlus, HardDrive, Server } from "lucide-react";
import { api } from "@/api/client";
import { useFileList } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { controlClass, FieldGroup, Input } from "@/components/ui/input";
import { displayPath, nfc } from "@/lib/paths";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { Root } from "@/types/kago";
import { locationTone } from "./app-icon";
import { KagoDialog, KagoDialogActions } from "./dialog";
import { FileIcon } from "./file-icon";
import { t } from "@/lib/i18n";
import { KagoSpinner } from "@/components/kago/empty-state";

export type FolderRef = { rootSlug: string; path: string };

const FOLDER = { kind: "folder", type: "", name: "" } as const;
const INDENT = 14;
/** A folder of thousands of folders is not drawn whole; the ones past this are reached by typing the path. */
const MAX_CHILDREN = 300;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const keyOf = (folder: FolderRef) => `${folder.rootSlug}\n${folder.path}`;

/** The folder and every folder it lies in, outermost first. */
function lineage(folder: FolderRef): FolderRef[] {
  const parts = folder.path.split("/").filter(Boolean);
  return [{ rootSlug: folder.rootSlug, path: "/" }, ...parts.map((_, index) => ({ rootSlug: folder.rootSlug, path: `/${parts.slice(0, index + 1).join("/")}` }))];
}

function RootGlyph({ root }: { root: Root }) {
  const Icon = root.provider === "local" ? HardDrive : Server;
  return <Icon className="shrink-0" style={{ color: `var(--kago-app-${locationTone(root.slug)})` }} />;
}

/**
 * A folder of some location, as a field of a form: it shows where it points and opens a picker to point it
 * elsewhere, so that nobody has to type a path.
 */
export function FolderField({ label, hint, roots, value, onChange, writable, className }: { label: string; hint?: string; roots: Root[]; value: FolderRef; onChange: (folder: FolderRef) => void; /** The folder is one to put things in: locations that cannot be written to are not offered. */ writable?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = roots.find((item) => item.slug === value.rootSlug);
  return (
    <FieldGroup label={label} hint={hint} className={className}>
      <button type="button" aria-label={`${label}: ${displayPath(root?.name ?? value.rootSlug, value.path)}`} className={cn(controlClass, "kago-raised flex items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60")} onClick={() => setOpen(true)}>
        {root && value.path === "/" ? <RootGlyph root={root} /> : <FileIcon item={FOLDER} className="shrink-0" />}
        {/* Cut short at its start: the end of a path is what tells one folder from the next. */}
        <span className="min-w-0 flex-1 truncate text-left [direction:rtl]"><bdi>{displayPath(root?.name ?? value.rootSlug, value.path)}</bdi></span>
        <span className="shrink-0 text-xs text-muted">{t("Choose…")}</span>
      </button>
      <KagoDialog open={open} onClose={() => setOpen(false)} title={label} className="w-[min(480px,calc(100vw-32px))]">
        {open ? <Picker roots={roots} initial={value} writable={writable} onCancel={() => setOpen(false)} onChoose={(folder) => { onChange(folder); setOpen(false); }} /> : null}
      </KagoDialog>
    </FieldGroup>
  );
}

type Tree = { roots: Root[]; selected: FolderRef; expanded: ReadonlySet<string>; select: (folder: FolderRef) => void; toggle: (folder: FolderRef) => void; choose: (folder: FolderRef) => void; writable?: boolean };

function Picker({ roots, initial, writable, onCancel, onChoose }: { roots: Root[]; initial: FolderRef; writable?: boolean; onCancel: () => void; onChoose: (folder: FolderRef) => void }) {
  const queryClient = useQueryClient();
  const offered = useMemo(() => (writable ? roots.filter((root) => !root.readonly) : roots), [roots, writable]);
  const [selected, setSelected] = useState<FolderRef>(() => (offered.some((root) => root.slug === initial.rootSlug) ? initial : { rootSlug: offered[0]?.slug ?? "", path: "/" }));
  // Opened down to where it points, so the folder chosen last is in sight.
  const [expanded, setExpanded] = useState(() => new Set(lineage(selected).slice(0, -1).map(keyOf).concat(offered.length === 1 ? [keyOf({ rootSlug: offered[0]!.slug, path: "/" })] : [])));
  const [naming, setNaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const root = offered.find((item) => item.slug === selected.rootSlug);
  const expand = (folder: FolderRef) => setExpanded((current) => new Set(current).add(keyOf(folder)));

  async function createFolder() {
    const name = nfc(naming ?? "").trim();
    if (!name || creating) return;
    setCreating(true);
    const made = await run(() => api<{ path: string }>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: selected.rootSlug, path: selected.path, name }) }), t("Couldn’t create the folder"));
    setCreating(false);
    if (!made) return;
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", selected.rootSlug, selected.path] });
    expand(selected);
    setSelected({ rootSlug: selected.rootSlug, path: made.path });
    setNaming(null);
  }

  const tree: Tree = {
    roots: offered,
    selected,
    expanded,
    writable,
    select: setSelected,
    choose: onChoose,
    toggle: (folder) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(keyOf(folder))) next.add(keyOf(folder));
        return next;
      })
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4 pt-2">
      <div role="tree" aria-label={t("Folders")} className="kago-well h-[min(22rem,50vh)] overflow-y-auto overscroll-contain rounded-md p-1">
        {offered.length === 0 ? <p className="m-0 p-3 text-muted">{t("There is no location to choose a folder in.")}</p> : null}
        {offered.map((item) => <Node key={item.id} tree={tree} folder={{ rootSlug: item.slug, path: "/" }} label={item.name} depth={0} root={item} />)}
      </div>
      {naming === null ? (
        <p className="m-0 flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="min-w-0 flex-1 truncate text-left [direction:rtl]"><bdi>{root ? displayPath(root.name, selected.path) : ""}</bdi></span>
        </p>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            // The picker stands inside another form, which is not what Return is for here.
            event.preventDefault();
            event.stopPropagation();
            void createFolder();
          }}
        >
          <Input autoFocus aria-label={t("New folder")} placeholder={t("untitled folder")} value={naming} onChange={(event) => setNaming(event.target.value)} onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), setNaming(null))} />
          <Button type="submit" disabled={!naming.trim() || creating}>{creating ? <KagoSpinner className="text-inherit" /> : null}{t("Create")}</Button>
        </form>
      )}
      <KagoDialogActions>
        <Button className="mr-auto" disabled={!root || Boolean(root.readonly) || naming !== null} onClick={() => setNaming("")}><FolderPlus />{t("New folder")}</Button>
        <Button onClick={onCancel}>{t("Cancel")}</Button>
        <Button variant="default" disabled={!root} onClick={() => onChoose(selected)}>{t("Choose")}</Button>
      </KagoDialogActions>
    </div>
  );
}

function Node({ tree, folder, label, depth, root }: { tree: Tree; folder: FolderRef; label: string; depth: number; /** The location itself, for the row that stands for its top. */ root?: Root }) {
  const open = tree.expanded.has(keyOf(folder));
  const current = tree.selected.rootSlug === folder.rootSlug && tree.selected.path === folder.path;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current) row.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <>
      <div
        ref={row}
        role="treeitem"
        tabIndex={current ? 0 : -1}
        aria-expanded={open}
        aria-selected={current}
        className={cn("flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 outline-none select-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50", current && "kago-selection hover:bg-transparent")}
        style={{ paddingLeft: 4 + depth * INDENT }}
        onClick={() => tree.select(folder)}
        onDoubleClick={() => tree.choose(folder)}
        onKeyDown={(event) => {
          if (event.key === "Enter") tree.choose(folder);
          else if (event.key === "ArrowRight" && !open) tree.toggle(folder);
          else if (event.key === "ArrowLeft" && open) tree.toggle(folder);
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            // The rows as they stand on the page are the order the arrows walk them in.
            const rows = [...(row.current?.closest("[role=tree]")?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])];
            const next = rows[rows.indexOf(row.current!) + (event.key === "ArrowDown" ? 1 : -1)];
            next?.click();
            next?.focus();
          } else return;
          event.preventDefault();
        }}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? t("Collapse folder") : t("Expand folder")}
          className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm outline-none", current ? "text-inherit" : "text-muted hover:text-ink")}
          onClick={(event) => {
            event.stopPropagation();
            tree.toggle(folder);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        {root ? <RootGlyph root={root} /> : <FileIcon item={FOLDER} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
      {open ? <Children tree={tree} folder={folder} depth={depth + 1} /> : null}
    </>
  );
}

/** The folders inside one that is open in the tree. They are only asked for once it is opened. */
function Children({ tree, folder, depth }: { tree: Tree; folder: FolderRef; depth: number }) {
  const list = useFileList(folder.rootSlug, folder.path);
  const folders = useMemo(() => list.data?.items.filter((item) => item.kind === "folder" && !(tree.writable && item.readonly)).sort((a, b) => collator.compare(a.name, b.name)), [list.data, tree.writable]);
  const note = (text: string) => <span className="block truncate py-1 text-xs text-faint" style={{ paddingLeft: 24 + depth * INDENT }}>{text}</span>;

  if (!folders) return list.isError ? note(t("Couldn’t load")) : note(t("Loading"));
  if (folders.length === 0) return note(t("No folders inside"));
  return (
    <>
      {folders.slice(0, MAX_CHILDREN).map((item) => <Node key={item.path} tree={tree} folder={{ rootSlug: folder.rootSlug, path: item.path }} label={nfc(item.name)} depth={depth} />)}
      {folders.length > MAX_CHILDREN ? note(t("{count} more folder | {count} more folders", { count: folders.length - MAX_CHILDREN })) : null}
    </>
  );
}
