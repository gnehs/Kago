import { create } from "zustand";
import { ApiError, serverMessage } from "@/api/client";
import { t } from "@/lib/i18n";

export type Upload = {
  id: number;
  label: string;
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

const patch = (id: number, changes: Partial<Upload>) =>
  useUploadStore.setState((state) => ({ uploads: state.uploads.map((upload) => (upload.id === id ? { ...upload, ...changes } : upload)) }));

/** POSTs a form like `api()` does, but through XHR because fetch cannot report upload progress. */
export function uploadForm<T>(path: string, form: FormData, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const xhr = new XMLHttpRequest();
    const samples: Array<{ time: number; loaded: number }> = [{ time: performance.now(), loaded: 0 }];
    let lastUpdate = 0;

    const finish = () => useUploadStore.setState((state) => ({ uploads: state.uploads.filter((upload) => upload.id !== id) }));
    const fail = (error: ApiError) => {
      finish();
      reject(error);
    };

    xhr.upload.onprogress = (event) => {
      const now = performance.now();
      samples.push({ time: now, loaded: event.loaded });
      while (samples.length > 2 && now - samples[0]!.time > speedWindowMs) samples.shift();
      const done = event.lengthComputable && event.loaded >= event.total;
      if (!done && now - lastUpdate < updateIntervalMs) return;
      lastUpdate = now;
      const first = samples[0]!;
      const elapsed = (now - first.time) / 1000;
      patch(id, {
        loaded: event.loaded,
        ...(event.lengthComputable ? { total: event.total } : {}),
        speed: elapsed > 0 ? (event.loaded - first.loaded) / elapsed : 0
      });
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
      finish();
      resolve(body as T);
    };
    xhr.onerror = () => fail(new ApiError(t("The network connection was lost"), "NETWORK_ERROR", 0));
    xhr.onabort = () => fail(new ApiError(t("Upload cancelled"), UPLOAD_CANCELLED, 0));

    let total = 0;
    for (const value of form.values()) if (value instanceof File) total += value.size;
    useUploadStore.setState((state) => ({ uploads: [...state.uploads, { id, label, loaded: 0, total, speed: 0, cancel: () => xhr.abort() }] }));

    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-kago-csrf", "1");
    xhr.send(form);
  });
}

export const uploadLabel = (files: ArrayLike<File>) => (files.length === 1 ? files[0]!.name : t("{count} file | {count} files", { count: files.length }));

export const isUploadCancelled = (error: unknown) => error instanceof ApiError && error.code === UPLOAD_CANCELLED;
