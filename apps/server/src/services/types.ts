export type Role = "ADMIN" | "USER" | "GUEST";

export type User = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  disabled: number;
  created_at: number;
  updated_at: number;
};

export type PublicUser = Omit<User, "password_hash">;

export type Root = {
  id: string;
  slug: string;
  name: string;
  base_path: string;
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
