import type { AuditAction, AuditCategory, AuditSignal } from "@kago/contract";

type Class = { category: AuditCategory; signal: AuditSignal };
const normal = (category: AuditCategory): Class => ({ category, signal: "normal" });
const low = (category: AuditCategory): Class => ({ category, signal: "low" });

/**
 * What every action is, and whether it is worth an admin's first look. The type of `AuditInput.action` is the union
 * `AuditAction`, which this must cover to the last member and may not exceed, so an action cannot be written without
 * having been placed here. The contract package holds types only (the server is compiled apart from it), so the
 * union is there and the table is here.
 */
export const auditActions = {
  setup_admin: normal("sign_in"),
  login_success: normal("sign_in"),
  login_failed: normal("sign_in"),
  logout: low("sign_in"),
  session_revoked: normal("sign_in"),
  admin_recovery: normal("sign_in"),

  password_change: normal("account"),
  password_reset: normal("account"),
  user_create: normal("account"),
  user_update: normal("account"),
  user_disable: normal("account"),
  set_avatar: low("account"),
  sso_link: normal("account"),
  sso_unlink: normal("account"),

  group_create: normal("permission"),
  group_rename: normal("permission"),
  group_delete: normal("permission"),
  group_member_add: normal("permission"),
  group_member_remove: normal("permission"),
  permission_change: normal("permission"),
  permission_denied: normal("permission"),

  upload: normal("file"),
  mkdir: normal("file"),
  rename: normal("file"),
  edit: normal("file"),
  copy: normal("file"),
  move: normal("file"),
  delete: normal("file"),
  delete_to_trash: normal("file"),
  restore_trash: normal("file"),
  trash_empty: normal("file"),
  compress: normal("file"),
  extract: normal("file"),
  download: normal("file"),
  download_zip: normal("file"),
  thumbnail: low("file"),
  tag_update: low("file"),
  convert: normal("file"),
  remux: normal("file"),
  convert_structure: normal("file"),

  create_share: normal("share"),
  update_share: normal("share"),
  disable_share: normal("share"),
  rotate_share: normal("share"),
  delete_share: normal("share"),
  share_auth_failed: normal("share"),
  download_via_share: normal("share"),
  download_zip_via_share: normal("share"),
  upload_via_share: normal("share"),

  create_task: low("task"),
  task_start: low("task"),
  task_failed: normal("task"),
  task_cancel: low("task"),
  task_pause: low("task"),
  task_resume: low("task"),
  task_retry: low("task"),
  tasks_clear: low("task"),
  sync: normal("task"),
  sync_job_create: normal("task"),
  sync_job_update: normal("task"),
  sync_job_delete: normal("task"),
  sync_job_skipped: normal("task"),
  convert_job_create: normal("task"),
  convert_job_update: normal("task"),
  convert_job_delete: normal("task"),
  convert_job_skipped: normal("task"),

  sso_update: normal("settings"),
  root_create: normal("settings"),
  root_update: normal("settings"),
  root_delete: normal("settings"),
  workspace_update: low("settings"),
  set_wallpaper: low("settings"),
  external_app_create: normal("settings"),
  external_app_update: normal("settings"),
  external_app_delete: normal("settings"),

  request_failed: normal("system"),
  request_denied: normal("system")
} satisfies Record<AuditAction, Class>;

/**
 * Actions the server no longer writes. They stay in the table and in `AuditAction` so the rows already in someone's log
 * keep their class; the test holds both ways: a retired action is written nowhere, a live one somewhere.
 */
export const retiredActions: ReadonlySet<AuditAction> = new Set<AuditAction>(["thumbnail"]);

const categoryKeys: Record<AuditCategory, true> = { sign_in: true, account: true, permission: true, file: true, share: true, task: true, settings: true, system: true };
export const auditCategories = Object.keys(categoryKeys) as [AuditCategory, ...AuditCategory[]];

/**
 * A refused request is as loud as the thing it asked for: a denied delete is news, a denied thumbnail is a folder
 * someone has no right to open being drawn picture by picture. These are the routes whose refusals are the second kind.
 */
const LOW_SIGNAL_ROUTES = [
  "/api/fs/thumbnail",
  "/api/fs/image",
  "/api/fs/exif",
  "/api/fs/preview",
  "/api/media/",
  "/api/app-icons",
  "/api/external-apps/:id/icon",
  "/api/users/:id/avatar",
  "/api/wallpaper",
  "/api/internal/blob/"
];

/**
 * Rows of an action since removed keep their name; they read as ordinary system rows. A request that failed says
 * nothing of what was wanted, and what an admin would act on has a row of its own (a failed sign-in, a refusal), so it
 * is quiet unless the fault was the server's.
 */
export function classify(action: string, target?: unknown): Class {
  const known = (auditActions as Record<string, Class | undefined>)[action];
  if (!known) return normal("system");
  if (action === "request_failed" || action === "request_denied") {
    const { route, statusCode } = (target && typeof target === "object" ? target : {}) as { route?: unknown; statusCode?: unknown };
    if (typeof route === "string" && LOW_SIGNAL_ROUTES.some((prefix) => route.startsWith(prefix))) return low(known.category);
    if (action === "request_failed" && !(typeof statusCode === "number" && statusCode >= 500)) return low(known.category);
  }
  return known;
}

/** Stands for the table and the routes, so that a startup can tell when the rows already written are classed by an older one. */
export const classificationKey = JSON.stringify([auditActions, LOW_SIGNAL_ROUTES, "request_failed is quiet below 500"]);
