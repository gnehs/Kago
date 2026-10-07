import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, Ellipsis, FolderPlus, Info, LayoutGrid, List, Search, Square, Upload, X } from "lucide-react";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem } from "@/components/kago/menu";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow } from "@/types/kago";
import { Breadcrumb } from "./Breadcrumb";
import { sortColumns, toggleSort } from "./FileList";

/** Nine squares, drawn to sit beside the one and the four that lucide has. */
const Grid9 = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="lucide">
    {[3, 10, 17].flatMap((y) => [3, 10, 17].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" />))}
  </svg>
);

/** The sizes of the icon view, in the order its button steps through them. The button shows the one in use. */
const iconSizes = [
  { size: "large", label: "大", icon: <Square /> },
  { size: "medium", label: "中", icon: <LayoutGrid /> },
  { size: "small", label: "小", icon: <Grid9 /> }
] as const;

type FileToolbarProps = {
  window: FileWindow;
  rootName: string;
  readonly: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  search: string;
  onSearch: (value: string) => void;
  onGo: (delta: -1 | 1) => void;
  onNavigate: (path: string) => void;
  onNewFolder: () => void;
  onUpload: () => void;
  /** The same actions as the right-click menu, for the selection or else the folder. Null when the folder cannot be read. */
  menu: ReactNode;
};

/** Sets one group of controls apart from the next. */
const Divider = () => <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong/70" />;

export function FileToolbar({ window, rootName, readonly, canGoBack, canGoForward, search, onSearch, onGo, onNavigate, onNewFolder, onUpload, menu }: FileToolbarProps) {
  const store = useWorkspaceStore.getState;
  const sizeIndex = Math.max(0, iconSizes.findIndex(({ size }) => size === (window.iconSize ?? "medium")));
  const iconSize = iconSizes[sizeIndex]!;
  const viewModes = [
    { mode: "list", label: "列表", icon: <List />, onClick: () => store().updateWindow(window.id, { viewMode: "list" }) },
    {
      mode: "grid",
      label: window.viewMode === "grid" ? `圖示（${iconSize.label}）· 再按一下切換大小` : "圖示",
      icon: iconSize.icon,
      // Already in the icon view, the button steps to the next size instead.
      onClick: () => store().updateWindow(window.id, window.viewMode === "grid" ? { iconSize: iconSizes[(sizeIndex + 1) % iconSizes.length]!.size } : { viewMode: "grid" })
    },
    { mode: "columns", label: "直欄", icon: <Columns3 />, onClick: () => store().updateWindow(window.id, { viewMode: "columns" }) }
  ] as const;

  return (
    <div className="kago-toolbar @container flex h-10 shrink-0 items-center gap-1 border-b border-line-strong px-2">
      <div className="kago-segments mr-1">
        <KagoIconButton label="上一頁" className="size-6" disabled={!canGoBack} onClick={() => onGo(-1)}><ChevronLeft /></KagoIconButton>
        <KagoIconButton label="下一頁" className="size-6" disabled={!canGoForward} onClick={() => onGo(1)}><ChevronRight /></KagoIconButton>
      </div>
      <Breadcrumb window={window} rootName={rootName} onNavigate={onNavigate} />

      <label className="kago-well hidden h-7 w-40 items-center gap-1.5 rounded-full px-2.5 @2xl:flex">
        <Search className="size-3.5 text-faint" />
        <input aria-label="篩選目前資料夾" placeholder="篩選" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" value={search} onChange={(event) => onSearch(event.target.value)} />
        {search ? (
          <button aria-label="清除篩選" className="text-faint hover:text-ink" onClick={() => onSearch("")}><X className="size-3.5" /></button>
        ) : null}
      </label>

      <Divider />
      <div className="kago-segments" role="radiogroup" aria-label="檢視方式">
        {viewModes.map(({ mode, label, icon, onClick }) => (
          <button
            key={mode}
            role="radio"
            aria-checked={window.viewMode === mode}
            aria-label={label}
            title={label}
            className="flex h-6 w-7.5 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset"
            onClick={onClick}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* The list view sorts from its column headers; the other views have none. */}
      {window.viewMode === "list" ? null : (
        <KagoDropdownMenu
          label="排序方式"
          menu={sortColumns.map(({ sortBy, label }) => (
            <KagoMenuItem
              key={sortBy}
              closeOnClick={false}
              icon={window.sortBy !== sortBy ? <span className="size-4" /> : window.sortDirection === "asc" ? <ArrowUp /> : <ArrowDown />}
              onClick={() => toggleSort(window, sortBy)}
            >
              {label}
            </KagoMenuItem>
          ))}
        >
          <ArrowUpDown />
        </KagoDropdownMenu>
      )}

      <Divider />
      <KagoIconButton label="新增資料夾" disabled={readonly} onClick={onNewFolder}><FolderPlus /></KagoIconButton>
      <KagoIconButton label="上傳檔案" disabled={readonly} onClick={onUpload}><Upload /></KagoIconButton>
      <Divider />
      <KagoIconButton label="資訊（⌘I）" active={Boolean(window.inspectorOpen)} onClick={() => store().updateWindow(window.id, { inspectorOpen: !window.inspectorOpen })}><Info /></KagoIconButton>
      {menu ? <KagoDropdownMenu label={window.selectedItems.length > 0 ? "選取項目的所有動作" : "資料夾動作"} menu={menu}><Ellipsis /></KagoDropdownMenu> : null}
    </div>
  );
}
