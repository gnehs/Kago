import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, taskDownloadUrl } from "@/api/client";
import { dropLeft, foldersChanged } from "@/api/hooks";
import { invalidateEvent, invalidateKeys, isServerEventType, reconnectKeys } from "@/api/invalidations";
import { isListingKey, keys } from "@/api/keys";
import { askForArchivePassword, pendingExtracts } from "@/features/files/ArchivePassword";
import { pendingDownloads } from "@/features/files/useFileActions";
import { announcedTypes, settleTask, taskFailed, taskFinished } from "@/features/tasks/taskToast";
import { taskTypeLabel } from "@/features/tasks/taskUtils";
import { parentPath, triggerDownload } from "@/lib/paths";
import { loadSettings } from "@/stores/settings";
import type { FileTask as WireFileTask, ServerEvent } from "@kago/contract";
import { leavingRefs, settleLeaving, showLeaving, useLeavingStore } from "@/stores/leaving";
import type { FileTask } from "@/types/kago";
import { t } from "@/lib/i18n";

/**
 * Listens for server events. The socket only tells us what to refetch; SQLite stays the
 * source of truth, so every (re)connect refetches everything it could have missed.
 */
export function useRealtime(userId: string, onRemoteWorkspaceChange: () => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    let closed = false;
    let retryCount = 0;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;

    /**
     * Tasks run on the server, so their outcome has to be announced or it goes unnoticed.
     * It is said in the notification that was counting the task, if this tab had one up.
     */
    function announceTask(type: "task.done" | "task.failed", taskId: string, error?: string) {
      const task = queryClient.getQueryData<FileTask[]>(keys.tasks())?.find((item) => item.id === taskId);
      const label = task ? taskTypeLabel(task) : t("Task");
      if (type === "task.failed") {
        pendingDownloads.delete(taskId);
        // A locked archive is asked about rather than reported.
        if (askForArchivePassword(queryClient, taskId, error)) settleTask(taskId);
        else settleTask(taskId, taskFailed(label, error), "error");
        return;
      }
      pendingExtracts.delete(taskId);
      if (pendingDownloads.delete(taskId)) {
        triggerDownload(taskDownloadUrl(taskId));
        settleTask(taskId);
      } else settleTask(taskId, task && announcedTypes.includes(task.type) ? taskFinished(label) : undefined);
    }

    /**
     * A task has ended. What a finished one changed is told of by the server; what it carried away is taken out of
     * every listing kept at once. One that failed or was cancelled may have done part of its work, unannounced, and
     * left the rest where it was: the folders it was working in are read again before what it carried shows again.
     */
    function settle(taskId: string, done: boolean) {
      const left = leavingRefs(taskId);
      settleLeaving(taskId, done);
      if (done) {
        dropLeft(queryClient, left);
        showLeaving(taskId);
        return;
      }
      const folders = left.map((ref) => ({ rootSlug: ref.rootSlug, path: parentPath(ref.path) }));
      const task = queryClient.getQueryData<FileTask[]>(keys.tasks())?.find((item) => item.id === taskId);
      if (task) {
        // A copy's destination is a folder; an archive's is the file being written, in its folder.
        if (task.destination) folders.push(task.destination, { rootSlug: task.destination.rootSlug, path: parentPath(task.destination.path) });
        if (["move", "delete_to_trash", "delete"].includes(task.type)) {
          for (const source of task.sources) folders.push({ rootSlug: source.rootSlug, path: parentPath(source.path) });
        }
      }
      const byRoot = new Map<string, Set<string>>();
      for (const { rootSlug, path } of folders) byRoot.set(rootSlug, (byRoot.get(rootSlug) ?? new Set()).add(path));
      return Promise.all([...byRoot].map(([rootSlug, paths]) => foldersChanged(queryClient, { rootSlug, paths: [...paths] }))).finally(() => showLeaving(taskId));
    }

    /** Tasks that settled while the socket was away went unheard; the ones still carrying items away are asked about. */
    async function settleUnheard(listings: Promise<unknown>) {
      const waiting = Object.keys(useLeavingStore.getState().tasks).filter((taskId) => !taskId.startsWith("asking:"));
      if (waiting.length === 0) return;
      const tasks = await api<WireFileTask[]>("/api/tasks");
      for (const taskId of waiting) {
        const task = tasks.find((item) => item.id === taskId);
        if (task && !["done", "failed", "cancelled", "interrupted"].includes(task.status)) continue;
        // The listings read again on reconnecting already have whatever a failed one did.
        settleLeaving(taskId, task?.status === "done");
        if (task?.status === "done") dropLeft(queryClient, leavingRefs(taskId));
        void listings.finally(() => showLeaving(taskId));
      }
    }

    function handleMessage(event: MessageEvent) {
      const message = JSON.parse(event.data) as ServerEvent;
      const own = "userId" in message && message.userId === userId;
      if (message.type === "workspace.updated") {
        if (!own) return;
        onRemoteWorkspaceChange();
      }
      if (isServerEventType(message.type)) void invalidateEvent(queryClient, message.type);
      if (message.type === "task.done" || message.type === "task.failed") {
        // Admins also receive other people's task events; only announce your own.
        if (own) announceTask(message.type, message.taskId, message.type === "task.failed" ? message.error : undefined);
        void settle(message.taskId, message.type === "task.done");
      } else if (message.type === "task.progress" && message.patch.status === "cancelled") void settle(message.taskId, false);
      // Whoever can see a location hears what changed in it, by anyone; the folders it names are read again.
      if (message.type === "fs.changed") void foldersChanged(queryClient, message);
      if (message.type === "settings.updated" && own) void loadSettings();
      // Someone has a new picture: one's own is on the bar, and an administrator's lists show everyone's.
      if (message.type === "account.updated" && own) void queryClient.invalidateQueries({ queryKey: keys.auth.me() });
    }

    function connect() {
      if (closed) return;
      const ws = new WebSocket(`${protocol}://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        const reconnecting = retryCount > 0;
        if (reconnecting) {
          onRemoteWorkspaceChange();
          void loadSettings();
        }
        // Whatever changed while the socket was away went unheard. Only listings are read again, and none is started
        // over: sizes and searches take far longer, and are asked for again when next shown.
        const listings =
          retryCount > 0
            ? queryClient.invalidateQueries({ queryKey: keys.fs.lists(), predicate: (query) => isListingKey(query.queryKey) }, { cancelRefetch: false })
            : Promise.resolve();
        if (retryCount > 0) void queryClient.invalidateQueries({ queryKey: keys.fs.all(), refetchType: "none" });
        retryCount = 0;
        // The workspace was just read on the first connect; only a gap can have left it behind.
        void invalidateKeys(queryClient, reconnecting ? reconnectKeys : reconnectKeys.filter((key) => key[0] !== "workspace"));
        void settleUnheard(listings).catch(() => undefined);
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
