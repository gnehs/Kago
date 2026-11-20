import { create } from "zustand";
import { ApiError, serverMessage } from "@/api/client";
import { t } from "@/lib/i18n";

export type Upload = {
  id: number;
  label: string;
  /** How many files it carries in all, and how many of them have gone across. */
  files: number;
  done: number;
  loaded: number;
  total: number;
  /** Bytes per second over the last few seconds; 0 until there is enough data. */
  speed: number;
  cancel: () => void;
};

export const UPLOAD_CANCELLED = "UPLOAD_CANCELLED";

/** Speed is averaged over this window so the remaining time does not jump around. */
const speedWindowMs = 4000;
const updateIntervalMs = 250;

let nextId = 1;

export const useUploadStore = create<{ uploads: Upload[] }>(() => ({ uploads: [] }));

/** Closing or reloading the tab drops every upload under way, so the browser asks first while there are any. */
const holdPage = (event: BeforeUnloadEvent) => event.preventDefault();
useUploadStore.subscribe((state, previous) => {
  if (state.uploads.length > 0 && previous.uploads.length === 0) window.addEventListener("beforeunload", holdPage);
  else if (state.uploads.length === 0 && previous.uploads.length > 0) window.removeEventListener("beforeunload", holdPage);
});

/** All the uploads under way taken as one: how much of it has gone, and how fast the rest is going. */
export function uploadsTotal(uploads: Upload[]) {
  let loaded = 0;
  let total = 0;
  let speed = 0;
  let files = 0;
  for (const upload of uploads) {
    files += upload.files;
    loaded += upload.loaded;
    total += upload.total;
    speed += upload.speed;
  }
  return { files, loaded, total, speed, sent: total > 0 && loaded >= total, remaining: speed > 0 ? (total - loaded) / speed : null };
}

const patch = (id: number, changes: Partial<Upload>) =>
  useUploadStore.setState((state) => ({ uploads: state.uploads.map((upload) => (upload.id === id ? { ...upload, ...changes } : upload)) }));

/** One upload as the person sees it, however many requests carry it. Its requests report into it one after another. */
export type UploadJob = {
  /** POSTs a form like `api()` does, but through XHR because fetch cannot report upload progress. */
  send<T>(path: string, form: FormData): Promise<T>;
  /** Takes the upload off the list, whether it went through or not. */
  end(): void;
};

export function startUpload({ label, files, total, done = 0, loaded = 0 }: { label: string; files: number; total: number; done?: number; loaded?: number }): UploadJob {
  const id = nextId++;
  /** Bytes and files of the requests that have gone through. */
  let base = loaded;
  let sentFiles = done;
  let current: XMLHttpRequest | null = null;
  let cancelled = false;
  const samples: Array<{ time: number; loaded: number }> = [{ time: performance.now(), loaded: base }];
  let lastUpdate = 0;

  const cancel = () => {
    cancelled = true;
    current?.abort();
  };
  useUploadStore.setState((state) => ({ uploads: [...state.uploads, { id, label, files, done: sentFiles, loaded: base, total, speed: 0, cancel }] }));

  const send = <T>(path: string, form: FormData) =>
    new Promise<T>((resolve, reject) => {
      if (cancelled) {
        reject(new ApiError(t("Upload cancelled"), UPLOAD_CANCELLED, 0));
        return;
      }
      let bytes = 0;
      let count = 0;
      for (const value of form.values()) {
        if (!(value instanceof File)) continue;
        bytes += value.size;
        count += 1;
      }
      const xhr = new XMLHttpRequest();
      current = xhr;
      const fail = (error: ApiError) => {
        current = null;
        reject(error);
      };

      xhr.upload.onprogress = (event) => {
        const now = performance.now();
        // The request carries a little more than its files; what counts is the files' share of it.
        const sent = base + (event.lengthComputable && event.total > 0 ? Math.min(bytes, (event.loaded / event.total) * bytes) : Math.min(bytes, event.loaded));
        samples.push({ time: now, loaded: sent });
        while (samples.length > 2 && now - samples[0]!.time > speedWindowMs) samples.shift();
        const last = event.lengthComputable && event.loaded >= event.total;
        if (!last && now - lastUpdate < updateIntervalMs) return;
        lastUpdate = now;
        const first = samples[0]!;
        const elapsed = (now - first.time) / 1000;
        patch(id, { loaded: sent, speed: elapsed > 0 ? (sent - first.loaded) / elapsed : 0 });
      };
      xhr.onload = () => {
        let body: { error?: string; code?: string } | undefined;
        try {
          body = xhr.status === 204 ? undefined : JSON.parse(xhr.responseText);
        } catch {
          body = undefined;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(new ApiError(serverMessage(body?.error ?? xhr.statusText), body?.code ?? "REQUEST_FAILED", xhr.status));
          return;
        }
        current = null;
        base += bytes;
        sentFiles += count;
        patch(id, { loaded: base, done: sentFiles });
        resolve(body as T);
      };
      xhr.onerror = () => fail(new ApiError(t("The network connection was lost"), "NETWORK_ERROR", 0));
      xhr.onabort = () => fail(new ApiError(t("Upload cancelled"), UPLOAD_CANCELLED, 0));

      xhr.open("POST", path);
      xhr.withCredentials = true;
      xhr.setRequestHeader("x-kago-csrf", "1");
      xhr.send(form);
    });

  return { send, end: () => useUploadStore.setState((state) => ({ uploads: state.uploads.filter((upload) => upload.id !== id) })) };
}

/** A single request as an upload of its own. */
export async function uploadForm<T>(path: string, form: FormData, label: string): Promise<T> {
  let total = 0;
  let files = 0;
  for (const value of form.values()) {
    if (!(value instanceof File)) continue;
    total += value.size;
    files += 1;
  }
  const job = startUpload({ label, files, total });
  try {
    return await job.send<T>(path, form);
  } finally {
    job.end();
  }
}

export const uploadLabel = (files: ArrayLike<File>) => (files.length === 1 ? files[0]!.name : t("{count} file | {count} files", { count: files.length }));

export const isUploadCancelled = (error: unknown) => error instanceof ApiError && error.code === UPLOAD_CANCELLED;
