/**
 * The shapes the server sends and the web app reads, over HTTP and the event socket. Only types live here: the server
 * builds these values, the web app reads them, and neither may describe them on its own.
 */

export type Role = "ADMIN" | "USER";

export type Actor = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  /** When their profile picture was last set, for the ones who are shown: it names the picture to ask for. */
  avatar?: number | null;
};

/** A location as it is shown: where it is kept on the server and how it is reached stay there. */
export type Root = {
  id: string;
  slug: string;
  name: string;
  /** `local`, or the kind of remote (`smb`, `sftp`, ...) that rclone reaches for it. */
  provider: string;
  readonly: number;
  created_at: number;
  updated_at: number;
};

export type FileRef = {
  rootSlug: string;
  path: string;
};

export type FileTagColor = "gray" | "green" | "purple" | "blue" | "yellow" | "red" | "orange";

/** A tag kept on the file itself, the way macOS Finder keeps its own. */
export type FileTag = { name: string; color: FileTagColor | null };

/** One entry of a folder listing or of a search. */
export type FileItem = { name: string; path: string; kind: "folder" | "file"; size: number; mtime: number; type: string; readonly: boolean; tags: FileTag[] };

export type FolderListing = { rootSlug: string; path: string; readonly: boolean; items: FileItem[] };

export type FileMeta = { rootSlug: string; path: string; name: string; kind: "folder" | "file"; size: number; mtime: number; type: string; tags: FileTag[] };

/** One entry of a zip, by its path inside it, with `/` between folders and none at the end; `mtime` is null when the archive gives no date. */
export type ArchiveEntry = { path: string; folder: boolean; size: number; packed: number; mtime: number | null; locked: boolean };
/** `truncated` says entries past the server's limit were left out. */
export type ArchiveListing = { entries: ArchiveEntry[]; truncated: boolean };

export type SqliteCell = string | number | null | { blob: number };
export type SqliteTable = { name: string; type: "table" | "view"; columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean }> };
/** `total` is null for a database too large to count. */
export type SqlitePage = { columns: string[]; rows: SqliteCell[][]; offset: number; hasMore: boolean; total: number | null };

/** A source of a copy or move whose name the destination already has. Sizes are of files only, and a time is 0 where the location keeps none. */
export type TransferConflict = { rootSlug: string; path: string; name: string; kind: "file" | "folder"; size: number; mtime: number; existing: { kind: "file" | "folder"; size: number; mtime: number }; same: boolean };

/**
 * Where a task is in its life. `cancelling` is a running task asked to stop: the worker still holds it,
 * and it turns `cancelled` once the worker has let go.
 */
export type TaskStatus = "queued" | "paused" | "running" | "cancelling" | "done" | "failed" | "cancelled" | "interrupted";

export type TaskType =
  | "copy"
  | "move"
  | "delete_to_trash"
  | "delete"
  | "restore_trash"
  | "empty_trash"
  | "compress"
  | "download_zip"
  | "extract"
  | "thumbnail"
  | "sync"
  | "convert"
  | "remux";

/** How many frames a second a conversion is making its video at, and how tall that comes out. */
export type TaskPace = { fps: number; height: number | null };

/** A task as its row is kept, and as it is sent. `sources_json` and `destination` are JSON the task's type gives a shape to. */
export type FileTask = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  created_by: string;
  sources_json: string;
  destination: string | null;
  total_files: number;
  processed_files: number;
  total_bytes: number;
  processed_bytes: number;
  /**
   * The file a running task is on: its path in a location, posix, with a leading slash, which is the same
   * for every type. It is kept after the task ends, so only a running task's is current.
   */
  current_path: string | null;
  /**
   * What a running task is at before there is anything to count: `counting` while it adds up what it has to do,
   * its totals being what it has found so far, `preparing` while it fetches what it works on.
   */
  phase?: string | null;
  error_message: string | null;
  auth_snapshot_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** Sent in the task list for a running conversion that has said how it is getting on. */
  pace?: TaskPace;
};

/**
 * What changed in a location: `paths` are folders that hold something else now, `gone` items that are no longer where
 * they were, and `trees` folders anything inside which may have changed. It goes to whoever may see the location.
 */
export type FsChanged = { type: "fs.changed"; rootSlug: string; paths: string[]; gone?: string[]; trees?: string[] };

/** What the event socket sends. Most say only what to read again; the task ones also say what happened. */
export type ServerEvent =
  | { type: "task.created"; userId: string; task: FileTask }
  | { type: "task.progress"; userId: string; taskId: string; patch: Partial<FileTask> }
  | { type: "task.done"; userId: string; taskId: string }
  | { type: "task.failed"; userId: string; taskId: string; error: string }
  | { type: "shelf.updated"; userId: string; shelfId: string }
  | { type: "workspace.updated"; userId: string }
  | { type: "settings.updated"; userId: string }
  | { type: "account.updated"; userId: string }
  | { type: "permission.updated"; userId?: string }
  | { type: "roots.updated" }
  | { type: "apps.updated"; userId?: string }
  | { type: "share.updated"; userId: string }
  | FsChanged;

export type ServerEventType = ServerEvent["type"];

/** A share link as its creator, or an admin, is sent it. Who else may use it is decided again on every visit. */
export type ShareLink = {
  id: string;
  root_id: string;
  path: string;
  /** `{ "mode": "view_only" | "download" | "upload_only" }`. */
  permission_json: string;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  has_password: boolean;
  created_by: string;
  disabled: number;
  created_at: number;
  updated_at: number;
  /** What follows `/s/` in the link. Null for a link made before Kago kept them: it still works, but can only be copied once it is given a new one. */
  token: string | null;
  /** Whoever made the link, with what their avatar is drawn from. */
  creator: { id: string; email: string; display_name: string; avatar_at: number | null };
};

export type PermissionLevel = "view" | "edit";

/** A rule is for a whole location: whoever it names gets its level on everything inside. */
export type PermissionRule = {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  root_id: string;
  level: PermissionLevel;
  created_at: number;
  updated_at: number;
};

/** Shooting data read from a picture; every field is there only when the file has it. */
export type ImageMetadata = {
  camera?: string;
  lens?: string;
  /** Wall-clock time where the picture was taken, as the camera wrote it. */
  takenAt?: string;
  timeZone?: string;
  exposureTime?: string;
  aperture?: number;
  iso?: number;
  focalLength?: string;
  focalLength35?: string;
  exposureCompensation?: number;
  flash?: string;
  whiteBalance?: string;
  meteringMode?: string;
  exposureProgram?: string;
  width?: number;
  height?: number;
  colorSpace?: string;
  software?: string;
  gps?: { latitude: number; longitude: number; altitude?: number };
  filmRecipe?: FilmRecipe;
};

/** The picture settings a Fujifilm camera developed the frame with, which its photographers trade as recipes. */
export type FilmRecipe = {
  /** Named as the camera's menu names it. */
  simulation?: string;
  grainRoughness?: string;
  grainSize?: string;
  colorChrome?: string;
  colorChromeBlue?: string;
  /** In the steps the menu counts in. */
  whiteBalanceShift?: { red: number; blue: number };
  /** Kelvin, when the white balance was set as a temperature. */
  colorTemperature?: number;
  /** A percentage: 100, 200 or 400. */
  dynamicRange?: number;
  dynamicRangeAuto?: boolean;
  dRangePriority?: string;
  dRangePriorityAuto?: boolean;
  highlight?: number;
  shadow?: number;
  color?: number;
  sharpness?: number;
  noiseReduction?: number;
  clarity?: number;
  /** Warm above zero, cool below. */
  monochromeWarmCool?: number;
  /** Green above zero, magenta below. */
  monochromeMagentaGreen?: number;
};

/** The transfer curve of an HDR picture: PQ (HDR10, Dolby Vision with an HDR10 base) or HLG. */
export type HdrTransfer = "pq" | "hlg";

/** What the server encodes with: `software`, or the GPU API in use. */
export type MediaEncoder = "software" | "nvenc" | "vaapi" | "vaapi-cqp" | "videotoolbox";

export type MediaTags = { title: string; artist: string; album: string; albumArtist: string; track: string; date: string; genre: string; lyrics: string };

/** What the server knows about a video, and whether it can transcode it on the fly. */
export type MediaInfo = {
  /** False when ffmpeg is missing; the client then falls back to playing the file as-is. */
  transcode: boolean;
  duration: number;
  /** ffprobe's format name list, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  container: string;
  /** Bits per second of the whole file; 0 where a figure is not known, here and for each stream. */
  bitrate: number;
  /**
   * `peak` is the brightest its mastering display went, in nits; 0 when the file does not say.
   * `level` is as ffprobe gives it (41 for H.264 level 4.1, 153 for HEVC level 5.1); `dolbyVision` is the profile, 0 without it.
   */
  video: {
    codec: string;
    profile: string;
    level: number;
    width: number;
    height: number;
    fps: number;
    bitDepth: number;
    pixelFormat: string;
    interlaced: boolean;
    bitrate: number;
    hdr: HdrTransfer | null;
    peak: number;
    dolbyVision: number;
  } | null;
  audio: Array<{ codec: string; profile: string; channels: number; layout: string; sampleRate: number; bitrate: number; language: string; title: string; default: boolean }>;
  /** Subtitle streams inside the file, numbered among themselves. `text` ones are handed to the player; `picture` ones are drawn into the frames. */
  subtitles: Array<{ index: number; codec: string; language: string; title: string; default: boolean; forced: boolean; sdh: boolean; text: boolean; picture: boolean }>;
  /** Fonts attached to the file for its subtitles, numbered among the attachments. */
  fonts: Array<{ index: number; name: string }>;
  /** Heights the file can be transcoded to, tallest first. */
  qualities: number[];
  /** What the file says about itself: ID3 in an MP3, Vorbis comments in FLAC and Ogg, atoms in MP4, and so on. Empty where it says nothing. */
  tags: MediaTags;
  /** Which of the file's video streams is a picture attached to it, such as the cover of an album; null without one. */
  cover: number | null;
  /** Whether the file's sound can be re-encoded as Opus as it plays, for music the browser cannot decode. */
  audioTranscode: boolean;
  encoder: MediaEncoder;
  /** Whether an HDR source can be transcoded as HDR (10-bit HEVC), for a screen that shows it. */
  hdrOutput: boolean;
  /** Whether an HDR source can be tone-mapped to SDR. Without it the transcoded picture is washed out. */
  tonemap: boolean;
};

/** A subtitle for a video: a file lying next to it, or a stream inside it. */
export type SubtitleTrack = {
  id: string;
  /** Where its text is read from; empty for a picture subtitle, which has none. */
  url: string;
  embedded: boolean;
  /** Anything but `ass` and `srt` is a picture subtitle (Blu-ray, DVD, broadcast). */
  format: "ass" | "srt" | "pgs" | "vobsub" | "dvb" | "picture";
  /** A picture subtitle's number among the subtitle streams of the file it is in. The server draws it into the frames, so showing it means transcoding. */
  stream?: number;
  /** The file a picture subtitle is in, when it lies next to the video rather than inside it. */
  file?: string;
  /** A BCP 47 tag, or empty when neither the name nor the stream carries a language. */
  language: string;
  title: string;
  default: boolean;
  forced: boolean;
  sdh: boolean;
};

export type SubtitleList = {
  tracks: SubtitleTrack[];
  /** Where the fonts attached to the video for its own subtitles are read from. */
  fonts: string[];
  /** How many picture subtitles (Blu-ray, DVD) the video has that a browser cannot draw. */
  unsupported: number;
};

/**
 * The small pictures shown over a video's timeline: one every `interval` seconds, laid out in sheets of
 * `columns` by `rows`, each `width` by `height`. Picture `n` is in sheet `n / (columns * rows)`.
 */
export type StoryboardLayout = { interval: number; count: number; width: number; height: number; columns: number; rows: number; sheets: number };
/** `version` tells the sheets of one state of the file from the next. */
export type ReadyStoryboard = { status: "ready"; version: number } & StoryboardLayout;
/** `pending` while the server has not got round to making them, which it does only when it is not encoding. */
export type Storyboard = ReadyStoryboard | { status: "pending" | "unavailable"; version: number };

export type SyncChange = { action: "copy" | "delete" | "mkdir" | "rmdir" | "touch"; path: string; size?: number };
export type SyncSummary = Record<SyncChange["action"], number> & { bytes: number };
/** How much a run changed, or a trial run would have; `truncated` when it names fewer changes than it counted. */
export type SyncTrialSummary = SyncSummary & { truncated: boolean };
/** What the changes add up to, counted over all of them and not only the ones that are listed. */
export type SyncStats = {
  /** The bytes of what would be deleted, as far as the tool said how big that is. */
  freed: number;
  /** What would be copied, by the ending of its name; the many small ones are folded into the one with no ending. */
  extensions: Array<{ extension: string; count: number; bytes: number }>;
  /** The folders at the top that most would change in; `name` is empty for what lies beside them. */
  folders: Array<{ name: string; copy: number; delete: number; bytes: number }>;
  moreFolders: number;
};
export type SyncTrial = SyncTrialSummary & { stats: SyncStats; changes: SyncChange[] };
/** One run of a sync job. */
export type SyncRun = {
  task_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  error_message: string | null;
  dry_run: boolean;
  scheduled: boolean;
  /** What a run that was not a trial brought across. */
  bytes: number;
  /** How much the run changed, or would have changed when it was a trial; known only of a run that ended well. */
  summary: SyncTrialSummary | null;
};

/** What the server's ffmpeg can make; nothing at all without one. `videoCodecs` names the encoders that can be asked for, the GPU's among them. */
export type ConvertSupport = { available: boolean; formats: string[]; videoCodecs: string[]; audioCodecs: string[]; /** The GPU conversions can use and the codecs it encodes; null without one. */ hardware: { device: string; codecs: string[] } | null };
/** How a run of a job went: when, how it ended, and how many files it converted, brought across as they were, or gave up on. */
export type ConvertRun = { task_id: string; started_at: number; finished_at: number | null; status: string; error_message: string | null; scheduled: boolean; bytes: number; converted: number; copied: number; failed: number; /** What the files it converted measured together, before and after. */ size_in: number; size_out: number };
/** What became of one file of a run. `size_out` is what reached the destination; a file that failed has none. */
export type ConvertRunFile = { path: string; status: "converted" | "copied" | "failed"; size_in: number; size_out: number | null };

/** Whether a service lets itself be shown inside Kago, as the server found by asking it; `unknown` when it could not be asked. */
export type FrameVerdict = "allowed" | "blocked" | "unknown";
/** An icon of one of the open icon libraries, as suggested for a name. */
export type LibraryIcon = { source: string; name: string; label: string; /** Whether the icon goes by the very name that was asked for. */ exact: boolean };
/** How a previewer names a file it reads beside the opened one: the opened file's name with the first `replace` swapped for `with`. */
export type CompanionRule = { replace: string; with: string };
/** A previewer as the interface is told of it: what it opens, and the page to frame for it. */
export type PluginPreviewer = { pluginId: string; previewerId: string; extensions: string[]; title: string; src: string; companions: CompanionRule[]; panorama: boolean };

export type CompatibilityStatus = "passed" | "failed" | "unsupported" | "unavailable";
export type CompatibilityOperation = "encode" | "decode";
export type CompatibilityDeviceScope = "device" | "system" | "none";
export type CompatibilityCheck = {
  id: string;
  label: string;
  codec: "H.264" | "HEVC Main 10";
  operation: CompatibilityOperation;
  backend: "CPU" | "NVIDIA NVENC / CUDA" | "VA-API" | "Apple VideoToolbox";
  hardware: boolean;
  status: CompatibilityStatus;
  /** Stable localization key. Never includes a process error, command line, or local path. */
  detail: string;
  durationMs: number | null;
  deviceId: string | null;
  deviceLabel: string | null;
  deviceScope: CompatibilityDeviceScope;
};
export type CompatibilityReport = {
  checkedAt: string;
  ffmpeg: { available: boolean; version: string | null };
  checks: CompatibilityCheck[];
  /** Stable localization keys describing discovery limits; raw process errors are never returned. */
  discoveryNotes?: string[];
};
