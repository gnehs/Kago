import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { taskDownloadUrl } from "@/api/client";
import { askForArchivePassword, pendingExtracts } from "@/features/files/ArchivePassword";
import { pendingDownloads } from "@/features/files/useFileActions";
import { taskErrorLabel, taskTypeLabel } from "@/features/tasks/taskUtils";
import { triggerDownload } from "@/lib/paths";
import { loadSettings } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { showTrashing, useTrashingStore } from "@/stores/trashing";
import type { FileTask } from "@/types/kago";
import { t } from "@/lib/i18n";

/** Task types whose completion is worth announcing; the rest finish quietly. */
const announcedTypes = ["copy", "move", "compress", "extract", "restore_trash", "sync"];

/**
 * Listens for server events. The socket only tells us what to refetch; SQLite stays the
 * source of truth, so every (re)connect refetches everything it could have missed.
 */
export function useRealtime(userId: string, onRemoteWorkspaceChange: () => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const invalidate = (...keys: string[]) => keys.forEach((key) => void queryClient.invalidateQueries({ queryKey: [key] }));
    let closed = false;
    let retryCount = 0;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;

    /** Tasks run on the server, so their outcome has to be announced or it goes unnoticed. */
    function announceTask(type: string, taskId: string, error?: string) {
      const task = queryClient.getQueryData<FileTask[]>(["tasks"])?.find((item) => item.id === taskId);
      const label = task ? taskTypeLabel(task) : t("Task");
      if (type === "task.failed") {
        pendingDownloads.delete(taskId);
        // A locked archive is asked about rather than reported.
        if (askForArchivePassword(queryClient, taskId, error)) return;
        toast(t("{task} failed: {reason}", { task: label, reason: taskErrorLabel(error ?? "Task failed") }), "error");
        return;
      }
      pendingExtracts.delete(taskId);
      if (pendingDownloads.delete(taskId)) {
        triggerDownload(taskDownloadUrl(taskId));
      } else if (task && announcedTypes.includes(task.type)) {
        toast(t("{task} finished", { task: label }));
      }
    }

    function handleMessage(event: MessageEvent) {
      const message = JSON.parse(event.data) as { type?: string; userId?: string; taskId?: string; error?: string; patch?: { status?: string } };
      const type = String(message.type);
      if (type.startsWith("task.")) {
        // Admins also receive other people's task events; only announce your own.
        if ((type === "task.done" || type === "task.failed") && message.userId === userId && message.taskId) announceTask(type, message.taskId, message.error);
        invalidate("tasks");
        if (type === "task.done") invalidate("trash");
        if (type === "task.done" || type === "task.failed") invalidate("sync-jobs");
        // A failed or cancelled move to the Trash leaves items behind, which the fresh listing brings back.
        if (type === "task.done" || type === "task.failed" || message.patch?.status === "cancelled") {
          const { taskId } = message;
          void queryClient.invalidateQueries({ queryKey: ["fs"] }).finally(() => showTrashing(taskId));
        }
      }
      if (type === "shelf.updated") invalidate("shelves");
      if (type === "share.updated") invalidate("shares");
      if (type === "apps.updated") invalidate("external-apps");
      if (type === "permission.updated") invalidate("permissions", "roots", "fs");
      if (type === "roots.updated") invalidate("roots", "storage", "fs");
      if (type === "settings.updated" && message.userId === userId) void loadSettings();
      // Someone has a new picture: one's own is on the bar, and an administrator's lists show everyone's.
      if (type === "account.updated") {
        if (message.userId === userId) void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
        invalidate("users", "groups");
      }
      if (type === "workspace.updated" && message.userId === userId) {
        onRemoteWorkspaceChange();
        invalidate("workspace");
      }
    }

    function connect() {
      if (closed) return;
      const ws = new WebSocket(`${protocol}://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        if (retryCount > 0) {
          onRemoteWorkspaceChange();
          invalidate("workspace");
          void loadSettings();
        }
        retryCount = 0;
        invalidate("tasks", "shelves", "shares", "permissions", "roots", "external-apps");
        // Whatever settled while the socket was away went unheard.
        if (Object.keys(useTrashingStore.getState().tasks).length > 0) void queryClient.invalidateQueries({ queryKey: ["fs"] }).finally(() => showTrashing());
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (closed) return;
        retryCount += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(15000, 500 * 2 ** Math.min(retryCount, 5)));
      };
    }

    connect();
    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [queryClient, userId, onRemoteWorkspaceChange]);
}
