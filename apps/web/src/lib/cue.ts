/** One track of a cue sheet: where it starts in which file. Where it ends is wherever the next one starts. */
export type CueTrack = { number: number; title: string; performer: string; file: string; start: number };

export type CueSheet = { title: string; performer: string; tracks: CueTrack[] };

/** A cue sheet counts in frames of a CD, 75 to the second. */
const FRAMES = 75;

const MAX_TRACKS = 999;

/** A value as it is written after a command: quoted, or a bare word. */
function unquote(value: string) {
  const text = value.trim();
  const quoted = /^"(.*)"/.exec(text);
  return quoted ? quoted[1]! : text;
}

function cueTime(value: string) {
  const [minutes = 0, seconds = 0, frames = 0] = value.trim().split(":").map(Number);
  const time = minutes * 60 + seconds + frames / FRAMES;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Reads a cue sheet: the album it describes and the tracks cut out of its audio files.
 * A track begins at its INDEX 01; the pregap before it (INDEX 00) is left to the track before.
 */
export function parseCue(text: string): CueSheet {
  const sheet: CueSheet = { title: "", performer: "", tracks: [] };
  let file = "";
  let track: (CueTrack & { indexed: boolean }) | null = null;

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[1]!.toUpperCase();
    const rest = match[2]!;
    if (command === "FILE") {
      // What follows the name is the kind of file, which says nothing the name does not.
      const quoted = /^\s*"(.*)"/.exec(rest);
      file = quoted ? quoted[1]! : rest.trim().replace(/\s+\S+$/, "");
    } else if (command === "TRACK") {
      const [number = "", kind = ""] = rest.trim().split(/\s+/);
      track = null;
      // A disc holds 99 tracks; a sheet with far more is not listed without end.
      if (kind.toUpperCase() !== "AUDIO" || sheet.tracks.length >= MAX_TRACKS) continue;
      track = { number: Number(number) || sheet.tracks.length + 1, title: "", performer: "", file, start: 0, indexed: false };
      sheet.tracks.push(track);
    } else if (command === "TITLE") {
      if (track) track.title = unquote(rest);
      else sheet.title = unquote(rest);
    } else if (command === "PERFORMER") {
      if (track) track.performer = unquote(rest);
      else sheet.performer = unquote(rest);
    } else if (command === "INDEX" && track) {
      const [number = "", time = ""] = rest.trim().split(/\s+/);
      // A sheet with a file to each track may name the next file between a track's pregap and its start.
      if (Number(number) === 1 || !track.indexed) {
        track.file = file;
        track.start = cueTime(time);
        track.indexed = true;
      }
    }
  }

  return { ...sheet, tracks: sheet.tracks.filter((entry) => entry.file).map(({ number, title, performer, file: name, start }) => ({ number, title, performer, file: name, start })) };
}
