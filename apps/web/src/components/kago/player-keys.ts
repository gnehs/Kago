const SEEK_STEP = 5;
const VOLUME_STEP = 0.1;

export type PlayerKeyAction =
  | { kind: "info" }
  | { kind: "escape" }
  | { kind: "toggle" }
  | { kind: "seek"; by: number }
  | { kind: "volume"; by: number }
  | { kind: "mute" }
  | { kind: "fullscreen" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "lyrics" };

export type PlayerKeyEvent = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null };

export type PlayerKeyOptions = {
  /** Whether a focused button keeps ↑ and ↓ as well as Space and Enter. */
  buttonsKeepArrows?: boolean;
  /** The shortcuts this player has; a key whose shortcut it lacks is left to the page. */
  info?: boolean;
  fullscreen?: boolean;
  lyrics?: boolean;
  next?: boolean;
  previous?: boolean;
};

/** What a key pressed in a player asks of it, or null when the key is not the player's. */
export function playerKeyAction(event: PlayerKeyEvent, options: PlayerKeyOptions): PlayerKeyAction | null {
  const target = event.target as Element | null;
  const inMenu = Boolean(target?.closest("[role=menu]"));
  // The same keys as the info panel of a picture, and the bare letter the other shortcuts here use.
  if (options.info && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i" && !inMenu) return { kind: "info" };
  if (event.metaKey || event.ctrlKey || event.altKey || inMenu) return null;
  if (event.key === "Escape") return { kind: "escape" };
  // A focused button keeps the keys it answers to itself.
  const buttonKeys = options.buttonsKeepArrows ? [" ", "Enter", "ArrowUp", "ArrowDown"] : [" ", "Enter"];
  if (target?.closest("button") && buttonKeys.includes(event.key)) return null;
  const key = event.key.toLowerCase();
  if (key === " " || key === "k") return { kind: "toggle" };
  if (key === "arrowleft") return { kind: "seek", by: -SEEK_STEP };
  if (key === "arrowright") return { kind: "seek", by: SEEK_STEP };
  if (key === "arrowup") return { kind: "volume", by: VOLUME_STEP };
  if (key === "arrowdown") return { kind: "volume", by: -VOLUME_STEP };
  if (key === "m") return { kind: "mute" };
  if (key === "f" && options.fullscreen) return { kind: "fullscreen" };
  if (key === "n" && event.shiftKey && options.next) return { kind: "next" };
  if (key === "p" && event.shiftKey && options.previous) return { kind: "previous" };
  if (key === "l" && options.lyrics) return { kind: "lyrics" };
  return null;
}
