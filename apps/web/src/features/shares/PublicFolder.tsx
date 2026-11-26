import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronRight, Download, FolderOpen, LayoutGrid, List } from "lucide-react";
import { FormError } from "@/components/kago/auth-card";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { FileIcon, FileTile } from "@/components/kago/file-icon";
import { FileThumbnail } from "@/components/kago/file-thumbnail";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem } from "@/components/kago/menu";
import { KagoSegmented } from "@/components/kago/segmented";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatSize } from "@/lib/format";
import { nfc, triggerDownload } from "@/lib/paths";
import { crumbs, DEFAULT_SORT, endsLink, folderTotals, layoutFor, locationSearch, neighbours, PAGE, parseLocation, shareEndpoint, toggleSort, type Layout, type ShareSort } from "@/lib/shareFolderModel";
import { useCompact } from "@/lib/useCompact";
import { cn } from "@/lib/utils";
import type { PublicShareInfo, ShareItem, ShareSortBy } from "@/types/kago";
import { failureOfError, failureText } from "./shareFailures";
import { ShareViewer } from "./ShareViewer";
import { useShareFolder } from "./useShareFolder";
import { useZipDownload } from "./useZipDownload";
import { t } from "@/lib/i18n";

const SORT_KEY = "kago:share-sort";
const LAYOUT_KEY = "kago:share-layout";
/** How far past the end of what has been read the next page is asked for, so scrolling does not run out. */
const AHEAD = "900px";

function recall<T>(key: string, accept: (value: unknown) => T | null): T | null {
  try {
    return accept(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The choice just is not kept.
  }
}

const sortColumns: Array<{ by: ShareSortBy; label: () => string }> = [
  { by: "name", label: () => t("Name") },
  { by: "mtime", label: () => t("Modified") },
  { by: "size", label: () => t("Size") },
  { by: "type", label: () => t("Kind") }
];

const childPath = (folder: string, name: string) => `${folder === "/" ? "" : folder}/${name}`;

/**
 * A folder shared to look through, as a visitor sees it: what it is and what they may do with it, then its contents
 * as pictures or as a list, a folder at a time. Where they are lives in the address, so back and forward, a reload
 * and a link to one picture all work.
 */
export function PublicFolder({ token, share, onEnded, onLocked }: { token: string; share: PublicShareInfo; /** The link has stopped working while it was open. */ onEnded: (error: Error) => void; /** The password is asked for again. */ onLocked: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const loc = useMemo(() => parseLocation(location.search), [location.search]);
  const [sort, setSort] = useState<ShareSort>(() => recall(SORT_KEY, (value) => (value && typeof value === "object" && sortColumns.some((column) => column.by === (value as ShareSort).by) && ["asc", "desc"].includes((value as ShareSort).direction) ? (value as ShareSort) : null)) ?? DEFAULT_SORT);
  const [chosen, setChosen] = useState<Layout | null>(() => recall(LAYOUT_KEY, (value) => (value === "grid" || value === "list" ? value : null)));
  const folder = useShareFolder(token, loc.path, sort, loc.open);
  const { loadMore } = folder;
  const { zip, start, dismiss } = useZipDownload(token);
  const compact = useCompact();
  const scroller = useRef<HTMLElement>(null);
  const canDownload = share.mode === "download";
  const name = share.name ?? t("Share link");
  const failure = folder.error ? failureOfError(folder.error) : null;
  // Decided by the first page only, so the folder does not change shape as the rest of it arrives.
  const layout = chosen ?? layoutFor(folder.items.slice(0, PAGE));
  const totals = folderTotals(folder.items, folder.total);

  const to = useCallback((path: string, open: string | null = null) => ({ pathname: location.pathname, search: locationSearch({ path, open }) }), [location.pathname]);

  useEffect(() => {
    if (!folder.error) return;
    const why = failureOfError(folder.error);
    if (why === "password") onLocked();
    else if (endsLink(why)) onEnded(folder.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callbacks are the page's, made anew every render; an error is heard once.
  }, [folder.error]);

  // Each folder is scrolled back to where it was left, which can be further down than has been read: the rest is read first.
  const scrolls = useRef(new Map<string, number>());
  const restore = useRef<number | null>(null);
  useEffect(() => {
    restore.current = scrolls.current.get(loc.path) ?? null;
    scroller.current?.scrollTo({ top: 0 });
  }, [loc.path]);
  useEffect(() => {
    const target = restore.current;
    const box = scroller.current;
    if (target === null || !box || folder.loading) return;
    if (box.scrollHeight - box.clientHeight >= target || !folder.hasMore) {
      restore.current = null;
      box.scrollTo({ top: target });
    } else loadMore();
  }, [loadMore, folder.items.length, folder.loading, folder.hasMore]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = end.current;
    if (!mark || !folder.hasMore) return;
    const watch = new IntersectionObserver((seen) => seen.some((one) => one.isIntersecting) && loadMore(), { root: scroller.current, rootMargin: AHEAD });
    watch.observe(mark);
    return () => watch.disconnect();
    // A new watcher is made after every page: one that never left the view says so again as soon as it is watched.
  }, [folder.hasMore, folder.items.length, loadMore]);

  const open = loc.open;
  const around = useMemo(() => (open ? neighbours(folder.items, open) : null), [folder.items, open]);
  const openItem = open ? (folder.items.find((item) => nfc(item.name) === open) ?? null) : null;
  // Stepping towards the end of what has been read reads on.
  useEffect(() => {
    if (around && around.position !== null && around.position >= around.count - 2 && folder.hasMore) loadMore();
  }, [around, folder.hasMore, loadMore]);

  function setOrder(by: ShareSortBy) {
    const next = toggleSort(sort, by);
    setSort(next);
    remember(SORT_KEY, next);
  }

  function setLayout(next: Layout) {
    setChosen(next);
    remember(LAYOUT_KEY, next);
  }

  const here = loc.path === "/" ? name : (crumbs(name, loc.path).at(-1)?.label ?? name);
  const downloading = canDownload && !folder.error && !(folder.total === 0 && !folder.loading);

  return (
    <>
      <main
        ref={scroller}
        className="kago-canvas h-full overflow-auto px-3 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-4 sm:pt-8"
        onScroll={(event) => scrolls.current.set(loc.path, event.currentTarget.scrollTop)}
      >
        <div className="mx-auto flex w-full max-w-[920px] flex-col items-center">
          <FileTile item={{ kind: "folder", type: "", name }} className="mb-3 size-12 sm:mb-4 sm:size-16" />
          <h1 className="m-0 line-clamp-2 max-w-full text-center text-xl leading-tight font-semibold tracking-tight wrap-anywhere">{name}</h1>
          <p className="m-0 mt-1.5 max-w-full text-center text-muted">{[canDownload ? t("Browse and download") : t("View only"), t("Shared with Kago")].join(" · ")}</p>

          {downloading ? (
            <div className="mt-4 flex w-full max-w-[340px] flex-col items-center gap-1.5">
              <button type="button" className={cn(buttonVariants({ variant: "default", size: "lg" }), "h-10 w-full")} disabled={folder.loading} onClick={() => start(loc.path, here)}>
                <Download />
                {loc.path === "/" ? t("Download all") : t("Download this folder")}
              </button>
              {folder.loading || folder.error ? null : (
                <p className="m-0 text-xs text-muted tabular-nums">{[t("{count} item | {count} items", { count: totals.count }), totals.bytes !== null && totals.bytes > 0 ? formatSize(totals.bytes) : null].filter(Boolean).join(" · ")}</p>
              )}
              {zip.state === "started" ? (
                <p role="status" className="m-0 flex items-start gap-1.5 text-center text-xs text-muted">
                  <Check className="mt-px size-3.5 shrink-0 text-success" />
                  <span>{t("Your download of “{name}” has started. A big folder can take a while to begin, and your browser shows how far it has got.", { name: zip.name })}</span>
                </p>
              ) : null}
              {zip.state === "failed" ? (
                <div className="flex w-full flex-col items-center gap-1.5 text-center">
                  <FormError message={zip.message} />
                  <button type="button" className="text-xs text-muted underline" onClick={dismiss}>
                    {t("Dismiss")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <section className="mt-5 w-full rounded-lg bg-surface shadow-window ring-1 ring-(--kago-window-edge)">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line p-1.5">
              <Crumbs shareName={name} path={loc.path} to={to} />
              <div className="ml-auto flex items-center gap-1.5">
                <KagoDropdownMenu
                  wide
                  label={t("Sort by")}
                  menu={sortColumns.map(({ by, label }) => (
                    <KagoMenuItem key={by} closeOnClick={false} icon={sort.by !== by ? <span className="size-4" /> : sort.direction === "asc" ? <ArrowUp /> : <ArrowDown />} onClick={() => setOrder(by)}>
                      {label()}
                    </KagoMenuItem>
                  ))}
                >
                  <ArrowUpDown className="size-4" />
                  {sortColumns.find((column) => column.by === sort.by)?.label()}
                </KagoDropdownMenu>
                <KagoSegmented
                  iconOnly
                  label={t("View as")}
                  value={layout}
                  onChange={setLayout}
                  options={[
                    { value: "grid", label: t("Icons"), icon: <LayoutGrid /> },
                    { value: "list", label: t("List"), icon: <List /> }
                  ]}
                />
              </div>
            </div>

            {folder.loading ? (
              <Waiting />
            ) : folder.error && folder.items.length === 0 ? (
              failure === "missing" ? (
                <KagoEmptyState icon={<FolderOpen />} title={t("This folder isn’t here any more")} description={failureText("missing", "")}>
                  <Link className={buttonVariants()} to={to("/")}>
                    {t("Back to the start")}
                  </Link>
                </KagoEmptyState>
              ) : (
                <KagoEmptyState icon={<FolderOpen />} title={t("Couldn’t open this folder")} description={failureText(failure ?? "other", folder.error.message)}>
                  <button type="button" className={buttonVariants()} onClick={folder.retry}>
                    {t("Try again")}
                  </button>
                </KagoEmptyState>
              )
            ) : folder.items.length === 0 ? (
              <KagoEmptyState icon={<FolderOpen />} title={t("This folder is empty")} />
            ) : layout === "grid" ? (
              <ul role="list" className="m-0 grid list-none gap-1 p-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? 104 : 148}px, 1fr))` }}>
                {folder.items.map((item) => (
                  <li key={item.path} style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${compact ? 152 : 184}px`, height: compact ? 152 : 184 }}>
                    <Target item={item} token={token} loc={loc.path} canDownload={canDownload} to={to} className="flex size-full flex-col items-center gap-1 rounded-md p-1.5 hover:bg-hover">
                      <span className="flex shrink-0 items-center justify-center" style={{ width: compact ? 96 : 136, height: compact ? 96 : 136 }}>
                        <FileThumbnail url={shareEndpoint(token, "thumbnail", { path: item.path, size: "small" })} item={item} size={compact ? 88 : 128} excerpts={false} />
                      </span>
                      <span className="line-clamp-2 max-w-full px-1 text-center leading-4 break-words">{item.name}</span>
                    </Target>
                  </li>
                ))}
              </ul>
            ) : (
              <ul role="list" className="m-0 list-none p-0">
                {folder.items.map((item) => (
                  <li key={item.path} className="flex items-center border-b border-line last:border-b-0" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px", height: 44 }}>
                    <Target item={item} token={token} loc={loc.path} canDownload={canDownload} to={to} className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 hover:bg-hover">
                      <FileIcon item={item} className="size-5 shrink-0" />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate">{item.name}</span>
                        <span className="truncate text-xs text-muted tabular-nums sm:hidden">{rowFacts(item)}</span>
                      </span>
                      <span className="hidden w-20 shrink-0 text-right text-muted tabular-nums sm:block">{item.kind === "file" ? formatSize(item.size) : ""}</span>
                      <span className="hidden w-36 shrink-0 text-right text-muted tabular-nums sm:block">{formatDate(item.mtime)}</span>
                      {item.kind === "folder" ? <ChevronRight className="size-4 shrink-0 text-faint" /> : null}
                    </Target>
                    {canDownload && item.kind === "file" ? (
                      <KagoIconButton className="mr-1" label={t("Download")} onClick={() => triggerDownload(shareEndpoint(token, "download", { path: item.path }))}>
                        <Download />
                      </KagoIconButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {folder.hasMore || folder.more ? (
              <div ref={end} className="flex items-center justify-center gap-2 p-4 text-xs text-muted">
                {folder.error ? (
                  <button type="button" className={buttonVariants()} onClick={folder.retry}>
                    {t("Try again")}
                  </button>
                ) : (
                  <>
                    <KagoSpinner className="size-4" />
                    {t("Loading more…")}
                  </>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </main>

      {open ? (
        <ShareViewer
          token={token}
          name={openItem?.name ?? open}
          path={openItem?.path ?? childPath(loc.path, open)}
          item={openItem}
          position={around?.position ?? null}
          count={around?.count ?? 0}
          more={folder.hasMore}
          previous={around?.previous ?? null}
          next={around?.next ?? null}
          canDownload={canDownload}
          onStep={(item) => navigate(to(loc.path, item.name), { replace: true, state: location.state })}
          onClose={() => (location.state?.viewer ? navigate(-1) : navigate(to(loc.path), { replace: true }))}
        />
      ) : null}
    </>
  );
}

const rowFacts = (item: ShareItem) => [item.kind === "file" ? formatSize(item.size) : null, formatDate(item.mtime)].filter(Boolean).join(" · ");

/** A folder is entered, a file that can be looked at is opened in the viewer, and where the link allows it any other is downloaded; where it does not, the viewer says plainly that it cannot be shown. */
function Target({ item, token, loc, canDownload, to, className, children }: { item: ShareItem; token: string; loc: string; canDownload: boolean; to: (path: string, open?: string | null) => { pathname: string; search: string }; className: string; children: ReactNode }) {
  if (item.kind === "file" && !item.previewable && canDownload) {
    return (
      <a className={className} href={shareEndpoint(token, "download", { path: item.path })} download>
        {children}
      </a>
    );
  }
  return item.kind === "folder" ? (
    <Link className={className} to={to(item.path)}>
      {children}
    </Link>
  ) : (
    <Link className={className} to={to(loc, item.name)} state={{ viewer: true }}>
      {children}
    </Link>
  );
}

/** The way from the shared folder to where the visitor is, never above it. It scrolls sideways where it is longer than the screen, and stays at its end, where they are. */
function Crumbs({ shareName, path, to }: { shareName: string; path: string; to: (path: string) => { pathname: string; search: string } }) {
  const list = crumbs(shareName, path);
  const track = useRef<HTMLOListElement>(null);
  useEffect(() => {
    track.current?.scrollTo({ left: track.current.scrollWidth });
  }, [path]);
  return (
    <nav aria-label={t("Path")} className="min-w-0 basis-full sm:basis-auto sm:flex-1">
      <ol ref={track} className="m-0 flex list-none items-center overflow-x-auto p-0 [scrollbar-width:none]">
        {list.map((crumb, index) => (
          <li key={crumb.path} className="flex shrink-0 items-center">
            {index > 0 ? <ChevronRight className="size-3.5 text-faint" /> : null}
            {index === list.length - 1 ? (
              <span aria-current="page" className="flex h-(--kago-control-h) items-center px-2 font-medium">
                {crumb.label}
              </span>
            ) : (
              <Link className="flex h-(--kago-control-h) items-center rounded-md px-2 text-muted hover:bg-hover hover:text-ink" to={to(crumb.path)}>
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A big folder may take a while to be read; past a few seconds it is said so instead of leaving a spinner to guess at. */
function Waiting() {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLong(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-col items-center">
      <KagoLoading />
      {long ? <p className="m-0 -mt-4 px-6 pb-8 text-center text-muted">{t("Reading a large folder. This can take a moment.")}</p> : null}
    </div>
  );
}
