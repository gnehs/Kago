import { useEffect, useReducer, useRef, useState } from "react";
import { keys } from "@/api/keys";
import { useQueryClient } from "@tanstack/react-query";
import { FileWarning, PlugZap } from "lucide-react";
import { API_VERSION, MAX_READ_BYTES, parsePluginMessage, THEME_TOKENS, type FailReason, type FileInfo, type HostMessage, type PanoramaInfo, type PanoramaSegment, type PluginMessage, type Theme } from "@kago/plugin-sdk/protocol";
import { api, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { locale, t } from "@/lib/i18n";
import { parentPath } from "@/lib/paths";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { FileMeta, PluginPreviewer } from "@/types/kago";
import { PreviewFailure, PreviewWindowFrame, usePreviewFile } from "@/features/files/PreviewWindowFrame";
import { companionNames } from "./companions";

/** How long a plugin's page has to say hello before the window gives up on it. */
const HELLO_TIMEOUT = 10_000;

/**
 * Where a plugin's frame stands. It says hello once its page has loaded and goes on to show the file, or says it
 * cannot; a page that never says hello, or fails to load, is broken, and only loading it again can change that.
 */
type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; reason: FailReason; message?: string } | { kind: "broken" };
type PhaseEvent = { kind: "hello" } | { kind: "fail"; reason: FailReason; message?: string } | { kind: "broken" } | { kind: "navigated" };

function advance(phase: Phase, event: PhaseEvent): Phase {
  if (phase.kind === "failed" || phase.kind === "broken") return phase;
  switch (event.kind) {
    case "hello":
      return phase.kind === "loading" ? { kind: "ready" } : phase;
    case "fail":
      return { kind: "failed", reason: event.reason, ...(event.message === undefined ? {} : { message: event.message }) };
    case "broken":
      // A plugin that has started is past its loading; only one that never did is broken.
      return phase.kind === "loading" ? { kind: "broken" } : phase;
    case "navigated":
      // The frame holds another page than the one Kago gave it, which is no longer the plugin it was told of.
      return { kind: "broken" };
  }
}

/** The theme as the interface has it now, in the tokens a plugin is handed. */
function currentTheme(): Theme {
  const style = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => value));
  return { mode: document.documentElement.dataset.theme === "dark" ? "dark" : "light", tokens };
}

/** The first `length` bytes of a response, leaving the rest of a file of gigabytes unfetched. */
async function readStart(response: Response, length: number) {
  const bytes = new Uint8Array(length);
  const reader = response.body!.getReader();
  let filled = 0;
  while (filled < length) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, length - filled);
    bytes.set(value.subarray(0, take), filled);
    filled += take;
  }
  void reader.cancel();
  return bytes.buffer.slice(0, filled);
}

type Companion = { path: string; info: FileInfo };

/**
 * The files the previewer's manifest names beside the opened one that are there to read, in the order it names them.
 * Only names made from the opened file's own, in its own folder: the frame never gets to name a file.
 */
async function findCompanions(rootSlug: string, path: string, previewer: PluginPreviewer, signal: AbortSignal): Promise<Companion[]> {
  const folder = parentPath(path);
  const name = path.split("/").at(-1) ?? "";
  const found = await Promise.all(
    companionNames(name, previewer.companions).map(async (other) => {
      const otherPath = `${folder === "/" ? "" : folder}/${other}`;
      try {
        const meta = await api<FileMeta>(`/api/fs/meta?${new URLSearchParams({ rootSlug, path: otherPath }).toString()}`, { signal });
        return meta.kind === "file" ? { path: meta.path, info: { name: meta.name, size: meta.size, type: meta.type, mtime: meta.mtime } } : null;
      } catch {
        // Not there, or not this person's to read: the plugin goes without it.
        return null;
      }
    })
  );
  return found.filter((companion) => companion !== null);
}

/** How many reads a frame may have Kago making at once, and waiting behind those. Past both, a read fails at once. */
const READS_AT_ONCE = 3;
const READS_WAITING = 32;
/** The same for a panorama's segments, each of which can wait most of a minute on the server's encoder. */
const SEGMENTS_AT_ONCE = 2;
const SEGMENTS_WAITING = 8;
type ReadRequest = { id: number; start: number; end: number; file?: number };
type PanoramaSession = PanoramaInfo & { id: string };

/** Runs `atOnce` jobs at a time and keeps up to `waitingMax` in line behind them; past both, a job is refused at once. */
function jobQueue(atOnce: number, waitingMax: number, signal: AbortSignal) {
  let running = 0;
  const waiting: (() => Promise<void>)[] = [];
  const run = (job: () => Promise<void>) => {
    running++;
    void job().finally(() => {
      running--;
      const next = waiting.shift();
      if (next && !signal.aborted) run(next);
    });
  };
  return (job: () => Promise<void>, refuse: () => void) => {
    if (running < atOnce) return run(job);
    if (waiting.length >= waitingMax) return refuse();
    waiting.push(job);
  };
}
/** A frame that asks more often than this is heard once: a click brings its window forward, a download starts once. */
const ACTIVATE_INTERVAL = 100;
const DOWNLOAD_INTERVAL = 2000;

/**
 * Where a plugin keeps what it stores, in Kago's own storage: a sandboxed frame has none. A plugin's id is an npm
 * name, which never has a colon, so no plugin's keys run into another's.
 */
const storagePrefix = (pluginId: string) => `kago.plugin:${pluginId}:`;
const storageKey = (pluginId: string, key: string) => `${storagePrefix(pluginId)}${key}`;
/** The most a plugin keeps, counted in characters across all its keys and values. */
const STORAGE_LIMIT = 256 * 1024;

/** What a plugin stored before it was one, kept under the name the interface gave it then. */
const LEGACY_STORAGE: Record<string, string> = { [storageKey("@kago/plugin-splat-viewer", "speed")]: "kago.splatSpeed" };

function readStorage(pluginId: string, key: string) {
  const name = storageKey(pluginId, key);
  try {
    const value = localStorage.getItem(name);
    const legacy = LEGACY_STORAGE[name];
    if (value !== null || !legacy) return value;
    const old = localStorage.getItem(legacy);
    if (old !== null) {
      localStorage.setItem(name, old);
      localStorage.removeItem(legacy);
    }
    return old;
  } catch {
    return null;
  }
}

function writeStorage(pluginId: string, key: string, value: string) {
  const name = storageKey(pluginId, key);
  try {
    const prefix = storagePrefix(pluginId);
    let used = 0;
    for (let index = 0; index < localStorage.length; index++) {
      const other = localStorage.key(index);
      if (other !== null && other !== name && other.startsWith(prefix)) used += other.length + (localStorage.getItem(other)?.length ?? 0);
    }
    // Over its share, a plugin's choice lasts as long as the frame, as it would with storage full.
    if (used + name.length + value.length > STORAGE_LIMIT) return;
    localStorage.setItem(name, value);
  } catch {
    // Private browsing, or storage full: the choice lasts as long as the frame.
  }
}

/** A file shown by a plugin, in a frame that can reach nothing but this window. */
export function PluginPreviewWindow({ window, previewer }: { window: PreviewWindow; previewer: PluginPreviewer }) {
  const { version, download } = usePreviewFile(window);
  const queryClient = useQueryClient();
  // Counted up to load the plugin afresh.
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    // The plugin's address changes when the server restarts, which is one reason a frame stops loading.
    void queryClient.invalidateQueries({ queryKey: keys.plugins() });
    setAttempt((count) => count + 1);
  };

  return (
    <PreviewWindowFrame window={window}>
      {/* Keyed by the file as it is now, so one that is replaced on disk is read again, and by the page, so a frame only
          ever loads the one it was given: one that loads another page is taken to have left (see PluginFrame). */}
      <PluginFrame key={`${version}:${previewer.src}:${attempt}`} window={window} previewer={previewer} onDownload={download} onRetry={retry} />
    </PreviewWindowFrame>
  );
}

function PluginFrame({ window, previewer, onDownload, onRetry }: { window: PreviewWindow; previewer: PluginPreviewer; onDownload: () => void; onRetry: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, dispatch] = useReducer(advance, { kind: "loading" });
  // The frame is remounted for another file (see the key above), so what it is about is read as it is now.
  const latest = useRef({ window, previewer, onDownload });
  latest.current = { window, previewer, onDownload };
  const ready = phase.kind === "ready";

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // A sandboxed frame's origin is opaque, and no target origin but "*" reaches one.
    const post = (message: HostMessage, transfer: Transferable[] = []) => element.contentWindow?.postMessage(message, "*", transfer);
    const reads = new AbortController();
    const readQueue = jobQueue(READS_AT_ONCE, READS_WAITING, reads.signal);
    const segmentQueue = jobQueue(SEGMENTS_AT_ONCE, SEGMENTS_WAITING, reads.signal);
    let companions: Companion[] = [];
    let panorama: Promise<PanoramaSession> | null = null;
    let said = false;
    let lastActivate = -Infinity;
    let lastDownload = -Infinity;

    async function read({ id, start, end, file = 0 }: ReadRequest) {
      const { rootSlug, item } = latest.current.window.preview;
      const companion = companions[file - 1];
      const target = file === 0 ? { path: item.path, size: item.size } : companion && { path: companion.path, size: companion.info.size };
      if (!target) return post({ kind: "read:error", id });
      const stop = Math.min(end, start + MAX_READ_BYTES, target.size);
      if (stop <= start) return post({ kind: "read:ok", id, bytes: new ArrayBuffer(0) });
      try {
        // Not kept: with part of a file cached, the browser asks again with If-Range on the server's weak ETag, which
        // can never match, so the server sends the whole file instead of the range.
        const response = await fetch(previewUrl(rootSlug, target.path), { credentials: "include", cache: "no-store", headers: { Range: `bytes=${start}-${stop - 1}` }, signal: reads.signal });
        // A server that sends the whole file has still sent the start of it.
        if (response.status !== 206 && !(response.status === 200 && start === 0)) {
          void response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = response.status === 200 ? await readStart(response, stop) : await response.arrayBuffer();
        if (!reads.signal.aborted) post({ kind: "read:ok", id, bytes }, [bytes]);
      } catch {
        if (!reads.signal.aborted) post({ kind: "read:error", id });
      }
    }

    /** The one panorama this frame has, made on its first asking. Only the opened file and its companions go into it. */
    function openPanorama() {
      if (!panorama) {
        const { rootSlug, item } = latest.current.window.preview;
        panorama = api<PanoramaSession>("/api/media/panoramas", {
          method: "POST",
          body: JSON.stringify({ rootSlug, path: item.path, companionPath: companions[0]?.path ?? null }),
          // The viewer shows its own spinner while the server starts.
          quiet: true
        });
        // A panorama that could not be made may be asked for again.
        panorama.catch(() => (panorama = null));
      }
      return panorama;
    }

    async function panoramaInfo(id: number) {
      try {
        const { duration, segmentSeconds, segmentCount } = await openPanorama();
        if (!reads.signal.aborted) post({ kind: "panorama:info", id, duration, segmentSeconds, segmentCount });
      } catch {
        if (!reads.signal.aborted) post({ kind: "panorama:error", id });
      }
    }

    async function panoramaSegment(id: number, segment: PanoramaSegment) {
      try {
        const session = await openPanorama();
        if (segment !== "init" && segment >= session.segmentCount) throw new Error("no such segment");
        const name = segment === "init" ? "init.mp4" : `${segment}.m4s`;
        const response = await fetch(`/api/media/sessions/${encodeURIComponent(session.id)}/${name}`, { credentials: "include", cache: "no-store", signal: reads.signal });
        if (!response.ok) {
          void response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        if (!reads.signal.aborted) post({ kind: "panorama:bytes", id, bytes }, [bytes]);
      } catch {
        if (!reads.signal.aborted) post({ kind: "panorama:error", id });
      }
    }

    function handle(message: PluginMessage) {
      const { window, previewer } = latest.current;
      const { item } = window.preview;
      switch (message.kind) {
        case "hello":
          // A page says hello once. Another is a second page in the frame, heard before it has finished loading.
          if (said) return leave();
          said = true;
          void findCompanions(window.preview.rootSlug, item.path, previewer, reads.signal).then((found) => {
            if (reads.signal.aborted) return;
            companions = found;
            const { window } = latest.current;
            post({ kind: "init", api: API_VERSION, file: { name: item.name, size: item.size, type: item.type, mtime: item.mtime }, companions: found.map((companion) => companion.info), locale, theme: currentTheme(), focused: window.focused });
            dispatch({ kind: "hello" });
          });
          return;
        // A frame cannot have Kago fetch without end: a few at a time, a line of them behind, and no more.
        case "read":
          return readQueue(
            () => read(message),
            () => post({ kind: "read:error", id: message.id })
          );
        case "panorama:open":
          // Only a previewer that said it would ask: each panorama keeps an encoder on the server busy.
          if (!previewer.panorama) return post({ kind: "panorama:error", id: message.id });
          return void panoramaInfo(message.id);
        case "panorama:segment":
          if (!previewer.panorama) return post({ kind: "panorama:error", id: message.id });
          return segmentQueue(
            () => panoramaSegment(message.id, message.segment),
            () => post({ kind: "panorama:error", id: message.id })
          );
        case "fail":
          return dispatch(message);
        case "download":
          if (performance.now() - lastDownload < DOWNLOAD_INTERVAL) return;
          lastDownload = performance.now();
          return latest.current.onDownload();
        case "storage:get":
          return post({ kind: "storage:value", id: message.id, value: readStorage(previewer.pluginId, message.key) });
        case "storage:set":
          return writeStorage(previewer.pluginId, message.key, message.value);
        case "activate":
          if (performance.now() - lastActivate < ACTIVATE_INTERVAL) return;
          lastActivate = performance.now();
          return useWorkspaceStore.getState().focusWindow(window.id);
        case "key":
          // Only a key pressed in the frame while it has the focus, in the window in front: a frame in a window behind
          // has no keys to pass on, and would otherwise be pressing them in whatever window is in front.
          if (!window.focused || document.activeElement !== element) return;
          // Heard by the interface's shortcuts as if pressed on the page: ⌘K still opens Quick open.
          document.dispatchEvent(new KeyboardEvent("keydown", { key: message.key, code: message.code, metaKey: message.meta, ctrlKey: message.ctrl, shiftKey: message.shift, altKey: message.alt, bubbles: true, cancelable: true }));
          return;
      }
    }

    const onMessage = (event: MessageEvent) => {
      // Only this window's own frame is listened to, still sandboxed, and only in the words the protocol has.
      if (event.source !== element.contentWindow || event.origin !== "null") return;
      const message = parsePluginMessage(event.data);
      if (message) handle(message);
    };
    const silence = setTimeout(() => dispatch({ kind: "broken" }), HELLO_TIMEOUT);
    // The theme can change while the file is open, in Settings or with the system's.
    const themes = new MutationObserver(() => post({ kind: "theme", theme: currentTheme() }));
    const stop = () => {
      globalThis.removeEventListener("message", onMessage);
      element.removeEventListener("load", onLoad);
      clearTimeout(silence);
      themes.disconnect();
      reads.abort();
      // The encoder stops with the window, not a quarter of an hour later when the server would give up on it.
      void panorama?.then((session) => api(`/api/media/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE", keepalive: true, quiet: true })).catch(() => undefined);
      panorama = null;
    };
    // The frame is given its page once, and a new frame is made for any other (see the key on PluginFrame). So a
    // second load is the plugin sending its frame somewhere itself. The window is still the same, so it would be
    // heard as before; it is not, and Kago says the viewer stopped.
    let loads = 0;
    function onLoad() {
      if (++loads > 1) leave();
    }
    function leave() {
      stop();
      dispatch({ kind: "navigated" });
    }
    globalThis.addEventListener("message", onMessage);
    element.addEventListener("load", onLoad);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return stop;
  }, []);

  // Keys go to the window in front; with the frame focused, they reach the plugin rather than the page around it.
  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ kind: "focus", focused: window.focused } satisfies HostMessage, "*");
    if (window.focused) frame.current?.focus();
  }, [ready, window.focused]);

  if (phase.kind === "failed") {
    return (
      <PreviewFailure className="min-h-0 flex-1" icon={<FileWarning />} title={t("Couldn’t preview this file")} description={phase.message ?? t("The file may be damaged, or in an unsupported format.")} onDownload={onDownload} />
    );
  }
  if (phase.kind === "broken") {
    return (
      <KagoEmptyState className="min-h-0 flex-1" icon={<PlugZap />} title={t("The viewer didn’t start")} description={t("{name} didn’t load, or stopped answering.", { name: previewer.title })}>
        <Button variant="default" onClick={onRetry}>{t("Retry")}</Button>
        <Button onClick={onDownload}>{t("Download")}</Button>
      </KagoEmptyState>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        ref={frame}
        title={previewer.title}
        // Scripts only: no origin of its own to share with Kago's, no forms, no popups, no way out of the frame.
        sandbox="allow-scripts"
        // The viewer inside may take its own frame fullscreen; a frame cannot unless it is allowed to.
        allow="fullscreen"
        // The page is told whose it is, so its policy can name its own address as the browser sees it.
        src={`${previewer.src}?${new URLSearchParams({ _o: location.origin }).toString()}`}
        referrerPolicy="no-referrer"
        className="block min-h-0 flex-1 border-0"
        onError={() => dispatch({ kind: "broken" })}
      />
      {ready ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-surface">
          <KagoLoading />
        </div>
      )}
    </div>
  );
}
