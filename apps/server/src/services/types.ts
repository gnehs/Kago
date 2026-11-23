import type { Role, Root as PublicRoot, TaskStatus } from "@kago/contract";

export type { Actor, FileRef, FileTask, Role, TaskStatus } from "@kago/contract";

export type User = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  disabled: number;
  /** When their profile picture was last set. Null without one. */
  avatar_at: number | null;
  created_at: number;
  updated_at: number;
};

export type PublicUser = Omit<User, "password_hash">;

export type Root = PublicRoot & {
  /** The folder on disk for a local root; empty for a remote one, which has no path of its own. */
  base_path: string;
  /** A remote root's connection settings, sealed. */
  config: string | null;
};

/** Tasks that are waiting, or that a worker may still be writing for. */
export const activeTaskStatuses = ["queued", "paused", "running", "cancelling"] as const satisfies readonly TaskStatus[];
/** Tasks nothing works on any more. */
export const finishedTaskStatuses = ["done", "failed", "cancelled", "interrupted"] as const satisfies readonly TaskStatus[];

export const isActiveTaskStatus = (status: string) => (activeTaskStatuses as readonly string[]).includes(status);

/** The statuses as a list for SQL's `IN (...)`. */
export const sqlStatuses = (statuses: readonly TaskStatus[]) => statuses.map((status) => `'${status}'`).join(", ");

