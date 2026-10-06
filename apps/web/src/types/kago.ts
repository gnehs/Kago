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
};

export type FileList = {
  rootSlug: string;
  path: string;
  readonly: boolean;
  items: FileItem[];
};

export type FileMeta = {
  rootSlug: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  size: number;
  mtime: number;
  type: string;
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
