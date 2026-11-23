import type { FileTask as WireFileTask } from "@kago/contract";
import { t } from "../lib/i18n";
import { parseTask } from "../lib/taskModel";
import type { FileTask } from "../types/kago";
import { dismissToast, toast } from "../stores/toast";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
  }
}

/** The server words its errors in English; they are translated here like the rest of the interface. */
export const serverMessage = (message: unknown) => (typeof message === "string" && message ? t(message) : t("Request failed"));

/** Sent on the page when a request is refused for want of a session, so the desktop can ask to sign in again. */
export const SESSION_ENDED_EVENT = "kago:session-ended";

/** How long a change may go unanswered before the wait is put into words. */
const SLOW_MS = 1000;
const SLOW_KEY = "api:slow";
let slow = 0;

/**
 * Says that the server is still at it for as long as a change it was asked for goes unanswered. What a request
 * does there can take minutes on a hard disk or a remote location, and nothing else on screen need tell of it.
 */
async function whileSlow<T>(work: Promise<T>): Promise<T> {
  let told = false;
  const timer = setTimeout(() => {
    told = true;
    slow += 1;
    toast(t("Still working on it…"), "info", { key: SLOW_KEY, ongoing: true });
  }, SLOW_MS);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    if (told && (slow -= 1) === 0) dismissToast(SLOW_KEY);
  }
}

/** `quiet` is for what is sent behind the user's back, whose wait is not theirs: nothing is said of it however long it takes. */
export function api<T>(path: string, init: RequestInit & { quiet?: boolean } = {}): Promise<T> {
  const { quiet, ...request } = init;
  const sent = send<T>(path, request);
  return quiet || !request.method || request.method === "GET" ? sent : whileSlow(sent);
}

/** Asks for a task, which the server answers with its row. */
export async function apiTask(path: string, init: RequestInit & { quiet?: boolean } = {}): Promise<FileTask> {
  return parseTask(await api<WireFileTask>(path, init));
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      // A JSON content type without a body makes the server reject the request as malformed.
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.method && init.method !== "GET" ? { "x-kago-csrf": "1" } : {}),
      ...init.headers
    }
  }).catch((error: unknown) => {
    // A request called off is not a failure to report. Any other rejection is the network's, worded by the browser in its own language.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(t("Can’t reach the Kago server"), "NETWORK", 0);
  });

  if (!response.ok) throw await refusal(response);

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function refusal(response: Response): Promise<ApiError> {
  const error = await response.json().catch(() => ({ error: response.statusText, code: "REQUEST_FAILED" }));
  if (response.status === 401 && error.code === "AUTH_REQUIRED") window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  // Input turned down names the fields at fault, which the message alone does not.
  const fields = Array.isArray(error.issues) ? [...new Set((error.issues as { path?: unknown[] }[]).map((issue) => issue.path?.join(".")).filter(Boolean))].join(", ") : "";
  return new ApiError(fields ? `${serverMessage(error.error)} (${fields})` : serverMessage(error.error), error.code ?? "REQUEST_FAILED", response.status);
}

/** An answer the server sends a line at a time, each line handed over as it arrives. */
export async function* apiLines<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
  const response = await fetch(path, { credentials: "include", headers: { Accept: "application/x-ndjson" }, signal });
  if (!response.ok) throw await refusal(response);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    const lines = (rest + (value ?? "")).split("\n");
    rest = done ? "" : lines.pop()!;
    for (const line of lines) if (line) yield JSON.parse(line) as T;
    if (done) return;
  }
}

export const downloadUrl = (rootSlug: string, path: string) =>
  `/api/fs/download?${new URLSearchParams({ rootSlug, path }).toString()}`;

/** A folder, or several items of one location, as a single zip written while it downloads. */
export function zipDownloadUrl(rootSlug: string, paths: string[]) {
  const query = new URLSearchParams({ rootSlug });
  for (const path of paths) query.append("path", path);
  return `/api/fs/download-zip?${query.toString()}`;
}

export const taskDownloadUrl = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/download`;

/** The small picture a file's icon shows, or the `medium` one a picture's viewer shows while the picture itself is on its way. */
export const thumbnailUrl = (rootSlug: string, path: string, size?: "medium") =>
  `/api/fs/thumbnail?${new URLSearchParams({ rootSlug, path, ...(size ? { size } : {}) }).toString()}`;

/** A JPEG the server makes from a picture the browser cannot decode. */
export const imageUrl = (rootSlug: string, path: string) => `/api/fs/image?${new URLSearchParams({ rootSlug, path }).toString()}`;

/** An icon of one of the icon libraries, as this server fetched and keeps it. */
export const libraryIconUrl = (source: string, name: string) => `/api/app-icons/${encodeURIComponent(source)}/${encodeURIComponent(name)}`;

export const previewUrl = (rootSlug: string, path: string) =>
  `/api/fs/preview?${new URLSearchParams({ rootSlug, path }).toString()}`;

/** A file's sound from `start` seconds in, re-encoded by the server into something every browser plays. */
export const audioStreamUrl = (rootSlug: string, path: string, start: number) =>
  `/api/media/audio?${new URLSearchParams({ rootSlug, path, start: start.toFixed(3) }).toString()}`;

/** One sheet of the pictures shown over a video's timeline. */
export const storyboardSheetUrl = (rootSlug: string, path: string, index: number, version: number) =>
  `/api/media/storyboard/sheet?${new URLSearchParams({ rootSlug, path, index: String(index), v: String(version) }).toString()}`;

/** The picture kept inside a music file, as a JPEG. `version` tells one state of the file from the next. */
export const embeddedCoverUrl = (rootSlug: string, path: string, version: number) =>
  `/api/media/cover?${new URLSearchParams({ rootSlug, path, v: String(Math.round(version)) }).toString()}`;
