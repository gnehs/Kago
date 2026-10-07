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
  readonly: number;
  created_at: number;
  updated_at: number;
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
  viewMode: "list" | "grid" | "columns";
  sortBy: "name" | "size" | "mtime" | "type";
  sortDirection: "asc" | "desc";
  selectedItems: string[];
  scrollTop?: number;
  inspectorOpen?: boolean;
  createdAt: number;
  updatedAt: number;
};

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
  video: { codec: string; profile: string; width: number; height: number; bitDepth: number } | null;
  audio: Array<{ codec: string; channels: number; language: string; title: string }>;
  /** Heights the file can be transcoded to, tallest first. */
  qualities: number[];
  /** What the server encodes with: `software`, or the GPU API in use. */
  encoder: string;
};

/** A subtitle for a video: a file lying next to it, or a text stream inside it. */
export type SubtitleTrack = {
  id: string;
  /** Where its text is read from. */
  url: string;
  embedded: boolean;
  format: "ass" | "srt";
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
