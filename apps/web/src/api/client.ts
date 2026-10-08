import { t } from "../lib/i18n";

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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      // A JSON content type without a body makes the server reject the request as malformed.
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.method && init.method !== "GET" ? { "x-kago-csrf": "1" } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText, code: "REQUEST_FAILED" }));
    throw new ApiError(serverMessage(error.error), error.code ?? "REQUEST_FAILED", response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
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

export const thumbnailUrl = (rootSlug: string, path: string) =>
  `/api/fs/thumbnail?${new URLSearchParams({ rootSlug, path }).toString()}`;

/** A JPEG the server makes from a picture the browser cannot decode. */
export const imageUrl = (rootSlug: string, path: string) => `/api/fs/image?${new URLSearchParams({ rootSlug, path }).toString()}`;

export const previewUrl = (rootSlug: string, path: string) =>
  `/api/fs/preview?${new URLSearchParams({ rootSlug, path }).toString()}`;

/** A file's sound from `start` seconds in, re-encoded by the server into something every browser plays. */
export const audioStreamUrl = (rootSlug: string, path: string, start: number) =>
  `/api/media/audio?${new URLSearchParams({ rootSlug, path, start: start.toFixed(3) }).toString()}`;

/** The picture kept inside a music file, as a JPEG. `version` tells one state of the file from the next. */
export const embeddedCoverUrl = (rootSlug: string, path: string, version: number) =>
  `/api/media/cover?${new URLSearchParams({ rootSlug, path, v: String(Math.round(version)) }).toString()}`;
