import type { FileRef, FileTask as WireFileTask, FileTag, FolderListing, Root, SyncTrialSummary } from "@kago/contract";

export type {
  Actor,
  ArchiveEntry,
  ArchiveListing,
  CompanionRule,
  ConvertRun,
  ConvertRunFile,
  ConvertSupport,
  FileItem,
  FileMeta,
  FileTag,
  FilmRecipe,
  FrameVerdict,
  ImageMetadata,
  LibraryIcon,
  MediaInfo,
  PermissionRule,
  PluginPreviewer,
  ReadyStoryboard,
  Root,
  SqliteCell,
  SqlitePage,
  SqliteTable,
  Storyboard,
  SubtitleList,
  SubtitleTrack,
  SyncChange,
  SyncRun,
  SyncTrial,
  SyncTrialSummary
} from "@kago/contract";

/** A shortcut on the desktop to another service. `icon` is where the picture Kago keeps for it is, when it has one. */
export type ExternalApp = { id: string; name: string; url: string; /** On everyone's desktop. */ shared: boolean; /** Shown in a window of Kago's rather than in a tab of its own. */ embed: boolean; /** The name it signs in with (HTTP Basic), when it has a sign-in; the password stays on the server. */ authUser: string | null; /** Whether the person signed in may change it. */ editable: boolean; icon: string | null; created_at: number; updated_at: number };

export type RemoteField = { key: string; label: string; kind?: "text" | "number" | "secret" | "boolean" | "select"; required?: boolean; placeholder?: string; options?: Array<{ value: string; label: string }> };
export type RemoteProvider = { type: string; label: string; fields: RemoteField[]; path: { label: string; placeholder: string; required: boolean; hint?: string } };
/** A remote location's settings as an administrator sees them: secrets are only named, never sent. */
export type RemoteRoot = Root & { remote: { type: string; base: string; params: Record<string, string>; secrets: string[] } };
/** What the server's own account may do in a local location's folder, by the disk's ownership and mode bits. */
export type LocalAccess = { id: string; readable: boolean; writable: boolean };
export type StorageInfo = { available: boolean; providers: RemoteProvider[]; roots: RemoteRoot[]; /** The account the server runs as; none where the system has no such thing. */ account: { uid: number; gid: number } | null; local: LocalAccess[] };

export type SyncEndpoint = { kind: "location"; rootSlug: string; path: string };
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
  last_trial: SyncTrialSummary | null;
  created_by: string;
};

/** What to make of a file. Only `format` has to be said; the rest is the server's to pick where it is left open. */
export type ConvertSpec = {
  format: string;
  /** The tallest a video may come out, or the longest side of a picture. */
  height: number | null;
  /** Left open, kept as it is, or an encoder by name: the codec, how deep its picture is, and `-hw` for the GPU's. */
  videoCodec: "auto" | "copy" | "av1" | "av1-10" | "av1-hw" | "av1-hw-10" | "h264" | "h264-10" | "h264-hw" | "hevc" | "hevc-10" | "hevc-12" | "hevc-hw" | "hevc-hw-10" | "mpeg4" | "mpeg2" | "vp9" | "vp9-10";
  crf: number | null;
  fps: number | null;
  audioCodec: "auto" | "copy" | "aac" | "opus" | "mp3" | "flac" | "ac3";
  audioBitrate: number | null;
  quality: number | null;
  /** Whether a video is decoded on the server's GPU where it has one that can, and encoded there when the encoder is left open. */
  hardware: boolean;
  /** Whether what is made of a file gets the tags the file has. */
  copyTags: boolean;
};
export type ConvertJobOptions = { keepSmaller: boolean; after: "keep" | "trash" | "delete"; copyOthers: boolean; /** The endings of the names of the files that are converted; null goes by what the format is made from. */ extensions: string[] | null };
/** A folder that converts itself: whatever turns up in `input` comes out in `destination`. */
export type ConvertJob = {
  id: string;
  name: string;
  input: { rootSlug: string; path: string };
  destination: { rootSlug: string; path: string };
  spec: ConvertSpec;
  options: ConvertJobOptions;
  watch: boolean;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  failed: number;
  created_by: string;
};

export type UserAccount = {
  id: string;
  email: string;
  display_name: string;
  role: "ADMIN" | "USER";
  disabled: number;
  /** When their profile picture was last set. Null without one. */
  avatar_at: number | null;
  created_at: number;
  updated_at: number;
  /** False for an account made through single sign-on that has not been given a password. */
  has_password: boolean;
  identities: SsoIdentity[];
};

/** Who a user is to the identity provider: its issuer and their subject there. */
export type SsoIdentity = {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  createdAt: number;
  lastLoginAt: number | null;
};

/** What the sign-in page knows of single sign-on; `name` is what to call the provider, and may be empty. */
export type SsoInfo = { name: string; autoRedirect: boolean };

/** How single sign-on is set up, as an administrator sees it. The client secret is never sent back. */
export type SsoConfig = {
  enabled: boolean;
  name: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  publicUrl: string;
  redirectUri: string | null;
  scopes: string;
  autoCreate: boolean;
  autoRedirect: boolean;
  syncGroups: boolean;
  groupsClaim: string;
  groupMappings: Array<{ external: string; groupId: string }>;
};

export type Group = {
  id: string;
  name: string;
  members: Array<Pick<UserAccount, "id" | "email" | "display_name" | "avatar_at">>;
  created_at: number;
  updated_at: number;
};

/** A folder open in a tab of a file window, and what is selected in it. */
export type FolderTab = {
  id: string;
  rootSlug: string;
  logicalPath: string;
  selectedItems: string[];
};

/** What a file window shows, which lives in its active tab and nowhere else. */
type Shown = "rootSlug" | "logicalPath" | "selectedItems" | "title" | "focused";

/**
 * A file window as the store keeps it. The folder it shows is its active tab; the window has no copy of it to fall
 * out of step, and the focus is the window in front, so it has no flag for that either.
 */
export type FileWindowState = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  scrollTop?: number;
  inspectorOpen?: boolean;
  /** Whether the tree of locations is shown down the left side. Shown unless closed. */
  sidebarOpen?: boolean;
  /** Every folder the window holds open, never none. The one named by `activeTabId` is the one it shows. */
  tabs: FolderTab[];
  activeTabId: string;
  createdAt: number;
  updatedAt: number;
} & { [K in Shown]?: never };

/** A file window as it is read: its state, and the folder of its active tab with what is selected there. */
export type FileWindow = Omit<FileWindowState, Shown> & Pick<FolderTab, "rootSlug" | "logicalPath" | "selectedItems">;

/**
 * A file window as the server keeps it, and as every client reads and writes it: the folder it shows is written out
 * on the window, and again in its active tab.
 */
export type SavedFileWindow = Omit<FileWindowState, Shown | "tabs" | "activeTabId"> & {
  rootSlug: string;
  logicalPath: string;
  title: string;
  focused: boolean;
  selectedItems: string[];
  /** Missing in a window saved before there were tabs. */
  tabs?: SavedTab[];
  activeTabId?: string;
};

/** A tab of a saved window. The active one has no selection of its own; it is the window's. */
export type SavedTab = {
  id: string;
  rootSlug: string;
  logicalPath: string;
  selectedItems?: string[];
};

/** How a folder is shown. It belongs to the folder, not to the window showing it. */
export type FolderView = {
  viewMode: "list" | "grid" | "columns";
  /** How large the icon view draws its items. */
  iconSize: "large" | "medium" | "small";
  sortBy: "name" | "size" | "mtime" | "type";
  sortDirection: "asc" | "desc";
};

/** A window together with the view of the folder it is showing, and the name that folder goes by. */
export type FolderWindow = FileWindow & FolderView & { title: string };

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
  /** The tags kept at hand to put on files. Only its owner writes it. */
  tags?: ListedTag[];
  /** When the desktop background was last set, which names the picture to ask for. Absent without one. */
  wallpaper?: number | null;
};

/** A folder a person keeps at hand, in the order they added it. */
export type FavoriteFolder = { rootSlug: string; path: string };

export type AccountPreferences = { settings: AccountSettings; folderViews: FolderViewEntry[]; favorites: FavoriteFolder[] };

/** The desktop as the server keeps it. Only file windows are saved. */
export type WorkspaceState = {
  activeWindowId: string | null;
  windows: SavedFileWindow[];
  sidebar: { collapsed?: boolean; width?: number };
  inspector: { open?: boolean; width?: number };
  shelf: { collapsed?: boolean; x?: number; y?: number };
};

export type FileList = FolderListing & {
  /** Whether the folder is still being read, and these are only the items that have arrived so far. */
  partial: boolean;
};

/** Everything inside a folder, however deep: the bytes of its files, and how many files there are. */
export type FolderSize = { bytes: number; count: number };

export type TagShape = "circle" | "triangle" | "diamond" | "square" | "pentagon" | "hexagon" | "star";

/** A tag in a person's own list. The shape is theirs: without one, the tag is drawn in the shape of its colour. */
export type ListedTag = FileTag & { shape?: TagShape };

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

/**
 * A task as the client holds it: the wire row with its JSON read once, at the boundary (`parseTask`).
 * `destination` is the place the task puts its result, which is all the client reads of the destination JSON: a folder,
 * or for a compress the archive written. It is null for a task with none, such as a sync, whose endpoints are in the job.
 */
export type FileTask = Omit<WireFileTask, "sources_json" | "destination" | "auth_snapshot_json"> & {
  sources: FileRef[];
  destination: FileRef | null;
  /** Bytes a second while it runs. Worked out here from one fetch of the list to the next; the server does not send it. */
  speed?: number;
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
