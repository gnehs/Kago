export type Role = "ADMIN" | "USER";

export type User = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  disabled: number;
  /** When their profile picture was last set. Null without one. */
  avatar_at: number | null;
  created_at: number;
  updated_at: number;
};

export type PublicUser = Omit<User, "password_hash">;

export type Root = {
  id: string;
  slug: string;
  name: string;
  /** The folder on disk for a local root; empty for a remote one, which has no path of its own. */
  base_path: string;
  /** `local`, or the kind of remote (`smb`, `sftp`, ...) that rclone reaches for it. */
  provider: string;
  /** A remote root's connection settings, sealed. */
  config: string | null;
  readonly: number;
  created_at: number;
  updated_at: number;
};

export type Actor = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  /** When their profile picture was last set, for the ones who are shown: it names the picture to ask for. */
  avatar?: number | null;
};

export type FileRef = {
  rootSlug: string;
  path: string;
};

export type FileTask = {
  id: string;
  type: string;
  status: string;
  created_by: string;
  sources_json: string;
  destination: string | null;
  total_files: number;
  processed_files: number;
  total_bytes: number;
  processed_bytes: number;
  current_path: string | null;
  error_message: string | null;
  auth_snapshot_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};
