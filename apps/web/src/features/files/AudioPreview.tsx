import { AudioLines, Check, Download, FileWarning, ListMusic, MicVocal, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { audioStreamUrl, downloadUrl, embeddedCoverUrl, previewUrl } from "@/api/client";
import { useFileList, useMediaInfo, useMediaInfos, useTextFile } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { parseCue, type CueSheet } from "@/lib/cue";
import { formatClock, isAudioType, isCueSheet, isMusicFile } from "@/lib/format";
import { t } from "@/lib/i18n";
import { lyricIndexAt, parseLrc, type LyricLine } from "@/lib/lrc";
import { nfc, parentPath, triggerDownload } from "@/lib/paths";
import { getAudioPanels, getAudioVisual, getVideoVolume, setAudioPanels, setAudioVisual, setVideoVolume, type AudioVisualPref } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { FileItem, MediaInfo } from "@/types/kago";
import { useAudioVisual, VISUAL_STYLES, type VisualStyle } from "./audioVisuals";
import { FileIcon } from "./FileIcon";
import { isViewableImage, sourceOf } from "./ImagePreview";
import { extensionOf } from "./fileKind";
import { PLAYER_CONTROL_CLASS, PlayerButton, PlayerSlider } from "./VideoPlayer";

const SEEK_STEP = 5;
const VOLUME_STEP = 0.1;
/** How far into a track "previous" still means the track before, rather than this one from the top. */
const RESTART_AFTER = 3;
/** The room the control bar takes at the bottom of the screen, in pixels. */
const CONTROLS_HEIGHT = 78;
// Numbered tracks sort as numbers, the way the file list shows them.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NO_FILES: FileItem[] = [];
/** A folder with more music than this is listed by file name past it, rather than read file by file. */
const MAX_TAGGED_FILES = 500;

/** Something to play: a whole file, or the stretch of one that a cue sheet calls a track. */
type Track = {
  key: string;
  number: number;
  title: string;
  performer: string;
  file: FileItem;
  start: number;
  /** Where the next track of the same file begins; null when it runs to the end of the file. */
  end: number | null;
};

const visualLabel = (style: VisualStyle) => ({ bars: t("Bars"), scope: t("Scope"), ambience: t("Ambience") })[style];

const isPlayable = (entry: FileItem) => isMusicFile(entry);
const withoutExtension = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);
/** A name as it is compared with another: without its ending, and with case and the form of its accents put aside. */
const stem = (name: string) => nfc(withoutExtension(name)).toLowerCase();

/** The tracks of a cue sheet whose audio is in the folder and can be played. */
function cueTracks(sheet: CueSheet, sheetItem: FileItem, files: FileItem[], opened: FileItem): Track[] {
  const playable = files.filter(isPlayable);
  const single = new Set(sheet.tracks.map((entry) => entry.file)).size === 1;
  const resolved = new Map<string, FileItem | undefined>();
  const resolve = (named: string) => {
    const name = named.split(/[\\/]/).at(-1)!;
    return (
      playable.find((file) => nfc(file.name).toLowerCase() === nfc(name).toLowerCase()) ??
      // A sheet often still names the WAV an album was ripped to, long after it was packed as something else.
      playable.find((file) => stem(file.name) === stem(name)) ??
      (single ? (isPlayable(opened) ? opened : playable.find((file) => stem(file.name) === stem(sheetItem.name))) : undefined)
    );
  };
  return sheet.tracks.flatMap((entry, index) => {
    if (!resolved.has(entry.file)) resolved.set(entry.file, resolve(entry.file));
    const file = resolved.get(entry.file);
    if (!file) return [];
    const next = sheet.tracks[index + 1];
    return [
      {
        key: `${file.path}#${entry.number}`,
        number: entry.number,
        title: entry.title || t("Track {number}", { number: entry.number }),
        performer: entry.performer || sheet.performer,
        file,
        start: entry.start,
        end: next && next.file === entry.file ? next.start : null
      }
    ];
  });
}

/** Without a cue sheet, the album is the folder: every file in it that plays, in the order the file list has them. */
function folderTracks(files: FileItem[], opened: FileItem): Track[] {
  const playable = files.filter(isPlayable).sort((a, b) => collator.compare(a.name, b.name));
  // The folder may not have been listed yet, and the file may have left it since.
  const list = playable.some((file) => file.path === opened.path) ? playable : [opened];
  return list.map((file, index) => ({ key: file.path, number: index + 1, title: nfc(withoutExtension(file.name)), performer: "", file, start: 0, end: null }));
}

/** What the picture of an album is called when it is not named after the music itself. */
const COVER_NAMES = ["cover", "folder", "front", "album", "albumart", "artwork"];

/** The album's picture: one named after the track or the cue sheet, or failing that the folder's `cover.jpg` and its like. */
function findCover(files: FileItem[], names: string[]) {
  const pictures = files.filter(isViewableImage);
  for (const name of [...names.map(stem), ...COVER_NAMES]) {
    const found = pictures.find((picture) => stem(picture.name) === name);
    if (found) return found;
  }
  return undefined;
}

type AudioGraph = { analyser: AnalyserNode; gain: GainNode };

// An element can be wired into Web Audio once and never taken back out, so what it is wired to is kept
// for as long as the element is, and every player shares one context.
let audioContext: AudioContext | null = null;
const graphs = new WeakMap<HTMLAudioElement, AudioGraph>();
/** Every music window's element, so that starting one stops the others. */
const players = new Set<HTMLAudioElement>();

/** Routes an element's sound through an analyser, for the picture, and a gain, so the picture does not shrink with the volume. */
function graphOf(audio: HTMLAudioElement): AudioGraph | null {
  const known = graphs.get(audio);
  if (known) return known;
  try {
    audioContext ??= new AudioContext();
    const source = audioContext.createMediaElementSource(audio);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;
    const gain = audioContext.createGain();
    source.connect(analyser).connect(gain).connect(audioContext.destination);
    const graph = { analyser, gain };
    graphs.set(audio, graph);
    return graph;
  } catch {
    // No Web Audio: the music still plays, with nothing to draw it from.
    return null;
  }
}

/**
 * A music player. What it plays through is an album: the tracks of a cue sheet, where the file was opened
 * from one or has one named after it, and otherwise the other music in the folder. The screen draws the
 * sound as it plays, and shows the lyrics over it when an `.lrc` file is named after the track.
 */
export function AudioPreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const folder = useFileList(rootSlug, parentPath(item.path));
  const files = folder.data?.items ?? NO_FILES;
  const sheetItem = isCueSheet(item) ? item : files.find((entry) => isCueSheet(entry) && [stem(item.name), nfc(item.name).toLowerCase()].includes(stem(entry.name)));
  const sheetText = useTextFile(rootSlug, sheetItem);
  const sheet = useMemo(() => (sheetText.data === undefined ? null : parseCue(sheetText.data)), [sheetText.data]);
  const album = useMemo(() => (sheet && sheetItem ? cueTracks(sheet, sheetItem, files, item) : []), [sheet, sheetItem, files, item]);
  const byCue = album.length > 0;
  const listed = useMemo(() => (byCue ? album : isPlayable(item) ? folderTracks(files, item) : []), [byCue, album, files, item]);
  // What each file says about itself: its tags name the song better than its file name does.
  const taggedPaths = useMemo(() => [...new Set(listed.map((entry) => entry.file.path))].slice(0, MAX_TAGGED_FILES), [listed]);
  const infos = useMediaInfos(rootSlug, taggedPaths);
  const tracks = useMemo(() => {
    const known = new Map<string, MediaInfo["tags"]>();
    taggedPaths.forEach((path, at) => {
      const tags = infos[at]?.tags;
      if (tags) known.set(path, tags);
    });
    if (known.size === 0) return listed;
    return listed.map((entry) => {
      const tags = known.get(entry.file.path);
      if (!tags) return entry;
      // A cue sheet describes its own tracks; the file it cuts them from is tagged as an album, if at all.
      return byCue ? { ...entry, performer: entry.performer || tags.albumArtist || tags.artist } : { ...entry, title: tags.title || entry.title, performer: tags.artist || tags.albumArtist };
    });
  }, [listed, taggedPaths, infos, byCue]);
  const resolving = isCueSheet(item) && (folder.isPending || sheetText.isPending);

  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  /** Where the next file to be loaded should start, and whether it should start by itself. */
  const pending = useRef({ time: 0, play: true });
  /** What the load under way was asked for, to ask the server for the same if the browser turns the file down. */
  const wanted = useRef({ time: 0, play: true });
  /** True while a newly chosen file loads: the element's clock is not yet that of the track on screen. */
  const settling = useRef(false);
  /** Where in the file the element's own clock starts. A stream from the server begins wherever it was asked to. */
  const offset = useRef(0);
  const clock = useCallback(() => offset.current + (audioRef.current?.currentTime ?? 0), []);
  /** Files the browser turned out not to play as they are. */
  const [refused, setRefused] = useState<Record<string, true>>({});
  /** Bumped to open a new stream at another moment of the same file. */
  const [reload, setReload] = useState(0);
  const [cueIndex, setCueIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sound, setSound] = useState(getVideoVolume);
  const [visual, setVisual] = useState(getAudioVisual);
  const [panels, setPanels] = useState(getAudioPanels);

  // An album that has just been read opens on the file that was opened, not on its first track.
  const albumKey = byCue ? `${sheetItem?.path}:${album.length}` : "";
  const [shownAlbum, setShownAlbum] = useState("");
  if (shownAlbum !== albumKey) {
    setShownAlbum(albumKey);
    setCueIndex(Math.max(0, album.findIndex((entry) => entry.file.path === item.path)));
  }

  const index = byCue ? Math.min(cueIndex, tracks.length - 1) : tracks.findIndex((entry) => entry.file.path === item.path);
  const track = tracks[index];
  const file = track?.file;
  const filePath = file?.path;
  const start = track?.start ?? 0;
  // What the browser cannot decode, the server re-encodes as it plays. Such a stream cannot be wound: seeking opens another.
  const streamed = file !== undefined && (!isAudioType(file.type) || refused[file.path] === true);
  const info = useMediaInfo(rootSlug, filePath ?? "", filePath !== undefined);
  const streamReady = info.data !== undefined;
  const streamable = info.data?.audioTranscode === true;
  const streamLength = info.data?.duration ?? 0;
  const streamFailed = info.isError;
  const tags = info.data?.tags;
  const albumTitle = (byCue ? sheet?.title : "") || tags?.album || "";
  const length = Math.max(0, (track?.end ?? (filePath ? durations[filePath] : 0) ?? 0) - start);
  const position = Math.min(Math.max(0, time - start), length || Infinity);
  const long = length >= 3600;

  const lyricSource = useMemo(() => {
    if (!track) return null;
    const lyricFiles = files.filter((entry) => entry.kind === "file" && extensionOf(entry.name) === "lrc");
    const title = nfc(track.title).toLowerCase();
    // A track of a cue sheet has no file of its own to be named after, so its lyrics go by its title.
    const own = byCue ? lyricFiles.find((entry) => stem(entry.name) === title || stem(entry.name).replace(/^\d+\s*[-._\s]\s*/, "") === title) : undefined;
    if (own) return { item: own, base: track.start };
    const shared = lyricFiles.find((entry) => stem(entry.name) === stem(track.file.name));
    return shared ? { item: shared, base: 0 } : null;
  }, [files, track, byCue]);
  const lyricText = useTextFile(rootSlug, lyricSource?.item);
  // Without a file of lyrics, the ones kept in the music file itself will do, where they are timed.
  const ownLyrics = tags?.lyrics ?? "";
  const lyrics = useMemo(() => (lyricSource ? (lyricText.data !== undefined ? parseLrc(lyricText.data) : []) : parseLrc(ownLyrics)), [lyricSource, lyricText.data, ownLyrics]);
  const lyricBase = lyricSource?.base ?? 0;
  const lyricsShown = panels.lyrics && lyrics.length > 0;

  const coverItem = useMemo(() => findCover(files, [file?.name, sheetItem?.name].filter((name) => name !== undefined)), [files, file?.name, sheetItem?.name]);
  // A picture that turns out not to load is treated as no picture at all.
  const [brokenCover, setBrokenCover] = useState<string[]>([]);
  const coverFailed = (key: string) => setBrokenCover((known) => (known.includes(key) ? known : [...known, key]));
  // The picture inside the file is this song's own; the one in the folder is the album's.
  const ownCover = file && info.data && info.data.cover !== null ? { key: `${file.path}#cover`, source: embeddedCoverUrl(rootSlug, file.path, file.mtime) } : null;
  const folderCover = coverItem ? { key: coverItem.path, source: sourceOf(rootSlug, coverItem) } : null;
  const coverChoice = [ownCover, folderCover].find((choice) => choice && !brokenCover.includes(choice.key)) ?? null;
  const cover = coverChoice?.source ?? null;
  const coverKey = coverChoice?.key ?? "";
  const tracksShown = panels.tracks && tracks.length > 1;

  const analyser = useCallback(() => (audioRef.current ? (graphs.get(audioRef.current)?.analyser ?? null) : null), []);
  useAudioVisual(canvasRef, analyser, visual === "off" ? null : visual, playing && !window.minimized, CONTROLS_HEIGHT);

  const applySound = (next: { volume: number; muted: boolean }) => {
    const audio = audioRef.current;
    if (!audio) return;
    const graph = graphs.get(audio);
    // Turned down after the analyser, so a quiet song is drawn as large as a loud one.
    if (graph) graph.gain.gain.value = next.muted ? 0 : next.volume;
    audio.volume = graph ? 1 : next.volume;
    audio.muted = graph ? false : next.muted;
  };

  const changeSound = (volume: number, muted: boolean) => {
    const next = { volume: Math.min(1, Math.max(0, volume)), muted };
    applySound(next);
    setSound(next);
    setVideoVolume(next.volume, next.muted);
  };

  const play = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (graphOf(audio)) void audioContext?.resume();
    applySound(sound);
    void audio.play().catch(() => {});
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused || audio.ended) play();
    else audio.pause();
  };

  /** Moves the playhead to a moment of the file, which need not be inside the track on screen. */
  const seekFile = (seconds: number, andPlay = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    const to = Math.max(0, seconds);
    if (streamed) {
      // Asked for its very end, the encoder would have nothing to send.
      const from = streamLength > 1 ? Math.min(to, streamLength - 1) : to;
      pending.current = { time: from, play: andPlay || !audio.paused };
      settling.current = true;
      setTime(from);
      setReload((count) => count + 1);
      return;
    }
    if (audio.readyState === 0) return;
    audio.currentTime = to;
    setTime(audio.currentTime);
    if (andPlay) play();
  };

  const seekTo = (seconds: number) => seekFile(start + Math.min(Math.max(0, seconds), length));

  const select = (target: number) => {
    const next = tracks[target];
    if (!next) return;
    setFailed(false);
    if (next.file.path === filePath) {
      seekFile(next.start, true);
    } else {
      pending.current = { time: next.start, play: true };
      settling.current = true;
      setTime(next.start);
    }
    if (byCue) setCueIndex(target);
    else if (next.file.path !== filePath) useWorkspaceStore.getState().setPreviewItem(window.id, next.file);
  };

  const previous = () => (index > 0 && position < RESTART_AFTER ? select(index - 1) : select(index));
  const next = () => select(index + 1);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    players.add(audio);
    return () => {
      players.delete(audio);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, []);

  // Shortcuts work as soon as there is something to play, without a first click on the screen.
  const ready = tracks.length > 0;
  useEffect(() => {
    if (ready) stage.current?.focus({ preventScroll: true });
  }, [ready]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !filePath) return;
    if (streamed && !(streamReady && streamable)) {
      // Nothing of the file before goes on playing while the server is asked about this one.
      audio.pause();
      if (streamReady || streamFailed) setFailed(true);
      return;
    }
    const { time: from, play: autoplay } = pending.current;
    pending.current = { time: 0, play: true };
    wanted.current = { time: from, play: autoplay };
    offset.current = streamed ? from : 0;
    audio.src = streamed ? audioStreamUrl(rootSlug, filePath, from) : previewUrl(rootSlug, filePath);
    const onMetadata = () => {
      if (!streamed && from > 0) audio.currentTime = from;
      settling.current = false;
      if (autoplay) play();
    };
    audio.addEventListener("loadedmetadata", onMetadata, { once: true });
    return () => audio.removeEventListener("loadedmetadata", onMetadata);
    // `play` only reads the element and the volume of the moment.
  }, [rootSlug, filePath, streamed, streamReady, streamable, streamFailed, reload]);

  // A stream does not say how long it is; the server has measured the file.
  useEffect(() => {
    if (streamed && filePath && streamLength > 0) setDurations((known) => (known[filePath] === streamLength ? known : { ...known, [filePath]: streamLength }));
  }, [streamed, filePath, streamLength]);

  // The keys of a keyboard or headset, and the system's own now-playing panel, follow whichever window is playing.
  const steps = useRef({ previous, next });
  steps.current = { previous, next };
  const trackKey = track?.key;
  useEffect(() => {
    if (!playing || !track || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({ title: track.title, artist: track.performer, album: albumTitle, artwork: cover ? [{ src: new URL(cover, location.href).href }] : [] });
    session.setActionHandler("previoustrack", () => steps.current.previous());
    session.setActionHandler("nexttrack", () => steps.current.next());
    return () => {
      session.setActionHandler("previoustrack", null);
      session.setActionHandler("nexttrack", null);
    };
    // The track is named by its key and by what is shown of it; a new object for the same track changes nothing here.
  }, [playing, trackKey, track?.title, track?.performer, albumTitle, cover]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as Element;
    if (target.closest("[role=menu]")) return;
    // A focused button keeps the keys it answers to itself.
    if (target.closest("button") && [" ", "Enter"].includes(event.key)) return;
    const key = event.key.toLowerCase();
    if (key === " " || key === "k") togglePlay();
    else if (key === "arrowleft") seekTo(position - SEEK_STEP);
    else if (key === "arrowright") seekTo(position + SEEK_STEP);
    else if (key === "arrowup") changeSound(sound.volume + VOLUME_STEP, false);
    else if (key === "arrowdown") changeSound(sound.volume - VOLUME_STEP, false);
    else if (key === "m") changeSound(sound.volume, !sound.muted);
    else if (key === "n" && event.shiftKey && index < tracks.length - 1) next();
    else if (key === "p" && event.shiftKey) previous();
    else if (key === "l" && lyrics.length > 0) togglePanel("lyrics");
    else return;
    event.preventDefault();
  };

  const togglePanel = (panel: "tracks" | "lyrics") => {
    const changed = { ...panels, [panel]: !panels[panel] };
    setPanels(changed);
    setAudioPanels(changed);
  };

  const pickVisual = (choice: AudioVisualPref) => {
    setVisual(choice);
    setAudioVisual(choice);
  };

  const silent = sound.muted || sound.volume === 0;
  const VolumeIcon = silent ? VolumeX : sound.volume < 0.5 ? Volume1 : Volume2;
  const download = () => triggerDownload(downloadUrl(rootSlug, item.path));
  const status = failed ? t("Couldn’t play this audio") : loading || (streamed && info.isPending) ? (streamed ? t("Transcoding…") : t("Loading…")) : null;
  const credit = [track?.performer, albumTitle].filter(Boolean).join(" — ");

  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      // Music goes on playing while its window is put away.
      keepMounted
      titleExtra={
        <>
          {tracks.length > 1 ? (
            <KagoIconButton label={t("Tracks")} className="size-6" active={panels.tracks} onClick={() => togglePanel("tracks")}>
              <ListMusic />
            </KagoIconButton>
          ) : null}
          <KagoIconButton label={t("Download")} className="size-6" onClick={download}>
            <Download />
          </KagoIconButton>
        </>
      }
    >
      {/* The element is there from the start, whatever is on screen, so that what is wired to it is wired once. */}
      <audio
        ref={audioRef}
        preload="auto"
        onLoadStart={() => setLoading(true)}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onPlaying={() => {
          setLoading(false);
          setFailed(false);
        }}
        onPlay={(event) => {
          for (const other of players) if (other !== event.currentTarget) other.pause();
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          if (index < tracks.length - 1) next();
        }}
        onError={(event) => {
          setLoading(false);
          if (!filePath || streamed) return setFailed(true);
          // The browser will not have it as it is; the server may be able to re-encode it.
          pending.current = { time: Math.max(wanted.current.time, event.currentTarget.currentTime || 0), play: wanted.current.play };
          settling.current = true;
          setRefused((known) => ({ ...known, [filePath]: true }));
        }}
        onDurationChange={(event) => {
          const { duration } = event.currentTarget;
          if (filePath && !streamed && Number.isFinite(duration)) setDurations((known) => (known[filePath] === duration ? known : { ...known, [filePath]: duration }));
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          if (audio.readyState === 0 || settling.current) return;
          const now = clock();
          setTime(now);
          if (!byCue) return;
          // One long file plays straight through its tracks; the screen follows it from one to the next.
          let reached = -1;
          tracks.forEach((entry, at) => {
            if (entry.file.path === filePath && entry.start <= now + 0.05) reached = at;
          });
          if (reached !== -1 && reached !== cueIndex) setCueIndex(reached);
        }}
      />
      {resolving ? (
        <KagoLoading />
      ) : tracks.length === 0 ? (
        <KagoEmptyState className="min-h-0 flex-1" icon={<FileWarning />} title={t("Couldn’t open this cue sheet")} description={t("The audio it points to is not in this folder, or is in a format the browser can’t play.")}>
          <Button onClick={download}>{t("Download")}</Button>
        </KagoEmptyState>
      ) : (
        <div className="@container flex min-h-0 flex-1" onKeyDown={onKeyDown}>
          <div ref={stage} tabIndex={-1} className="@container relative min-w-0 flex-1 overflow-hidden bg-black text-white outline-none">
            <canvas ref={canvasRef} aria-hidden className={cn("absolute inset-0 size-full transition-opacity duration-150", lyricsShown && "opacity-35")} />

            {cover && visual === "off" && !lyricsShown ? (
              // With nothing drawn and nothing sung, the screen is the album's.
              <div className="pointer-events-none absolute inset-x-6 top-16 flex items-center justify-center" style={{ bottom: CONTROLS_HEIGHT + 16 }}>
                <img src={cover} alt="" draggable={false} className="max-h-full max-w-full rounded-lg object-contain ring-1 ring-white/15" onError={() => coverFailed(coverKey)} />
              </div>
            ) : null}

            <header className="pointer-events-none absolute inset-x-4 top-3 flex items-center gap-3">
              {cover ? <img src={cover} alt="" draggable={false} className="size-10 shrink-0 rounded-md object-cover ring-1 ring-white/15" onError={() => coverFailed(coverKey)} /> : null}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{track?.title}</div>
                <div className="truncate text-xs text-white/60">{status ?? credit}</div>
              </div>
            </header>

            {lyricsShown ? (
              <Lyrics key={lyricSource?.item.path ?? filePath} lines={lyrics} clock={clock} base={lyricBase} playing={playing} time={time} onSeek={(seconds) => seekFile(lyricBase + seconds)} />
            ) : null}

            <div className="kago-player-glass absolute inset-x-2 bottom-2 flex flex-col gap-0.5 rounded-lg px-2.5 pt-1.5 pb-1.5">
              <PlayerSlider label={t("Playback position")} value={position} max={length} format={(seconds) => formatClock(seconds, long)} onCommit={seekTo} />
              <div className="flex items-center gap-1">
                {tracks.length > 1 ? (
                  <PlayerButton label={t("Previous track (⇧P)")} onClick={previous}>
                    <SkipBack className="fill-current" />
                  </PlayerButton>
                ) : null}
                <PlayerButton label={playing ? t("Pause (Space)") : t("Play (Space)")} className="kago-player-key mx-1 size-8 rounded-full" onClick={togglePlay}>
                  {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
                </PlayerButton>
                {tracks.length > 1 ? (
                  <PlayerButton label={t("Next track (⇧N)")} disabled={index >= tracks.length - 1} onClick={next}>
                    <SkipForward className="fill-current" />
                  </PlayerButton>
                ) : null}
                <PlayerButton label={silent ? t("Unmute (M)") : t("Mute (M)")} onClick={() => changeSound(sound.volume || 1, !silent)}>
                  <VolumeIcon />
                </PlayerButton>
                <PlayerSlider label={t("Volume")} className="hidden w-16 @sm:block" value={silent ? 0 : sound.volume} max={1} format={(volume) => `${Math.round(volume * 100)}%`} onChange={(volume) => changeSound(volume, false)} />
                <span className="min-w-0 truncate px-1.5 text-xs text-white/80 tabular-nums">
                  {formatClock(position, long)} / {formatClock(length, long)}
                </span>
                <div className="flex-1" />
                {lyrics.length > 0 ? (
                  <PlayerButton label={t("Lyrics (L)")} active={panels.lyrics} onClick={() => togglePanel("lyrics")}>
                    <MicVocal />
                  </PlayerButton>
                ) : null}
                <KagoDropdownMenu
                  label={t("Visualization")}
                  side="top"
                  className={`size-7! ${PLAYER_CONTROL_CLASS}`}
                  menu={
                    <>
                      {VISUAL_STYLES.map((style) => (
                        <CheckItem key={style} checked={visual === style} onClick={() => pickVisual(style)}>
                          {visualLabel(style)}
                        </CheckItem>
                      ))}
                      <KagoMenuSeparator />
                      <CheckItem checked={visual === "off"} onClick={() => pickVisual("off")}>
                        {t("Off")}
                      </CheckItem>
                    </>
                  }
                >
                  <AudioLines />
                </KagoDropdownMenu>
              </div>
            </div>
          </div>
          {tracksShown ? (
            <TrackList
              tracks={tracks}
              current={index}
              playing={playing}
              focused={window.focused}
              heading={byCue ? { title: albumTitle, performer: sheet?.performer || tags?.albumArtist || tags?.artist || "" } : null}
              lengthOf={(entry) => (entry.end ?? durations[entry.file.path] ?? 0) - entry.start}
              onSelect={select}
              returnFocus={() => stage.current?.focus({ preventScroll: true })}
            />
          ) : null}
        </div>
      )}
    </KagoWindow>
  );
}

function CheckItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <KagoMenuItem icon={checked ? <Check /> : <span className="size-4" />} onClick={onClick}>
      {children}
    </KagoMenuItem>
  );
}

/**
 * The album beside the screen: every track, with the one that is playing marked. It makes way when the window is narrow.
 */
function TrackList({
  tracks,
  current,
  playing,
  focused,
  heading,
  lengthOf,
  onSelect,
  returnFocus
}: {
  tracks: Track[];
  current: number;
  playing: boolean;
  focused: boolean;
  heading: { title: string; performer: string } | null;
  lengthOf: (track: Track) => number;
  onSelect: (index: number) => void;
  /** Hands the keyboard back to the player after a click, so Space pauses instead of choosing the track again. */
  returnFocus: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.children[current]?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <aside className="hidden w-64 max-w-[45%] shrink-0 flex-col border-l border-line bg-surface @lg:flex" aria-label={t("Tracks")}>
      {heading && (heading.title || heading.performer) ? (
        <header className="shrink-0 border-b border-line px-3 py-2">
          <div className="truncate font-medium">{heading.title}</div>
          <div className="truncate text-xs text-muted">{heading.performer}</div>
        </header>
      ) : null}
      <ol ref={list} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
        {tracks.map((track, index) => {
          const length = lengthOf(track);
          const chosen = index === current;
          return (
            <li key={track.key}>
              <button
                type="button"
                aria-current={chosen || undefined}
                className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50", chosen ? (focused ? "kago-selection" : "bg-accent-soft") : "hover:bg-hover")}
                onClick={(event) => {
                  onSelect(index);
                  if (event.detail > 0) returnFocus();
                }}
              >
                <span className="flex w-5 shrink-0 justify-end text-xs tabular-nums opacity-60">{chosen && playing ? <Volume2 className="size-3.5" /> : track.number}</span>
                <span className="min-w-0 flex-1 truncate">{track.title}</span>
                {length > 0 ? <span className="shrink-0 text-xs tabular-nums opacity-60">{formatClock(length)}</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/**
 * The words of the song over the screen, the line being sung in the middle and lit. A line can be clicked to hear it.
 */
function Lyrics({
  lines,
  clock,
  base,
  playing,
  time,
  onSeek
}: {
  lines: LyricLine[];
  /** Where the playhead is in the file, read whenever it is asked. */
  clock: () => number;
  /** Where in the file the lyrics count from. */
  base: number;
  playing: boolean;
  time: number;
  onSeek: (seconds: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [offset, setOffset] = useState(0);

  // The player's own clock ticks a few times a second, which is too coarse to change a line on the beat.
  useEffect(() => {
    const read = () => setActive(lyricIndexAt(lines, clock() - base));
    read();
    if (!playing) return;
    let request = requestAnimationFrame(function follow() {
      read();
      request = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(request);
  }, [lines, clock, base, playing, time]);

  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const settle = () => {
      const line = node.children[Math.max(0, active)] as HTMLElement | undefined;
      setOffset(line ? line.offsetTop + line.offsetHeight / 2 : 0);
    };
    settle();
    // Lines wrap differently as the window is resized.
    const observer = new ResizeObserver(settle);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, lines]);

  return (
    <div className="absolute inset-x-0 top-14 overflow-hidden [mask-image:linear-gradient(transparent,black_22%,black_78%,transparent)]" style={{ bottom: CONTROLS_HEIGHT }}>
      <div ref={list} className="absolute inset-x-0 top-1/2 transition-transform duration-200 ease-out" style={{ transform: `translateY(${-offset}px)` }}>
        {lines.map((line, index) => (
          // Like the playhead, a line takes no focus: the keyboard reaches the song through the player's shortcuts.
          <p
            key={index}
            className={cn(
              "m-0 min-h-6 cursor-pointer px-6 py-1.5 text-center text-base leading-snug font-semibold whitespace-pre-line transition-colors duration-150 @lg:text-xl",
              index === active ? "text-white" : "text-white/35 hover:text-white/70"
            )}
            onClick={() => onSeek(line.time)}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}
