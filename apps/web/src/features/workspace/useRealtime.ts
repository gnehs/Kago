import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

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

    function handleMessage(event: MessageEvent) {
      const message = JSON.parse(event.data) as { type?: string; userId?: string };
      const type = String(message.type);
      if (type.startsWith("task.")) {
        invalidate("tasks");
        if (type === "task.done") invalidate("fs", "trash");
      }
      if (type === "shelf.updated") invalidate("shelves");
      if (type === "share.updated") invalidate("shares");
      if (type === "permission.updated") invalidate("permissions", "roots", "fs");
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
        }
        retryCount = 0;
        invalidate("tasks", "shelves", "shares", "permissions", "roots");
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
