CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  disabled INTEGER NOT NULL DEFAULT 0,
  -- When their profile picture was last set, which names the picture to ask for. Null without one.
  avatar_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  -- A session begun through the identity provider: which identity it was, the sealed token that asks the provider
  -- whether it still stands, and when that was last asked.
  identity_id TEXT,
  oidc_refresh TEXT,
  oidc_checked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Who a user is to an identity provider. The issuer and its subject together name one person; an email only brings
-- an identity to its account the first time, and only when the provider has verified it.
CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (issuer, subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user
ON user_identities(user_id);

-- Settings of the whole installation, one row each.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  -- `oidc` for a membership the identity provider's groups brought about, which they may also take away again.
  source TEXT,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roots (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  config TEXT,
  readonly INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path_prefix TEXT NOT NULL,
  level TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permission_rules_lookup
ON permission_rules(principal_type, principal_id, root_id, path_prefix);

CREATE TABLE IF NOT EXISTS user_workspaces (
  user_id TEXT PRIMARY KEY,
  windows_json TEXT NOT NULL,
  active_window_id TEXT,
  sidebar_json TEXT,
  inspector_json TEXT,
  shelf_json TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  destination TEXT,
  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,
  processed_bytes INTEGER DEFAULT 0,
  current_path TEXT,
  error_message TEXT,
  auth_snapshot_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  -- Cleared from the task list, and kept only because a sync job still reads its last run from it.
  cleared INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created
ON tasks(status, created_at);

-- What a run of a sync changed, or what a trial run would have: of a real run only the counts.
CREATE TABLE IF NOT EXISTS task_reports (
  task_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shelves (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shelf_items (
  id TEXT PRIMARY KEY,
  shelf_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER,
  added_at INTEGER NOT NULL,
  FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
);

-- Shortcuts on the desktop to other services. One without an owner is everyone's, and an administrator's to change.
CREATE TABLE IF NOT EXISTS external_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon_type TEXT,
  icon_version INTEGER,
  -- Shown in a frame inside a window of Kago's, rather than in a tab of its own.
  embed INTEGER NOT NULL DEFAULT 0,
  -- How to sign in to a service that asks with the browser's own box (HTTP Basic): the name, and the password sealed.
  auth_user TEXT,
  auth_secret TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_external_apps_owner
ON external_apps(owner_id, created_at);

-- Where each person put each shortcut on their own desktop. One nobody has placed yet comes after the ones that were.
CREATE TABLE IF NOT EXISTS external_app_positions (
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES external_apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_tags (
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (root_id, path, tag_id),
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  permission_json TEXT NOT NULL,
  expires_at INTEGER,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created_by TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Who has already been counted against a link's limit, so that looking again does not count again.
CREATE TABLE IF NOT EXISTS share_visits (
  share_id TEXT NOT NULL,
  visitor TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, visitor),
  FOREIGN KEY (share_id) REFERENCES share_links(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trash_items (
  id TEXT PRIMARY KEY,
  original_root_id TEXT NOT NULL,
  original_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  restored_at INTEGER,
  FOREIGN KEY (original_root_id) REFERENCES roots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  root_id TEXT,
  path TEXT,
  target_json TEXT,
  result TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_task_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- How the earlier runs of a sync job ended, kept after their tasks are forgotten.
CREATE TABLE IF NOT EXISTS sync_runs (
  task_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  scheduled INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  FOREIGN KEY (job_id) REFERENCES sync_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_job_started
ON sync_runs(job_id, started_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folder_views (
  user_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  view_mode TEXT,
  auto_mode TEXT,
  icon_size TEXT,
  sort_by TEXT,
  sort_direction TEXT,
  recursive INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, root_id, path),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS archive_passwords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_archive_passwords_user
ON archive_passwords(user_id, created_at);
