import type { ServerEventType } from "@kago/contract";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { keys } from "./keys";

/**
 * What each event makes stale. A mutation that causes the same server-side change invalidates the same keys through
 * `invalidateEvent`, so a page and the socket cannot drift apart.
 * `fs.changed` names the folders it touched and is applied by `foldersChanged`; `settings.updated` is read from
 * the settings store, not the query cache.
 */
export const eventKeys = {
  "task.created": [keys.tasks()],
  "task.progress": [keys.tasks()],
  "task.done": [keys.tasks(), keys.trash(), keys.syncJobs(), keys.convertJobs()],
  "task.failed": [keys.tasks(), keys.syncJobs(), keys.convertJobs()],
  "shelf.updated": [keys.shelves()],
  "workspace.updated": [keys.workspace()],
  "settings.updated": [],
  "account.updated": [keys.users(), keys.groups()],
  "permission.updated": [keys.permissions.all(), keys.roots(), keys.fs.all()],
  "roots.updated": [keys.roots(), keys.storage(), keys.fs.all()],
  "apps.updated": [keys.externalApps()],
  "share.updated": [keys.shares()],
  "trash.updated": [keys.trash()],
  "fs.changed": []
} as const satisfies Record<ServerEventType, readonly QueryKey[]>;

/**
 * Everything an event can make stale, for a socket that was away and heard none of them. Folder data is left out:
 * reconnecting reads listings again and marks the rest of `fs` stale without refetching it.
 */
export const reconnectKeys: readonly QueryKey[] = (() => {
  const seen = new Map<string, QueryKey>();
  for (const queryKeys of Object.values(eventKeys)) {
    for (const queryKey of queryKeys) if (queryKey[0] !== "fs") seen.set(JSON.stringify(queryKey), queryKey);
  }
  return [...seen.values()];
})();

export function isServerEventType(type: string): type is ServerEventType {
  return Object.hasOwn(eventKeys, type);
}

export function invalidateKeys(client: QueryClient, queryKeys: readonly QueryKey[]): Promise<unknown> {
  return Promise.all(queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function invalidateEvent(client: QueryClient, type: ServerEventType): Promise<unknown> {
  return invalidateKeys(client, eventKeys[type]);
}
