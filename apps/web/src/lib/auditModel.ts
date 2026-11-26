import type { AuditAction, AuditBurst, AuditCategory, AuditFilter, AuditLog } from "@kago/contract";
import { addDays, daysAgo, startOfDay } from "./days.ts";

/*
 * What the audit log window knows about its rows without asking anyone: what to ask the server for, which day each row
 * is under, who did it, what happened as a sentence, and what else is worth reading when a row is opened. The words
 * are chosen by the components, which hold the translations; this file only says which sentence applies and with
 * what, so that node can test it.
 */

/** Rows asked for at a time; a run counts as one. */
export const AUDIT_PAGE = 100;

/** Members of an opened run listed at first, and how many more each "more…" adds. */
export const MEMBERS_FIRST = 5;
export const MEMBERS_MORE = 50;

// ---------------------------------------------------------------------------------------------------------------------
// What to ask for
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The switch's choices. The first row of them is what an admin reaches for; the rest (accounts, tasks, settings,
 * and what the server turned away) sit behind "More" so that the switch stays a short row and not a list of actions.
 */
export const MAIN_VIEWS = ["important", "sign_in", "file", "share", "permission", "problems", "all"] as const;
export const MORE_VIEWS = ["account", "task", "settings", "system"] as const;
export type AuditView = (typeof MAIN_VIEWS)[number] | (typeof MORE_VIEWS)[number];

export const isMoreView = (view: AuditView): view is (typeof MORE_VIEWS)[number] => (MORE_VIEWS as readonly string[]).includes(view);

/**
 * What a view narrows the log to. Everything but Sign-ins and All leaves out the low-signal rows: an admin who picks
 * Files wants what people did, not every thumbnail drawn. Sign-ins keeps them, since a sign-out is one.
 */
export function viewFilter(view: AuditView): Pick<AuditFilter, "category" | "result" | "important"> {
  switch (view) {
    case "important":
      return { important: true };
    case "sign_in":
      return { category: "sign_in" };
    case "problems":
      return { result: "failure,denied", important: true };
    case "all":
      return {};
    default:
      return { category: view satisfies AuditCategory, important: true };
  }
}

/** A day range as the admin chose it: a name for a stretch ending now, or two dates (`YYYY-MM-DD`, either may be left open). */
export type DateRange = { kind: "any" } | { kind: "preset"; preset: "today" | "yesterday" | "week" | "month" } | { kind: "custom"; from: string; to: string };

export const ANY_DATE: DateRange = { kind: "any" };

const dateOf = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day.getTime() / 1000;
};

/** The range in unix seconds, `from` inclusive and `to` exclusive, by the clock of the person looking. A custom range's last day is included whole. */
export function rangeSeconds(range: DateRange, now: number): { from?: number; to?: number } {
  if (range.kind === "any") return {};
  if (range.kind === "preset") {
    switch (range.preset) {
      case "today":
        return { from: startOfDay(now) };
      case "yesterday":
        return { from: addDays(now, -1), to: startOfDay(now) };
      case "week":
        return { from: addDays(now, -6) };
      case "month":
        return { from: addDays(now, -29) };
    }
  }
  const from = dateOf(range.from);
  const last = dateOf(range.to);
  return { ...(from === null ? {} : { from }), ...(last === null ? {} : { to: addDays(last, 1) }) };
}

/** What narrows the log besides the view: whose, when, and what was typed in the search. `actor` is "" for everyone. */
export type AuditScope = { view: AuditView; actor: string; dates: DateRange; query: string };

export const isFiltered = (scope: AuditScope) => scope.actor !== "" || scope.dates.kind !== "any" || scope.query.trim() !== "";

/** `before` for the page after `row`: where it was written and its id, so that rows written in the same second are neither skipped nor shown twice. */
export const cursorOf = (row: Pick<AuditLog, "created_at" | "id">) => `${row.created_at}:${row.id}`;

/** The query string for a page of the log. `before` is the cursor of the last row already listed. */
export function auditParams(scope: AuditScope, now: number, before?: string, limit = AUDIT_PAGE): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit) });
  const { category, result, important } = viewFilter(scope.view);
  if (category) params.set("category", category);
  if (result) params.set("result", result);
  if (important) params.set("important", "true");
  if (scope.actor) params.set("actor", scope.actor);
  const { from, to } = rangeSeconds(scope.dates, now);
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(to));
  // The server takes 1 to 100 characters.
  const query = scope.query.trim().slice(0, 100);
  if (query) params.set("q", query);
  if (before) params.set("before", before);
  return params;
}

// ---------------------------------------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------------------------------------

export type EventDay = { /** The local day's first second. */ day: number; name: "today" | "yesterday" | "date"; rows: AuditLog[] };

/** Rows as the server sends them, newest first, under the day they were written, by the clock of the person looking; a day with nothing is not there. */
export function arrangeDays(rows: readonly AuditLog[], now: number): EventDay[] {
  const days: EventDay[] = [];
  for (const row of rows) {
    const day = startOfDay(row.created_at);
    const last = days.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else {
      const ago = daysAgo(row.created_at, now);
      days.push({ day, name: ago <= 0 ? "today" : ago === 1 ? "yesterday" : "date", rows: [row] });
    }
  }
  return days;
}

// ---------------------------------------------------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------------------------------------------------

export type Agent = { browser: string; version: string | null; os: string | null; device: string | null };

const major = (version: string | undefined) => version?.split(".")[0] ?? null;

/** The browser and system a user agent names, for the common cases; null where it is something this does not know, which the caller shows as it came. */
export function parseUserAgent(userAgent: string | null | undefined): Agent | null {
  const ua = userAgent?.trim();
  if (!ua) return null;
  let os: string | null = null;
  let device: string | null = null;
  if (/\biPhone\b/.test(ua)) [os, device] = ["iOS", "iPhone"];
  else if (/\biPad\b/.test(ua)) [os, device] = ["iPadOS", "iPad"];
  else if (/\bAndroid\b/.test(ua)) os = "Android";
  else if (/\bWindows NT\b/.test(ua)) os = "Windows";
  else if (/\bCrOS\b/.test(ua)) os = "ChromeOS";
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) os = "macOS";
  else if (/\bLinux\b|\bX11\b/.test(ua)) os = "Linux";
  const known: Array<[string, RegExp]> = [
    ["Edge", /\bEdg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /\bOPR\/([\d.]+)/],
    ["Samsung Internet", /\bSamsungBrowser\/([\d.]+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /\b(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /\bVersion\/([\d.]+).*\bSafari\//]
  ];
  for (const [browser, pattern] of known) {
    const match = pattern.exec(ua);
    if (match) return { browser, version: major(match[1]), os, device };
  }
  if (/^Mozilla\/.*\bSafari\//.test(ua) && os) return { browser: "Safari", version: null, os, device };
  // A program rather than a browser introduces itself as `name/version`.
  const tool = /^([A-Za-z][\w.-]{1,30})\/([\d.]+)/.exec(ua);
  if (tool && tool[1] !== "Mozilla") return { browser: tool[1]!, version: major(tool[2]), os: null, device: null };
  return null;
}

/** "Firefox 132 · Windows", or what the agent says of itself when it is not a thing this knows. */
export function agentText(userAgent: string | null | undefined): string | null {
  const agent = parseUserAgent(userAgent);
  if (!agent) return userAgent?.trim() || null;
  return [agent.version ? `${agent.browser} ${agent.version}` : agent.browser, agent.os].filter(Boolean).join(" · ");
}

/** A line's worth for after a sentence: "Safari · iPad". Null where the agent is not known. */
export function agentShort(userAgent: string | null | undefined): string | null {
  const agent = parseUserAgent(userAgent);
  return agent ? [agent.browser, agent.device ?? agent.os].filter(Boolean).join(" · ") : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Who, and what they did
// ---------------------------------------------------------------------------------------------------------------------

/** Names the rows do not carry themselves: of people and groups as they are called now, of locations by id and by slug. */
export type Names = { users: ReadonlyMap<string, string>; groups: ReadonlyMap<string, string>; roots: ReadonlyMap<string, string>; slugs: ReadonlyMap<string, string> };

/** Someone not signed in is `system` to the server. Who `someone` is, only the row's address says. */
export type Actor = { kind: "user"; name: string } | { kind: "deleted_user" } | { kind: "share_link" } | { kind: "system" } | { kind: "someone" };

/** Actions written by whoever asked, signed in or not: a row of one with no user is a stranger, not the server. */
const STRANGER_ACTIONS: ReadonlySet<string> = new Set<AuditAction>(["login_failed", "request_failed", "request_denied"]);

export function actorOf(row: Pick<AuditLog, "actor_type" | "actor_name" | "actor_email" | "action">): Actor {
  if (row.actor_type === "share_link") return { kind: "share_link" };
  if (row.actor_type === "user") {
    const name = row.actor_name || row.actor_email;
    return name ? { kind: "user", name: name.normalize("NFC") } : { kind: "deleted_user" };
  }
  return STRANGER_ACTIONS.has(row.action) ? { kind: "someone" } : { kind: "system" };
}

type Slot = "person" | "group" | "who" | "place" | "from" | "to" | "name" | "path" | "count";

/** Something after the sentence in the muted colour: text as it is, or what only the component can word. */
export type Tail = string | { folders: number; more: boolean } | { taskType: string } | { archive: { files: number; bytes: number } };

/**
 * Every sentence there is. Each has one message in the component, written whole with its `{actor}` and the `Slot`s it
 * names, so that a language can put them where it likes. A slot with nothing in it reads as a generic word there.
 */
export type SentenceId =
  | "unknown"
  | "setup_admin" | "login_success" | "login_success_sso" | "login_failed" | "login_failed_sso" | "logout" | "session_revoked" | "admin_recovery" | "admin_recovery_created"
  | "password_change" | "password_reset" | "user_create" | "user_create_sso" | "user_update" | "user_update_admin" | "user_update_user" | "user_disable" | "user_enable" | "set_avatar" | "sso_link" | "sso_link_failed" | "sso_unlink" | "sso_unlink_self"
  | "group_create" | "group_rename" | "group_delete" | "group_member_add" | "group_member_remove" | "permission_edit" | "permission_view" | "permission_remove" | "permission_dropped"
  | "denied_view" | "denied_edit" | "denied_admin" | "denied_shelf" | "denied_share" | "denied_task" | "denied_shared_app" | "denied"
  | "upload" | "upload_many" | "mkdir" | "mkdir_many" | "rename" | "rename_many" | "edit" | "edit_many" | "copy" | "copy_many" | "move" | "move_many" | "delete" | "delete_many" | "delete_to_trash" | "delete_to_trash_many"
  | "restore_trash" | "restore_trash_many" | "trash_empty" | "trash_empty_one" | "trash_empty_many" | "compress" | "extract" | "download" | "download_many" | "download_zip" | "thumbnail" | "thumbnail_many" | "tag_update" | "tag_clear" | "convert" | "convert_many" | "remux" | "convert_structure"
  | "create_share" | "create_share_many" | "update_share" | "disable_share" | "rotate_share" | "delete_share" | "share_auth_failed" | "download_via_share" | "download_via_share_many" | "download_zip_via_share" | "upload_via_share" | "upload_via_share_many"
  | "create_task" | "task_start" | "task_failed" | "task_failed_system" | "task_cancel" | "task_pause" | "task_resume" | "task_retry" | "tasks_clear" | "sync" | "sync_test" | "sync_job_create" | "sync_job_update" | "sync_job_delete" | "sync_job_skipped" | "convert_job_create" | "convert_job_update" | "convert_job_delete" | "convert_job_skipped"
  | "sso_update" | "sso_update_off" | "root_create" | "root_update" | "root_delete" | "workspace_update" | "set_wallpaper" | "external_app_create" | "external_app_update" | "external_app_delete"
  | "request_failed" | "request_denied";

export type Sentence = { id: SentenceId; slots: Partial<Record<Slot, string>>; tail: Tail[] };

type Target = Record<string, unknown>;

function targetOf(row: Pick<AuditLog, "target_json">): Target {
  if (!row.target_json) return {};
  try {
    const value: unknown = JSON.parse(row.target_json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Target) : {};
  } catch {
    return {};
  }
}

const text = (target: Target, key: string): string | undefined => (typeof target[key] === "string" && target[key] !== "" ? (target[key] as string).normalize("NFC") : undefined);
const nonEmpty = <T>(value: T | null | undefined | false | ""): value is T => value !== null && value !== undefined && value !== false && value !== "";

const join = (rootName: string | null | undefined, path: string | null | undefined): string | null => {
  const inside = path && path !== "/" ? path.normalize("NFC") : "";
  if (rootName) return `${rootName.normalize("NFC")}${inside}`;
  return inside || null;
};

const rootNameOf = (row: Pick<AuditLog, "root_id" | "root_name">, names: Names): string | null => row.root_name ?? (row.root_id ? (names.roots.get(row.root_id) ?? null) : null);

/** Where a row happened as people read it: under its location's name, the path alone where the location is gone, nothing for neither. */
export const placeOf = (row: Pick<AuditLog, "root_id" | "root_name" | "path">, names: Names): string | null => join(rootNameOf(row, names), row.path);

const slugPlace = (names: Names, slug: string | undefined, path: string | undefined): string | null => (slug === undefined && path === undefined ? null : join(slug === undefined ? null : (names.slugs.get(slug) ?? slug), path));

/** A place given as `{ rootSlug, path }`, which is how copies and conversions say where they put things. */
const placeIn = (names: Names, value: unknown): string | null => (value && typeof value === "object" ? slugPlace(names, text(value as Target, "rootSlug"), text(value as Target, "path")) : null);

/** The folder a place `{ rootSlug, path }` is in: a copy or a move says where it put the item, and what a person asks is which folder. */
const folderIn = (names: Names, value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const path = text(value as Target, "path");
  const slug = text(value as Target, "rootSlug");
  if (path === undefined) return slugPlace(names, slug, undefined);
  const parent = path.split("/").filter(Boolean).slice(0, -1);
  return slugPlace(names, slug, `/${parent.join("/")}`);
};

const baseOf = (path: string | undefined) => (path ? (path.split("/").filter(Boolean).at(-1) ?? path).normalize("NFC") : undefined);

/** What a folder a run touched is called: a folder is `{ root_id, path }`. */
const folderPlace = (folder: AuditBurst["folders"][number], names: Names) => join(folder.root_id ? (names.roots.get(folder.root_id) ?? null) : null, folder.path);

/** Where a run's rows were: the folder when it was one, how many when there were several, nothing when its rows had no path. */
export function foldersTail(burst: AuditBurst, names: Names): Tail | null {
  if (burst.folders.length === 0) return null;
  if (burst.folders.length === 1 && !burst.folders_truncated) return folderPlace(burst.folders[0]!, names);
  return { folders: burst.folders.length, more: burst.folders_truncated };
}

const make = (id: SentenceId, slots: Sentence["slots"] = {}, tail: Array<Tail | null | undefined | false | ""> = []): Sentence => ({ id, slots, tail: tail.filter(nonEmpty) });

type Build = (row: AuditLog, names: Names, target: Target) => Sentence;

/** A sentence that says what happened and, after it, where. */
const at = (id: SentenceId): Build => (row, names) => make(id, {}, [placeOf(row, names)]);
const bare = (id: SentenceId): Build => () => make(id);
/** A file action: where it was, or for a run, the folders it was in. */
const files = (one: SentenceId, many: SentenceId): Build => (row, names) => (row.burst ? make(many, {}, [foldersTail(row.burst, names)]) : make(one, {}, [placeOf(row, names)]));

const personOf = (target: Target, names: Names, key = "userId"): string | undefined => {
  const id = text(target, key);
  return (id ? names.users.get(id) : undefined) ?? text(target, "display_name") ?? text(target, "displayName") ?? text(target, "email");
};
const groupOf = (target: Target, names: Names): string | undefined => {
  const id = text(target, "groupId") ?? text(target, "id");
  return (id ? names.groups.get(id) : undefined) ?? text(target, "name");
};

/** An error code as a few words: `FILE_NOT_FOUND` is "file not found". Anything that is not a code is as it came. */
export const codeWords = (code: string) => (/^[A-Z][A-Z0-9_]+$/.test(code) ? code.toLowerCase().replaceAll("_", " ") : code);

const reasonOf = (target: Target): string | undefined => {
  const reason = text(target, "reason");
  return reason && reason.length <= 120 ? reason : undefined;
};

const sentenceFor: Record<AuditAction, Build> = {
  setup_admin: bare("setup_admin"),
  login_success: (row, _names, target) => make(text(target, "method") === "sso" ? "login_success_sso" : "login_success", {}, [agentShort(row.user_agent)]),
  login_failed: (_row, _names, target) => (text(target, "method") === "sso" ? make("login_failed_sso") : make("login_failed", {}, [text(target, "email")])),
  logout: bare("logout"),
  session_revoked: (_row, names, target) => make("session_revoked", { person: personOf(target, names) }, [reasonOf(target)]),
  admin_recovery: (_row, _names, target) => make(target.created === true ? "admin_recovery_created" : "admin_recovery", {}, [text(target, "email")]),

  password_change: bare("password_change"),
  password_reset: (_row, names, target) => make("password_reset", { person: personOf(target, names) }),
  user_create: (_row, names, target) => make(text(target, "method") === "sso" ? "user_create_sso" : "user_create", { person: personOf(target, names, "id") }),
  user_update: (_row, names, target) => make(target.role === "ADMIN" ? "user_update_admin" : target.role === "USER" ? "user_update_user" : "user_update", { person: personOf(target, names) }),
  user_disable: (_row, names, target) => make(target.disabled === true ? "user_disable" : "user_enable", { person: personOf(target, names) }),
  set_avatar: at("set_avatar"),
  sso_link: (row) => make(row.result === "success" ? "sso_link" : "sso_link_failed"),
  sso_unlink: (row, names, target) => (row.actor_id !== null && text(target, "userId") === row.actor_id ? make("sso_unlink_self") : make("sso_unlink", { person: personOf(target, names) })),

  group_create: (_row, names, target) => make("group_create", { group: groupOf(target, names) }),
  group_rename: (_row, names, target) => make("group_rename", { group: groupOf(target, names) }),
  group_delete: (_row, names, target) => make("group_delete", { group: groupOf(target, names) }),
  group_member_add: (_row, names, target) => make("group_member_add", { person: personOf(target, names), group: groupOf(target, names) }),
  group_member_remove: (_row, names, target) => make("group_member_remove", { person: personOf(target, names), group: groupOf(target, names) }),
  permission_change: (row, names, target) => {
    // A rule is written as the row of the table when it is set, and as its parts when it is taken away.
    const kind = text(target, "principal_type") ?? text(target, "principalType");
    const id = text(target, "principal_id") ?? text(target, "principalId");
    const who = id ? (kind === "group" ? names.groups.get(id) : names.users.get(id)) : undefined;
    const place = rootNameOf(row, names) ?? undefined;
    if (text(target, "note")) return make("permission_dropped", { place }, [row.path && row.path !== "/" ? row.path : null]);
    if (target.deleted === true) return make("permission_remove", { who, place });
    return make(text(target, "level") === "edit" ? "permission_edit" : "permission_view", { who, place });
  },
  permission_denied: (row, names, target) => {
    switch (text(target, "action")) {
      case "admin":
        return make("denied_admin");
      case "shelf_access":
        return make("denied_shelf");
      case "share_access":
        return make("denied_share", {}, [placeOf(row, names)]);
      case "task_access":
        return make("denied_task");
      case "shared_external_app":
        return make("denied_shared_app");
    }
    const level = text(target, "level");
    return make(level === "edit" ? "denied_edit" : level === "view" ? "denied_view" : "denied", {}, [placeOf(row, names)]);
  },

  upload: files("upload", "upload_many"),
  mkdir: files("mkdir", "mkdir_many"),
  rename: (row, names, target) => {
    if (row.burst) return make("rename_many", {}, [foldersTail(row.burst, names)]);
    return make("rename", { path: placeOf(row, names) ?? undefined, to: baseOf(text(target, "to")) });
  },
  edit: files("edit", "edit_many"),
  copy: (row, names, target) => (row.burst ? make("copy_many", {}, [foldersTail(row.burst, names)]) : make("copy", { path: placeOf(row, names) ?? undefined, to: folderIn(names, target) ?? undefined })),
  move: (row, names, target) => (row.burst ? make("move_many", {}, [foldersTail(row.burst, names)]) : make("move", { path: placeOf(row, names) ?? undefined, to: folderIn(names, target) ?? undefined })),
  delete: files("delete", "delete_many"),
  delete_to_trash: files("delete_to_trash", "delete_to_trash_many"),
  restore_trash: files("restore_trash", "restore_trash_many"),
  trash_empty: (row, names, target) => {
    const count = typeof target.count === "number" ? target.count : 0;
    if (row.path) return make("trash_empty_one", {}, [placeOf(row, names)]);
    return count > 1 ? make("trash_empty_many", { count: String(count) }) : make("trash_empty");
  },
  compress: at("compress"),
  extract: at("extract"),
  download: (row, names, target) => {
    if (row.burst) return make("download_many", {}, [foldersTail(row.burst, names)]);
    const sources = Array.isArray(target.sources) ? target.sources : [];
    return row.path || sources.length === 1 ? make("download", {}, [placeOf(row, names) ?? placeIn(names, sources[0])]) : make("download_many");
  },
  download_zip: (_row, names, target) => {
    const sources = Array.isArray(target.sources) ? target.sources : [];
    return make("download_zip", {}, [sources.length === 1 ? placeIn(names, sources[0]) : null]);
  },
  thumbnail: files("thumbnail", "thumbnail_many"),
  tag_update: (row, names, target) => {
    const tags = Array.isArray(target.tags) ? target.tags.filter((tag): tag is string => typeof tag === "string") : [];
    return make(tags.length ? "tag_update" : "tag_clear", {}, [placeOf(row, names), tags.join(", ")]);
  },
  convert: (row, names, target) => (row.burst ? make("convert_many", {}, [foldersTail(row.burst, names)]) : make("convert", { path: placeOf(row, names) ?? undefined, to: baseOf(text(target, "path")) })),
  remux: (row, names, target) => make("remux", { path: placeOf(row, names) ?? undefined, to: baseOf(text(target, "path")) }),
  convert_structure: (row, names, target) => make("convert_structure", { from: placeIn(names, target.from) ?? undefined, to: placeOf(row, names) ?? undefined }),

  create_share: files("create_share", "create_share_many"),
  update_share: at("update_share"),
  disable_share: at("disable_share"),
  rotate_share: at("rotate_share"),
  delete_share: at("delete_share"),
  share_auth_failed: at("share_auth_failed"),
  download_via_share: files("download_via_share", "download_via_share_many"),
  download_zip_via_share: (row, names, target) => make("download_zip_via_share", {}, [placeOf(row, names), typeof target.files === "number" && typeof target.bytes === "number" ? { archive: { files: target.files, bytes: target.bytes } } : null]),
  upload_via_share: files("upload_via_share", "upload_via_share_many"),

  create_task: (_row, _names, target) => make("create_task", {}, [text(target, "type") ? { taskType: text(target, "type")! } : null]),
  task_start: (_row, _names, target) => make("task_start", {}, [text(target, "type") ? { taskType: text(target, "type")! } : null]),
  task_failed: (row, _names, target) => make(row.actor_type === "user" ? "task_failed" : "task_failed_system", {}, [text(target, "type") ? { taskType: text(target, "type")! } : null]),
  task_cancel: bare("task_cancel"),
  task_pause: bare("task_pause"),
  task_resume: bare("task_resume"),
  task_retry: bare("task_retry"),
  tasks_clear: bare("tasks_clear"),
  sync: (row, names, target) => make(target.dryRun === true ? "sync_test" : "sync", {}, [placeOf(row, names)]),
  sync_job_create: (_row, _names, target) => make("sync_job_create", { name: text(target, "name") }),
  sync_job_update: bare("sync_job_update"),
  sync_job_delete: bare("sync_job_delete"),
  sync_job_skipped: (_row, _names, target) => make("sync_job_skipped", {}, [reasonOf(target)]),
  convert_job_create: (_row, _names, target) => make("convert_job_create", { name: text(target, "name") }),
  convert_job_update: bare("convert_job_update"),
  convert_job_delete: bare("convert_job_delete"),
  convert_job_skipped: (_row, _names, target) => make("convert_job_skipped", {}, [reasonOf(target)]),

  sso_update: (_row, _names, target) => make(target.enabled === false ? "sso_update_off" : "sso_update"),
  root_create: (row, names) => make("root_create", {}, [rootNameOf(row, names)]),
  root_update: (row, names) => make("root_update", {}, [rootNameOf(row, names)]),
  root_delete: (_row, _names, target) => make("root_delete", {}, [text(target, "slug")]),
  workspace_update: bare("workspace_update"),
  set_wallpaper: at("set_wallpaper"),
  external_app_create: (_row, _names, target) => make("external_app_create", { name: text(target, "name") }),
  external_app_update: (_row, _names, target) => make("external_app_update", { name: text(target, "name") }),
  external_app_delete: (_row, _names, target) => make("external_app_delete", { name: text(target, "name") }),

  request_failed: bare("request_failed"),
  request_denied: bare("request_denied")
};

/** Every action that has a sentence, which by the type of the table above is every action the contract names. */
export const sentencedActions = Object.keys(sentenceFor) as AuditAction[];

/** The sentence for a row. An action this does not know (one the server has since dropped) is "did something", with its code after it. */
export function describe(row: AuditLog, names: Names): Sentence {
  const build = (sentenceFor as Record<string, Build | undefined>)[row.action];
  return build ? build(row, names, targetOf(row)) : make("unknown", {}, [row.action]);
}

// ---------------------------------------------------------------------------------------------------------------------
// What else a row says when it is opened
// ---------------------------------------------------------------------------------------------------------------------

export type FactLabel = "email" | "path" | "from" | "to" | "sources" | "tags" | "reason" | "request" | "source" | "browser";
export type Fact = { label: FactLabel; value: string };

/** What an opened row has to tell besides the time: where it came from and what it was about, as a person would read it, never the row's JSON. */
export function factsOf(row: AuditLog, names: Names): Fact[] {
  const target = targetOf(row);
  const facts: Fact[] = [];
  const add = (label: FactLabel, value: string | null | undefined) => {
    if (value) facts.push({ label, value });
  };
  add("email", text(target, "email"));
  add("path", placeOf(row, names));
  if (row.action === "rename") add("to", join(rootNameOf(row, names), text(target, "to")));
  else if (row.action === "convert_structure") add("from", placeIn(names, target.from));
  else if (!(row.action === "download" || row.action === "download_zip") && !Array.isArray(target.sources)) add("to", placeIn(names, target));
  if (Array.isArray(target.sources)) {
    const places = target.sources.map((source) => (typeof source === "string" ? source : placeIn(names, source))).filter(nonEmpty);
    if (places.length) add("sources", places.length > 5 ? `${places.slice(0, 5).join(", ")}, +${places.length - 5}` : places.join(", "));
  }
  if (Array.isArray(target.tags)) add("tags", target.tags.filter((tag) => typeof tag === "string").join(", "));
  add("reason", reasonOf(target));
  if (row.action === "request_failed" || row.action === "request_denied") {
    add("reason", text(target, "code") ? codeWords(text(target, "code")!) : undefined);
    add("request", [text(target, "method"), text(target, "route")].filter(Boolean).join(" "));
  }
  add("source", row.ip);
  add("browser", agentText(row.user_agent));
  return facts;
}

/** When a row, or the run it stands for, began and ended; `from` equals `to` for a row that stands alone. */
export const timeSpan = (row: Pick<AuditLog, "created_at" | "burst">) => ({ from: row.burst?.first_at ?? row.created_at, to: row.created_at });
