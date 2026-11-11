import { useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileWarning, PlugZap } from "lucide-react";
import { API_VERSION, MAX_READ_BYTES, parsePluginMessage, THEME_TOKENS, type FailReason, type HostMessage, type PluginMessage, type Theme } from "@kago/plugin-sdk/protocol";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { FileIcon } from "@/components/kago/file-icon";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoWindow } from "@/components/kago/window";
import { Button } from "@/components/ui/button";
import { locale, t } from "@/lib/i18n";
import { triggerDownload } from "@/lib/paths";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { PluginPreviewer } from "@/types/kago";

/** How long a plugin's page has to say hello before the window gives up on it. */
const HELLO_TIMEOUT = 10_000;

/**
 * Where a plugin's frame stands. It says hello once its page has loaded and goes on to show the file, or says it
 * cannot; a page that never says hello, or fails to load, is broken, and only loading it again can change that.
 */
type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; reason: FailReason; message?: string } | { kind: "broken" };
type PhaseEvent = { kind: "hello" } | { kind: "fail"; reason: FailReason; message?: string } | { kind: "broken" };

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
  }
}

/** The theme as the interface has it now, in the tokens a plugin is handed. */
function currentTheme(): Theme {
  const style = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => value));
  return { mode: document.documentElement.dataset.theme === "dark" ? "dark" : "light", tokens };
}

/** Where a plugin keeps what it stores, in Kago's own storage: a sandboxed frame has none. */
const storageKey = (pluginId: string, key: string) => `kago.plugin.${pluginId}.${key}`;

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
  try {
    localStorage.setItem(storageKey(pluginId, key), value);
  } catch {
    // Private browsing, or storage full: the choice lasts as long as the frame.
  }
}

/** A file shown by a plugin, in a frame that can reach nothing but this window. */
export function PluginPreviewWindow({ window, previewer }: { window: PreviewWindow; previewer: PluginPreviewer }) {
  const { rootSlug, item } = window.preview;
  const queryClient = useQueryClient();
  // Counted up to load the plugin afresh.
  const [attempt, setAttempt] = useState(0);
  const download = () => triggerDownload(downloadUrl(rootSlug, item.path));
  const retry = () => {
    // The plugin's address changes when the server restarts, which is one reason a frame stops loading.
    void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    setAttempt((count) => count + 1);
  };

  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={
        <KagoIconButton label={t("Download")} className="size-6" onClick={download}>
          <Download />
        </KagoIconButton>
      }
    >
      {/* Keyed by the file as it is now, so one that is replaced on disk is read again. */}
      <PluginFrame key={`${item.path}:${item.mtime}:${attempt}`} window={window} previewer={previewer} onDownload={download} onRetry={retry} />
    </KagoWindow>
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
    const post = (message: HostMessage, transfer: Transferable[] = []) => frame.current?.contentWindow?.postMessage(message, "*", transfer);
    const reads = new AbortController();

    async function read(id: number, start: number, end: number) {
      const { rootSlug, item } = latest.current.window.preview;
      const stop = Math.min(end, start + MAX_READ_BYTES, item.size);
      if (stop <= start) return post({ kind: "read:ok", id, bytes: new ArrayBuffer(0) });
      try {
        const response = await fetch(previewUrl(rootSlug, item.path), { credentials: "include", headers: { Range: `bytes=${start}-${stop - 1}` }, signal: reads.signal });
        // A server that sends the whole file has still sent the start of it.
        if (response.status !== 206 && !(response.status === 200 && start === 0)) throw new Error(`HTTP ${response.status}`);
        const whole = await response.arrayBuffer();
        const bytes = response.status === 200 ? whole.slice(0, stop) : whole;
        post({ kind: "read:ok", id, bytes }, [bytes]);
      } catch {
        if (!reads.signal.aborted) post({ kind: "read:error", id });
      }
    }

    function handle(message: PluginMessage) {
      const { window, previewer } = latest.current;
      const { item } = window.preview;
      switch (message.kind) {
        case "hello":
          post({ kind: "init", api: API_VERSION, file: { name: item.name, size: item.size, type: item.type, mtime: item.mtime }, locale, theme: currentTheme(), focused: window.focused });
          return dispatch({ kind: "hello" });
        case "read":
          return void read(message.id, message.start, message.end);
        case "fail":
          return dispatch(message);
        case "download":
          return latest.current.onDownload();
        case "storage:get":
          return post({ kind: "storage:value", id: message.id, value: readStorage(previewer.pluginId, message.key) });
        case "storage:set":
          return writeStorage(previewer.pluginId, message.key, message.value);
        case "activate":
          return useWorkspaceStore.getState().focusWindow(window.id);
        case "key":
          // Heard by the interface's shortcuts as if pressed on the page: ⌘K still opens Quick open.
          document.dispatchEvent(new KeyboardEvent("keydown", { key: message.key, code: message.code, metaKey: message.meta, ctrlKey: message.ctrl, shiftKey: message.shift, altKey: message.alt, bubbles: true, cancelable: true }));
          return;
      }
    }

    const onMessage = (event: MessageEvent) => {
      // Only this window's own frame is listened to, and only in the words the protocol has.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = parsePluginMessage(event.data);
      if (message) handle(message);
    };
    globalThis.addEventListener("message", onMessage);
    const silence = setTimeout(() => dispatch({ kind: "broken" }), HELLO_TIMEOUT);
    // The theme can change while the file is open, in Settings or with the system's.
    const themes = new MutationObserver(() => post({ kind: "theme", theme: currentTheme() }));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      globalThis.removeEventListener("message", onMessage);
      clearTimeout(silence);
      themes.disconnect();
      reads.abort();
    };
  }, []);

  // Keys go to the window in front; with the frame focused, they reach the plugin rather than the page around it.
  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ kind: "focus", focused: window.focused } satisfies HostMessage, "*");
    if (window.focused) frame.current?.focus();
  }, [ready, window.focused]);

  if (phase.kind === "failed") {
    return (
      <KagoEmptyState className="min-h-0 flex-1" icon={<FileWarning />} title={t("Couldn’t preview this file")} description={phase.message ?? t("The file may be damaged, or in an unsupported format.")}>
        <Button variant="default" onClick={onDownload}>{t("Download")}</Button>
      </KagoEmptyState>
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
