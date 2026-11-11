import { API_VERSION, isForwardedKey, MAX_READ_BYTES, parseHostMessage, type FailReason, type FileInfo, type HostMessage, type PluginMessage, type Theme } from "./protocol";

export type { FailReason, FileInfo, Theme, ThemeMode } from "./protocol";
export { MAX_READ_BYTES } from "./protocol";

export type Kago = {
  /** The file the plugin was opened on. */
  file: FileInfo;
  /** The language of Kago's interface, as a BCP 47 tag such as `en` or `zh-TW`. */
  locale: string;
  theme: Theme;
  /** Whether the window the plugin is in is the one in front, which is the one keys are meant for. */
  focused: boolean;
  /** The file's bytes from `start` up to, not including, `end`. Kago hands back at most `MAX_READ_BYTES` at a time. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** The whole file, read range after range, so a consumer can tell how far it has got. */
  stream(): ReadableStream<Uint8Array>;
  /** Leaves the file to Kago, which says it could not be previewed and offers to download it. */
  fail(reason: FailReason, message?: string): void;
  download(): void;
  /** A few strings the plugin keeps between openings; the frame has no storage of its own. */
  storage: { get(key: string): Promise<string | null>; set(key: string, value: string): void };
  onFocus(listener: (focused: boolean) => void): () => void;
  onTheme(listener: (theme: Theme) => void): () => void;
};

const MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift"]);

type Pending = { resolve: (message: HostMessage) => void; reject: () => void };

/**
 * Says hello to Kago and waits to be told what file this is. Everything a plugin does with Kago goes through what
 * this returns. It also applies Kago's theme to the page, tells Kago of clicks inside the frame so the window comes
 * forward, and passes on the shortcuts Kago answers to, which a focused frame would otherwise keep to itself. A key
 * the plugin answers itself is kept from Kago by calling preventDefault on it.
 */
export function connect(): Promise<Kago> {
  const host = window.parent;
  // Kago names its own address in the frame's; messages go only there. Kago's to the frame come from its window.
  const origin = new URLSearchParams(location.search).get("_o") ?? "*";
  const post = (message: PluginMessage) => host.postMessage(message, origin);
  const pending = new Map<number, Pending>();
  const focusListeners = new Set<(focused: boolean) => void>();
  const themeListeners = new Set<(theme: Theme) => void>();
  let nextId = 0;
  let kago: Kago | null = null;

  const ask = (message: (id: number) => PluginMessage) =>
    new Promise<HostMessage>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject: () => reject(new Error("Kago could not read the file")) });
      post(message(id));
    });

  async function read(start: number, end: number) {
    const reply = await ask((id) => ({ kind: "read", id, start, end }));
    return reply.kind === "read:ok" ? new Uint8Array(reply.bytes) : new Uint8Array();
  }

  return new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.source !== host) return;
      const message = parseHostMessage(event.data);
      if (!message) return;
      switch (message.kind) {
        case "init": {
          if (kago) return;
          applyTheme(message.theme, message.locale);
          kago = {
            file: message.file,
            locale: message.locale,
            theme: message.theme,
            focused: message.focused,
            read,
            stream: () => streamFile(read, message.file.size),
            fail: (reason, text) => post({ kind: "fail", reason, ...(text === undefined ? {} : { message: text }) }),
            download: () => post({ kind: "download" }),
            storage: {
              get: async (key) => {
                const reply = await ask((id) => ({ kind: "storage:get", id, key }));
                return reply.kind === "storage:value" ? reply.value : null;
              },
              set: (key, value) => post({ kind: "storage:set", key, value })
            },
            onFocus: (listener) => subscribe(focusListeners, listener),
            onTheme: (listener) => subscribe(themeListeners, listener)
          };
          resolve(kago);
          return;
        }
        case "focus":
          if (!kago) return;
          kago.focused = message.focused;
          for (const listener of focusListeners) listener(message.focused);
          return;
        case "theme":
          if (!kago) return;
          kago.theme = message.theme;
          applyTheme(message.theme, kago.locale);
          for (const listener of themeListeners) listener(message.theme);
          return;
        case "read:ok":
        case "read:error":
        case "storage:value": {
          const waiting = pending.get(message.id);
          pending.delete(message.id);
          if (message.kind === "read:error") waiting?.reject();
          else waiting?.resolve(message);
          return;
        }
      }
    });
    // Captured, so a viewer that keeps its pointer events to itself still brings the window forward.
    window.addEventListener("pointerdown", () => post({ kind: "activate" }), { capture: true });
    // Heard as the key bubbles up to the window, so a plugin that answers one itself (Escape closing its menu) can keep it from Kago with preventDefault.
    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || MODIFIERS.has(event.key)) return;
      const chord = { key: event.key, code: event.code, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey };
      if (isForwardedKey(chord)) post({ kind: "key", ...chord });
    });
    post({ kind: "hello", api: API_VERSION });
  });
}

function subscribe<T>(listeners: Set<T>, listener: T) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function streamFile(read: (start: number, end: number) => Promise<Uint8Array>, size: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) return controller.close();
      const chunk = await read(offset, Math.min(size, offset + MAX_READ_BYTES));
      // A file that got shorter since it was listed ends where it ends.
      if (chunk.byteLength === 0) return controller.close();
      offset += chunk.byteLength;
      controller.enqueue(chunk);
    }
  });
}

function applyTheme(theme: Theme, locale: string) {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.lang = locale === "zh-TW" ? "zh-Hant" : locale === "zh-CN" ? "zh-Hans" : locale;
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
}
