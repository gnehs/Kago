import type { ShareLink } from "../types/kago";

/*
 * What the Shares window and the info panel know about a link without asking anyone: whether it works, why not,
 * when it ends, which list it belongs in. The words are chosen by the components, which hold the translations;
 * this file only says which of them apply and with what numbers, so that node can test it.
 */

export type ShareMode = "download" | "view_only" | "upload_only";

export function parseShareMode(permissionJson: string): ShareMode {
  try {
    const mode = (JSON.parse(permissionJson) as { mode?: unknown }).mode;
    if (mode === "view_only" || mode === "upload_only") return mode;
  } catch {
    // Fall through to the default mode.
  }
  return "download";
}

export type ShareState = "disabled" | "expired" | "limit" | "active";

/** What a link is doing right now, as the server judges it when the link is opened. */
export function shareState(share: ShareLink, nowSeconds = Math.floor(Date.now() / 1000)): ShareState {
  if (share.disabled) return "disabled";
  if (share.expires_at && share.expires_at < nowSeconds) return "expired";
  if (share.max_downloads && share.download_count >= share.max_downloads) return "limit";
  return "active";
}

/** A stretch of time in the one unit it reads best in: minutes under an hour, hours under a day, days after that. */
export type Span = { unit: "minute" | "hour" | "day"; amount: number };

export function spanOf(seconds: number): Span {
  const total = Math.abs(seconds);
  if (total < 3600) return { unit: "minute", amount: Math.max(1, Math.ceil(total / 60)) };
  if (total < 86400) return { unit: "hour", amount: Math.min(23, Math.max(1, Math.round(total / 3600))) };
  return { unit: "day", amount: Math.max(1, Math.round(total / 86400)) };
}

/** When a link ends. `soon` is under a day away, which is when the list says so in the warning colour. */
export type ShareExpiry = { kind: "never" } | { kind: "in"; span: Span; soon: boolean } | { kind: "ago"; span: Span };

export function shareExpiry(share: Pick<ShareLink, "expires_at">, nowSeconds = Math.floor(Date.now() / 1000)): ShareExpiry {
  if (!share.expires_at) return { kind: "never" };
  const left = share.expires_at - nowSeconds;
  return left < 0 ? { kind: "ago", span: spanOf(left) } : { kind: "in", span: spanOf(left), soon: left < 86400 };
}

/** Why a link that no longer works has stopped; null for one that works. */
export type ShareEnd = { state: "expired"; span: Span } | { state: "limit"; used: number; max: number } | { state: "disabled" };

export function shareEnd(share: ShareLink, nowSeconds = Math.floor(Date.now() / 1000)): ShareEnd | null {
  const state = shareState(share, nowSeconds);
  if (state === "active") return null;
  if (state === "disabled") return { state };
  if (state === "expired") return { state, span: spanOf(nowSeconds - share.expires_at!) };
  return { state, used: share.download_count, max: share.max_downloads! };
}

/** The one number about downloads worth showing: how much of a limit is used, or how many there have been. Upload-only has no downloads. */
export type ShareFigure = { kind: "limit"; used: number; max: number } | { kind: "count"; count: number };

export function shareFigure(share: Pick<ShareLink, "permission_json" | "max_downloads" | "download_count">): ShareFigure | null {
  if (parseShareMode(share.permission_json) === "upload_only") return null;
  if (share.max_downloads) return { kind: "limit", used: share.download_count, max: share.max_downloads };
  return share.download_count > 0 ? { kind: "count", count: share.download_count } : null;
}

const lastSegment = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

/** What the link is named in the list: the item's name, or the location's own where the whole location is shared. */
export const shareName = (share: Pick<ShareLink, "path">, rootName: string) => (lastSegment(share.path) || rootName).normalize("NFC");

/** Every link of a window with a share to a file is a file and every upload-only one a folder: the server refuses any other pair. */
export const shareIsFolder = (share: Pick<ShareLink, "permission_json">) => parseShareMode(share.permission_json) === "upload_only";

export const shareUrl = (origin: string, token: string) => `${origin}/s/${token}`;

/** The links of a list in two groups, those that work and those that do not, each newest first, with the ones whose name has no part of `query` left out. */
export function groupShares(shares: readonly ShareLink[], rootName: (rootId: string) => string, query: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const needle = query.trim().normalize("NFC").toLowerCase();
  const active: ShareLink[] = [];
  const dead: ShareLink[] = [];
  for (const share of [...shares].sort((a, b) => b.created_at - a.created_at)) {
    if (needle && !shareName(share, rootName(share.root_id)).toLowerCase().includes(needle)) continue;
    (shareState(share, nowSeconds) === "active" ? active : dead).push(share);
  }
  return { active, dead };
}

export type ExpiryChoice = "1" | "7" | "30" | "never" | "custom";

/** The moment a choice of validity ends, in seconds; or why it cannot be used. `customAt` is the date picked under "Custom…", if any. */
export function resolveExpiry(choice: ExpiryChoice, customAt: number | null, nowSeconds = Math.floor(Date.now() / 1000)): { at: number | null } | { problem: "missing" | "past" } {
  if (choice === "never") return { at: null };
  if (choice !== "custom") return { at: nowSeconds + Number(choice) * 86400 };
  if (customAt === null) return { problem: "missing" };
  return customAt <= nowSeconds ? { problem: "past" } : { at: customAt };
}

/** A download limit as typed: a whole number of one or more, or nothing. */
export function parseDownloadLimit(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export const MIN_SHARE_PASSWORD = 8;

/** Why the form cannot be sent yet, in the order it is easiest to fix; null when it can. */
export type ShareProblem = "no-item" | "file-needs-folder" | "folder-needs-file" | "readonly-drop-box" | "password-short" | "limit-invalid" | "expiry-missing" | "expiry-past";

export function shareProblem(draft: { item: { kind: "file" | "folder"; /** It lies in a location that cannot be written to. */ readonly?: boolean } | null; mode: ShareMode; /** Null when no password is asked for. */ password: string | null; /** Null when downloads are not limited. */ limit: string | null; expiry: ReturnType<typeof resolveExpiry> }): ShareProblem | null {
  if (!draft.item) return "no-item";
  if (draft.mode === "upload_only" && draft.item.kind === "file") return "file-needs-folder";
  if (draft.mode !== "upload_only" && draft.item.kind === "folder") return "folder-needs-file";
  if (draft.mode === "upload_only" && draft.item.readonly) return "readonly-drop-box";
  if (draft.password !== null && draft.password.length < MIN_SHARE_PASSWORD) return "password-short";
  if (draft.limit !== null && parseDownloadLimit(draft.limit) === null) return "limit-invalid";
  if ("problem" in draft.expiry) return draft.expiry.problem === "missing" ? "expiry-missing" : "expiry-past";
  return null;
}
