import { ChevronLeft, ChevronRight, Columns3, FolderPlus, Info, LayoutGrid, List, Search, Upload, X } from "lucide-react";
import { KagoIconButton } from "@/components/kago/icon-button";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow } from "@/types/kago";
import { Breadcrumb } from "./Breadcrumb";

const viewModes = [
  { mode: "list", label: "列表", icon: <List /> },
  { mode: "grid", label: "圖示", icon: <LayoutGrid /> },
  { mode: "columns", label: "直欄", icon: <Columns3 /> }
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
};

export function FileToolbar({ window, rootName, readonly, canGoBack, canGoForward, search, onSearch, onGo, onNavigate, onNewFolder, onUpload }: FileToolbarProps) {
  const inspectorOpen = useWorkspaceStore((state) => Boolean(state.inspector.open));
  const store = useWorkspaceStore.getState;

  return (
    <div className="@container flex h-10 shrink-0 items-center gap-1 border-b border-line bg-elevated px-2">
      <KagoIconButton label="上一頁" disabled={!canGoBack} onClick={() => onGo(-1)}><ChevronLeft /></KagoIconButton>
      <KagoIconButton label="下一頁" disabled={!canGoForward} onClick={() => onGo(1)}><ChevronRight /></KagoIconButton>
      <Breadcrumb window={window} rootName={rootName} onNavigate={onNavigate} />

      <label className="hidden h-(--kago-control-h) w-40 items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 @2xl:flex">
        <Search className="size-3.5 text-faint" />
        <input aria-label="篩選目前資料夾" placeholder="篩選" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" value={search} onChange={(event) => onSearch(event.target.value)} />
        {search ? (
          <button aria-label="清除篩選" className="text-faint hover:text-ink" onClick={() => onSearch("")}><X className="size-3.5" /></button>
        ) : null}
      </label>

      <div className="flex rounded-md border border-line bg-surface p-px" role="radiogroup" aria-label="檢視方式">
        {viewModes.map(({ mode, label, icon }) => (
          <button
            key={mode}
            role="radio"
            aria-checked={window.viewMode === mode}
            aria-label={label}
            title={label}
            className={cn("flex h-[calc(var(--kago-control-h)-4px)] w-7 items-center justify-center rounded-sm text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50", window.viewMode === mode && "bg-hover text-ink")}
            onClick={() => store().updateWindow(window.id, { viewMode: mode })}
          >
            {icon}
          </button>
        ))}
      </div>

      <KagoIconButton label="新增資料夾" disabled={readonly} onClick={onNewFolder}><FolderPlus /></KagoIconButton>
      <KagoIconButton label="上傳檔案" disabled={readonly} onClick={onUpload}><Upload /></KagoIconButton>
      <KagoIconButton label="資訊（⌘I）" active={inspectorOpen} onClick={() => store().updateInspector({ open: !inspectorOpen })}><Info /></KagoIconButton>
    </div>
  );
}
