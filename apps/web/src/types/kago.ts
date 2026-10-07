export type Actor = {
  id: string;
  email: string;
  displayName: string;
  role: "ADMIN" | "USER" | "GUEST";
  disabled: boolean;
};

export type Root = {
  id: string;
  slug: string;
  name: string;
  /** `local` for a folder on the server; otherwise the kind of remote it is kept on. */
  provider: string;
  readonly: number;
  created_at: number;
  updated_at: number;
};

export type RemoteField = { key: string; label: string; kind?: "text" | "number" | "secret" | "boolean" | "select"; required?: boolean; placeholder?: string; options?: Array<{ value: string; label: string }> };
export type RemoteProvider = { type: string; label: string; fields: RemoteField[]; path: { label: string; placeholder: string; required: boolean; hint?: string } };
/** A remote location's settings as an administrator sees them: secrets are only named, never sent. */
export type RemoteRoot = Root & { remote: { type: string; base: string; params: Record<string, string>; secrets: string[] } };
export type StorageInfo = { available: boolean; providers: RemoteProvider[]; roots: RemoteRoot[] };

export type SyncEndpoint = { kind: "location"; rootSlug: string; path: string } | { kind: "rsync"; remote: string; port?: number };
export type SyncSchedule = { kind: "interval"; minutes: number } | { kind: "daily"; time: string } | { kind: "weekly"; weekday: number; time: string };
export type SyncJob = {
  id: string;
  name: string;
  source: SyncEndpoint;
  destination: SyncEndpoint;
  options: { mode: "copy" | "mirror"; dryRun: boolean };
  schedule: SyncSchedule | null;
  enabled: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  created_by: string;
};

export type UserAccount = {
  id: string;
  email: string;
  display_name: string;
  role: "ADMIN" | "USER" | "GUEST";
  disabled: number;
  created_at: number;
  updated_at: number;
};

export type Group = {
  id: string;
  name: string;
  members: Array<Pick<UserAccount, "id" | "email" | "display_name">>;
  created_at: number;
  updated_at: number;
};

export type FileWindow = {
  id: string;
  rootSlug: string;
  logicalPath: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  focused: boolean;
  selectedItems: string[];
  scrollTop?: number;
  inspectorOpen?: boolean;
  /** Whether the tree of locations is shown down the left side. Shown unless closed. */
  sidebarOpen?: boolean;
  /** Every folder the window holds open. The one named by `activeTabId` is the one the fields above describe. */
  tabs?: FileTab[];
  activeTabId?: string;
  createdAt: number;
  updatedAt: number;
};

/** A folder kept open in a window alongside the one it is showing. */
export type FileTab = { id: string; rootSlug: string; logicalPath: string };

/** How a folder is shown. It belongs to the folder, not to the window showing it. */
export type FolderView = {
  viewMode: "list" | "grid" | "columns";
  /** How large the icon view draws its items. */
  iconSize: "large" | "medium" | "small";
  sortBy: "name" | "size" | "mtime" | "type";
  sortDirection: "asc" | "desc";
};

/** A window together with the view of the folder it is showing. */
export type FolderWindow = FileWindow & FolderView;

/** What has been set for one folder. Whatever is left out is taken from the folders above it, then from the default. */
export type FolderViewEntry = Partial<FolderView> & {
  rootSlug: string;
  path: string;
  /** Whether the folders inside are shown the same way. */
  recursive: boolean;
  /** What the folder's contents suggested when it was first opened, kept so the view does not change as files come and go. */
  autoMode?: FolderView["viewMode"];
};

/** What a person has set for themselves, kept with their account. */
export type AccountSettings = {
  theme?: "system" | "light" | "dark";
  locale?: string;
  motion?: "on" | "off";
  windowControls?: "left" | "right";
  /** Whether a folder of pictures and videos opens as icons before anyone has said how to show it. On unless turned off. */
  smartView?: boolean;
  defaultView?: Partial<FolderView>;
  /** When the desktop background was last set, which names the picture to ask for. Absent without one. */
  wallpaper?: number | null;
};

export type AccountPreferences = { settings: AccountSettings; folderViews: FolderViewEntry[] };

export type WorkspaceState = {
  activeWindowId: string | null;
  windows: FileWindow[];
  sidebar: { collapsed?: boolean };
  inspector: { open?: boolean; width?: number };
  shelf: { collapsed?: boolean; x?: number; y?: number };
};

export type FileItem = {
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  mtime: number;
  type: string;
  readonly: boolean;
  finderTags?: FinderTag[];
};

export type FileList = {
  rootSlug: string;
  path: string;
  readonly: boolean;
  items: FileItem[];
};

export type SqliteTable = { name: string; type: "table" | "view"; columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean }> };
export type SqliteCell = string | number | null | { blob: number };
/** `total` is null for a database too large to count. */
export type SqlitePage = { columns: string[]; rows: SqliteCell[][]; offset: number; hasMore: boolean; total: number | null };

/** Shooting data read from a picture; every field is there only when the file has it. */
export type ImageMetadata = {
  camera?: string;
  lens?: string;
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
};

export type FileMeta = {
  rootSlug: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  size: number;
  mtime: number;
  type: string;
  finderTags?: FinderTag[];
};

/** A tag set in macOS Finder, read from the file itself. Read-only in Kago. */
export type FinderTag = {
  name: string;
  color: "gray" | "green" | "purple" | "blue" | "yellow" | "red" | "orange" | null;
};

export type Tag = {
  id: string;
  name: string;
  color: string | null;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
};

export type ShareLink = {
  id: string;
  root_id: string;
  path: string;
  permission_json: string;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  has_password: boolean;
  created_by: string;
  disabled: number;
  created_at: number;
  updated_at: number;
};

export type PermissionRule = {
  id: string;
  principal_type: "user" | "group" | "share_link";
  principal_id: string;
  root_id: string;
  path_prefix: string;
  allow_json: string;
  deny_json: string;
  recursive: number;
  created_at: number;
  updated_at: number;
};

export type FileTask = {
  id: string;
  type: string;
  status: string;
  total_files: number;
  processed_files: number;
  total_bytes: number;
  processed_bytes: number;
  destination: string | null;
  current_path: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

export type Shelf = {
  id: string;
  name: string;
  items: Array<{ id: string; root_id: string; root_slug: string; path: string; kind: string; name: string; size: number }>;
};

export type TrashItem = {
  id: string;
  original_root_id: string;
  original_path: string;
  deleted_by: string;
  deleted_at: number;
  restored_at: number | null;
};

export type AuditLog = {
  id: string;
  actor_type: "user" | "share_link" | "system";
  actor_id: string | null;
  action: string;
  root_id: string | null;
  path: string | null;
  target_json: string | null;
  result: "success" | "failure" | "denied";
  ip: string | null;
  user_agent: string | null;
  created_at: number;
};

/** What the server knows about a video, and whether it can transcode it on the fly. */
export type MediaInfo = {
  transcode: boolean;
  duration: number;
  container: string;
  /** Bits per second of the whole file; 0 where a figure is not known, here and for each stream. */
  bitrate: number;
  /**
   * `hdr` names the transfer curve of an HDR picture: PQ (HDR10) or HLG. `level` is as ffprobe gives it
   * (41 for H.264 level 4.1, 153 for HEVC level 5.1); `dolbyVision` is the profile, 0 without it.
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
    hdr: "pq" | "hlg" | null;
    peak: number;
    dolbyVision: number;
  } | null;
  audio: Array<{ codec: string; profile: string; channels: number; layout: string; sampleRate: number; bitrate: number; language: string; title: string; default: boolean }>;
  /** Subtitle streams inside the file. */
  subtitles: Array<{ index: number; codec: string; language: string; title: string; default: boolean; forced: boolean; sdh: boolean }>;
  /** Heights the file can be transcoded to, tallest first. */
  qualities: number[];
  /** What the server encodes with: `software`, or the GPU API in use. */
  encoder: string;
  /** Whether the server can transcode an HDR picture as HDR, for a screen that shows it. */
  hdrOutput: boolean;
  /** Whether the server can tone-map an HDR picture to SDR. */
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
  /** Fonts attached to the video for its own subtitles. */
  fonts: string[];
  /** How many picture subtitles (Blu-ray, DVD) the video has that a browser cannot draw. */
  unsupported: number;
};
