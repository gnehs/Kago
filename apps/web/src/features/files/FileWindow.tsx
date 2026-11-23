import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Plus } from "lucide-react";
import { useFileList } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoContextMenu } from "@/components/kago/menu";
import { KagoWindow } from "@/components/kago/window";
import { FileIcon } from "@/components/kago/file-icon";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useRecentStore } from "@/stores/recent";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow, FolderWindow, Root } from "@/types/kago";
import { DropLayer } from "./DropLayer";
import { FileColumns, FileList } from "./FileList";
import { FileMenu } from "./FileMenu";
import { FileStatusBar } from "./FileStatusBar";
import { FileToolbar } from "./FileToolbar";
import { indexesInArea, useFileLayout } from "./fileLayout";
import { useFolderView } from "./folderView";
import { Inspector } from "./Inspector";
import { Sidebar } from "./Sidebar";
import { TabStrip } from "./TabStrip";
import { useColumns } from "./useColumns";
import { useFileActions } from "./useFileActions";
import { useFileDrop } from "./useFileDrop";
import { useFileHistory } from "./useFileHistory";
import { useFileSearch } from "./useFileSearch";
import { useFileViewRegistry } from "./useFileViewRegistry";
import { useFolderListing } from "./useFolderListing";
import { useItemInteractions } from "./useItemInteractions";
import { useMarqueeSelection } from "./useMarqueeSelection";
import { useOpenFolders } from "./useOpenFolders";
import { useScrollMemory } from "./useScrollMemory";
import { useUploadPicker } from "./useUploadPicker";
import { classifyFileWindowError, WindowErrorState } from "./WindowErrorState";

const store = useWorkspaceStore.getState;
/** The icon of a window showing a folder. */
const FOLDER = { kind: "folder", type: "", name: "" } as const;

export function FileWindowView({ window: frame, roots }: { window: FileWindow; roots: Root[] }) {
  const rootName = roots.find((root) => root.slug === frame.rootSlug)?.name ?? frame.rootSlug;
  const fileList = useFileList(frame.rootSlug, frame.logicalPath);
  // The folder says how it is shown; the window only shows it.
  const folderView = useFolderView(frame.rootSlug, frame.logicalPath, fileList.data?.items);
  const title = folderTitle(frame.rootSlug, frame.logicalPath);
  const win = useMemo<FolderWindow>(() => ({ ...frame, ...folderView.view, title }), [frame, folderView.view, title]);
  const actions = useFileActions(win);
  const tabId = frame.activeTabId;
  const search = useFileSearch(win, tabId);
  const openFolders = useOpenFolders(win.id, tabId);
  const history = useFileHistory(win, tabId);
  const { allItems, listed, trail, expandedContents, tree } = useFolderListing(win, fileList, openFolders, search);
  const { columns, activeColumn, opened, columnReveal, items } = useColumns(win, listed, trail, expandedContents);
  const { searching, searched } = search;

  // A folder that could not be read again goes on showing what it held, unless it is gone or out of reach.
  const failure = classifyFileWindowError(fileList.error);
  const error = failure && (!fileList.data || failure.kind !== "unknown") ? failure : null;
  const readonly = Boolean(fileList.data?.readonly);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const layout = useFileLayout(scroller, win.viewMode, win.iconSize);
  const marquee = useMarqueeSelection(win.id, (area) => indexesInArea(layout, listed.length, area).map((index) => listed[index]!.path));

  useEffect(() => {
    if (fileList.data) useRecentStore.getState().visit({ rootSlug: win.rootSlug, path: win.logicalPath });
  }, [fileList.data, win.rootSlug, win.logicalPath]);

  // Going somewhere else in a tab ends its search and closes its folders; going to another tab finds that tab's as they were left.
  const searchedPlace = useRef({ tabId, rootSlug: win.rootSlug, path: win.logicalPath });
  useEffect(() => {
    const before = searchedPlace.current;
    searchedPlace.current = { tabId, rootSlug: win.rootSlug, path: win.logicalPath };
    if (before.tabId !== tabId || (before.rootSlug === win.rootSlug && before.path === win.logicalPath)) return;
    search.reset();
    openFolders.closeAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `search` and `openFolders` are new objects every render; this runs when the place changes, not when they do.
  }, [win.logicalPath, win.rootSlug, tabId]);

  useScrollMemory(scroller, win, tabId, Boolean(fileList.data), history.viaHistory);
  const { selectedItems, menuTargets, menuFolder, openItem, selectItem, tapItem, holdItem, onContextItem, onAreaMenu } = useItemInteractions(win, items, columns, history.navigate);
  useFileViewRegistry({ win, items, columns, activeColumn, opened, columnReveal, tree, layout, scroller, readonly, error });
  const drop = useFileDrop(win, readonly, error, actions, scroller);
  const picker = useUploadPicker(actions, win.logicalPath);
  const menu = (targets: typeof items, folder?: string) => <FileMenu win={win} targets={targets} folder={folder} readonly={readonly} allItems={allItems} actions={actions} openItem={openItem} picker={picker} />;

  return (
    <KagoWindow
      window={win}
      icon={<FileIcon item={FOLDER} />}
      titleBar={win.tabs.length > 1 ? <TabStrip window={win} roots={roots} /> : undefined}
      titleExtra={
        <>
          {readonly ? <KagoBadge>{t("Read-only")}</KagoBadge> : null}
          <KagoIconButton label={t("New tab (⌥T)")} className="kago-hit-slop size-6" onClick={() => store().openTab(win.id, win)}><Plus /></KagoIconButton>
        </>
      }
      onDragOver={(event) => {
        event.preventDefault();
        drop.setDropActive(event.dataTransfer.types.includes("Files") ? "files" : "items");
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && drop.setDropActive(false)}
      onDrop={(event) => drop.dropInto(event, win.logicalPath)}
    >
      <FileToolbar
        window={win}
        folderView={folderView}
        rootName={rootName}
        readonly={readonly || Boolean(error)}
        canGoBack={history.canGoBack}
        canGoForward={history.canGoForward}
        search={search.search}
        onSearch={search.setSearch}
        onGo={history.go}
        onNavigate={(path) => history.navigate(path)}
        onNewFolder={() => void actions.newFolder()}
        onUpload={() => picker.pickFiles(win.logicalPath)}
        menu={error ? null : menu(selectedItems)}
      />

      <div className="@container/body relative flex min-h-0 flex-1">
        {win.sidebarOpen === false ? null : <Sidebar window={win} roots={roots} onNavigate={history.goTo} onDragTarget={() => drop.setDropActive(false)} onDropInto={(event, folder) => drop.dropInto(event, folder.path, folder.rootSlug)} />}
        {error ? (
          <div className="min-h-0 min-w-0 flex-1">
            <WindowErrorState error={error} window={win} onRetry={() => void fileList.refetch()} />
          </div>
        ) : (
          <KagoContextMenu menu={menu(menuTargets, menuFolder ?? win.logicalPath)} className="flex min-h-0 min-w-0 flex-1">
            {/* The columns scroll one by one, so there is no one area for a rubber band to be drawn across. */}
            <div
              ref={setScroller}
              className={cn(
                "relative min-w-0 flex-1 select-none",
                columns && listed.length > 0 ? "flex overflow-hidden" : "overflow-auto",
                // The list is taller than the area it scrolls in, so its focus ring is drawn on that area.
                !columns && "has-[[role=listbox]:focus-visible]:outline-2 has-[[role=listbox]:focus-visible]:-outline-offset-2 has-[[role=listbox]:focus-visible]:outline-accent/60"
              )}
              onContextMenuCapture={onAreaMenu}
              onTouchStartCapture={onAreaMenu}
              {...(columns ? {} : marquee.handlers)}
            >
              {fileList.isLoading || (searching && listed.length === 0 && search.pending && !searched.isError) ? <KagoLoading /> : null}
              {fileList.data && listed.length === 0 && !(searching && search.pending && !searched.isError) ? (
                <KagoEmptyState
                  className="h-full"
                  icon={<Folder />}
                  title={searching ? (searched.isError ? t("Couldn’t load") : t("No matching items")) : t("This folder is empty")}
                  description={searching ? (searched.isError ? searched.error.message : t("Nothing in this folder or its subfolders has “{query}” in its name.", { query: search.typed })) : readonly ? t("This location is read-only.") : t("Drag files in, or upload from the toolbar.")}
                />
              ) : null}
              {listed.length === 0 ? null : columns ? (
                <FileColumns
                  window={win}
                  columns={columns}
                  revealers={columnReveal}
                  onSelect={(event, item, column) => selectItem(event, item, columns[column]!.items)}
                  onTap={(item, column) => tapItem(item, columns[column]!.items)}
                  onHold={(item, column) => holdItem(item, columns[column]!.items)}
                  onSelectColumn={(column) => store().selectItems(win.id, column === 0 ? [] : [columns[column]!.folder])}
                  onOpen={openItem}
                  onContextItem={onContextItem}
                  onDropInto={readonly ? undefined : drop.dropInto}
                />
              ) : (
                <FileList window={win} items={items} tree={tree} locateFrom={searching ? win.logicalPath : undefined} scroller={scroller} layout={layout} onSelect={selectItem} onOpen={openItem} onContextItem={onContextItem} onTap={tapItem} onHold={holdItem} onDropInto={readonly ? undefined : (event, folder) => drop.dropInto(event, folder.path)} />
              )}
              {marquee.style ? <div className="pointer-events-none absolute border border-accent bg-accent/15" style={marquee.style} /> : null}
            </div>
          </KagoContextMenu>
        )}
        {win.inspectorOpen ? <Inspector window={win} selection={selectedItems} /> : null}
      </div>

      <FileStatusBar selectedItems={selectedItems} allItems={allItems} readonly={readonly} actions={actions} error={error} search={search} fileList={fileList} />

      <DropLayer win={win} active={error ? false : drop.dropActive} readonly={readonly} choice={drop.dropChoice} actions={actions} onClose={drop.closeDropChoice} />
      {picker.inputs}
    </KagoWindow>
  );
}
