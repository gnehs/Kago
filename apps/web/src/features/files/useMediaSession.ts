import { useEffect, useRef, type RefObject } from "react";

/** What a player tells the system about what it is playing, and what the system may ask of it in return. */
export type NowPlaying = {
  title: string;
  artist?: string;
  album?: string;
  /** The address of a picture to show beside the title. */
  artwork?: string | null;
  playing: boolean;
  /** How long it lasts, in seconds; 0 while that is not known. */
  duration: number;
  /** Where the playhead is, in seconds, read whenever it is asked. */
  position: () => number;
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  /** Steps to what comes before and after it; left out where there is nothing to step to. */
  previous?: (() => void) | null;
  next?: (() => void) | null;
};

/** How far a skip button of the system's goes when it does not say. */
const SKIP_STEP = 10;
const ACTIONS: MediaSessionAction[] = ["play", "pause", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"];
/** After these the playhead is somewhere, or moves at a pace, that the system could not have worked out by itself. */
const POSITION_EVENTS = ["loadedmetadata", "playing", "seeked", "ratechange"];

type Claim = { view: Window; describe: () => void; report: () => void };

// A page has one now-playing panel, however many players are open in it. The panel follows the one that started
// playing last, and goes back to the one before it when that one closes.
const claims: Claim[] = [];

/** A floating window is a page of its own to the system, with a panel of its own. */
const ownerOf = (view: Window) => claims.filter((claim) => claim.view === view).at(-1) ?? null;

function sessionOf(view: Window): MediaSession | null {
  try {
    return "mediaSession" in view.navigator ? view.navigator.mediaSession : null;
  } catch {
    return null;
  }
}

function handle(session: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // A browser refuses an action it has not heard of; the others still work.
  }
}

function raise(claim: Claim) {
  if (ownerOf(claim.view) === claim) return;
  const at = claims.indexOf(claim);
  if (at !== -1) claims.splice(at, 1);
  claims.push(claim);
  claim.describe();
}

function drop(claim: Claim) {
  const at = claims.indexOf(claim);
  if (at === -1) return;
  const owned = ownerOf(claim.view) === claim;
  claims.splice(at, 1);
  if (!owned) return;
  const heir = ownerOf(claim.view);
  if (heir) return heir.describe();
  const session = sessionOf(claim.view);
  if (!session) return;
  try {
    session.metadata = null;
    session.playbackState = "none";
    for (const action of ACTIONS) handle(session, action, null);
    session.setPositionState?.();
  } catch {
    // A floating window that has closed took its panel with it.
  }
}

/**
 * Puts a player in the system's now-playing panel, and under the media keys of a keyboard or headset, from the
 * moment it first plays. `view` is the window the element is in, where that is not the page's own.
 */
export function useMediaSession(mediaRef: RefObject<HTMLMediaElement | null>, now: NowPlaying | null, view: Window = self) {
  const latest = useRef(now);
  latest.current = now;
  const claim = useRef<Claim | null>(null);
  /** Whether the player has played, and so has a place in the panel to keep when it moves to another window. */
  const held = useRef(false);
  const present = now !== null;
  const playing = now?.playing ?? false;

  const refresh = (part: "describe" | "report") => {
    const own = claim.current;
    if (own && ownerOf(own.view) === own) own[part]();
  };

  useEffect(() => {
    const session = present ? sessionOf(view) : null;
    if (!session) return;
    const skip = (by: number) => {
      const now = latest.current;
      now?.seekTo(now.position() + by);
    };
    const own: Claim = {
      view,
      describe: () => {
        const now = latest.current;
        if (!now) return;
        session.metadata = new (view as Window & typeof globalThis).MediaMetadata({
          title: now.title,
          artist: now.artist ?? "",
          album: now.album ?? "",
          artwork: now.artwork ? [{ src: new URL(now.artwork, location.href).href }] : []
        });
        handle(session, "play", () => latest.current?.play());
        handle(session, "pause", () => latest.current?.pause());
        handle(session, "seekbackward", (details) => skip(-(details.seekOffset || SKIP_STEP)));
        handle(session, "seekforward", (details) => skip(details.seekOffset || SKIP_STEP));
        handle(session, "seekto", (details) => {
          // Only where a drag ends: every seek in a transcoded stream may restart the encoder.
          if (details.seekTime !== undefined && !details.fastSeek) latest.current?.seekTo(details.seekTime);
        });
        // Without these two the system offers its skip buttons in their place.
        handle(session, "previoustrack", now.previous ? () => latest.current?.previous?.() : null);
        handle(session, "nexttrack", now.next ? () => latest.current?.next?.() : null);
        own.report();
      },
      report: () => {
        const now = latest.current;
        if (!now) return;
        session.playbackState = now.playing ? "playing" : "paused";
        try {
          // The element's own clock is not always that of what is on screen: a track may be a stretch of a longer
          // file, and a stream from the server starts at zero wherever in the file it begins.
          if (now.duration > 0 && Number.isFinite(now.duration)) {
            session.setPositionState?.({ duration: now.duration, position: Math.min(Math.max(0, now.position()), now.duration), playbackRate: mediaRef.current?.playbackRate || 1 });
          } else {
            session.setPositionState?.();
          }
        } catch {
          // A position the browser will not take leaves the panel without a playhead, which is all it costs.
        }
      }
    };
    claim.current = own;
    return () => {
      claim.current = null;
      drop(own);
    };
  }, [present, view, mediaRef]);

  useEffect(() => {
    const own = claim.current;
    if (!own) {
      held.current = false;
      return;
    }
    // A pause keeps the panel; so does a move to another window, which is a new claim for the same player.
    if (!playing && !(held.current && !claims.includes(own))) return;
    held.current = true;
    raise(own);
  }, [playing, present, view]);

  const { title, artist, album, artwork, duration } = now ?? {};
  const hasPrevious = Boolean(now?.previous);
  const hasNext = Boolean(now?.next);
  useEffect(() => refresh("describe"), [title, artist, album, artwork, hasPrevious, hasNext]);
  useEffect(() => refresh("report"), [playing, duration]);

  // The system counts the seconds itself from what it was last told, so it is told again whenever that stops holding.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const report = () => refresh("report");
    for (const event of POSITION_EVENTS) media.addEventListener(event, report);
    return () => {
      for (const event of POSITION_EVENTS) media.removeEventListener(event, report);
    };
  }, [mediaRef]);
}
