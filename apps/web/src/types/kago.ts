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

export type FileTask = {
  id: string;
  type: string;
  status: string;
  total_files: number;
  processed_files: number;
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
  trash_path: string;
  deleted_by: string;
  deleted_at: number;
  restored_at: number | null;
};
