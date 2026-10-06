import { FolderX, HardDrive, ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/format";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow } from "@/types/kago";

export type FileWindowError = { kind: "root_missing" | "path_missing" | "forbidden" | "unknown"; title: string; message: string };

export function classifyFileWindowError(error: unknown): FileWindowError | null {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : "";
  if (code === "ROOT_NOT_FOUND") return { kind: "root_missing", title: "找不到這個位置", message: "這個視窗原本指向的 Root 已不存在。" };
  if (code === "PATH_NOT_FOUND") return { kind: "path_missing", title: "找不到資料夾", message: "原本的資料夾路徑已失效。" };
  if (code === "FORBIDDEN") return { kind: "forbidden", title: "沒有存取權限", message: "你目前沒有權限開啟這個位置。" };
  return { kind: "unknown", title: "無法讀取資料夾", message: errorMessage(error, "請稍後再試。") };
}

/** A restored window whose target is gone stays open so the user decides what to do with it. */
export function WindowErrorState({ error, window, onRetry }: { error: FileWindowError; window: FileWindow; onRetry: () => void }) {
  const store = useWorkspaceStore.getState;

  function requestAccess() {
    const subject = encodeURIComponent(`Kago 存取申請：${window.rootSlug}:${window.logicalPath}`);
    const body = encodeURIComponent(`位置：${window.rootSlug}\n路徑：${window.logicalPath}\n\n請協助開通這個資料夾的存取權限。`);
    globalThis.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
  }

  return (
    <KagoEmptyState
      className="h-full"
      icon={error.kind === "root_missing" ? <HardDrive /> : error.kind === "forbidden" ? <ShieldAlert /> : <FolderX />}
      title={error.title}
      description={error.message}
    >
      {error.kind === "path_missing" ? <Button onClick={() => store().updateWindow(window.id, { logicalPath: "/", selectedItems: [] })}>回到最上層</Button> : null}
      {error.kind === "forbidden" ? <Button onClick={requestAccess}>申請存取</Button> : null}
      {error.kind === "unknown" ? <Button onClick={onRetry}>重試</Button> : null}
      <Button onClick={() => store().closeWindow(window.id)}>關閉視窗</Button>
    </KagoEmptyState>
  );
}
