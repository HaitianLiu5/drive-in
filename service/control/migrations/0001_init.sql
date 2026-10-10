-- Yolo control plane schema (docs/yolo-v1.md §9). Every table carries
-- user_id (decision 5) even though v1 has a single user.
--
-- OAuth clients, grants and tokens are not here: the official
-- @cloudflare/workers-oauth-provider keeps them in the OAUTH_KV namespace,
-- storing tokens and secrets only as hashes.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                -- equals id; kept so every table filters the same way
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                  -- WebAuthn credential id (base64url)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,             -- base64url COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- One-time init codes that have already been used (stored as hashes), so a
-- leaked old code cannot register another passkey (decision 16).
CREATE TABLE init_codes_used (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('car', 'browser', 'phone', 'tv')),
  capabilities TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  address TEXT,
  secret_hash TEXT,
  version TEXT,
  last_seen_at INTEGER
);
CREATE INDEX idx_nodes_user ON nodes(user_id);

CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,                 -- Source JSON: {"kind":"url","url":…} or {"kind":"plex","ratingKey":…}
  title TEXT NOT NULL,
  thumbnail TEXT,
  duration INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  position REAL NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX idx_queue_items_user_position ON queue_items(user_id, position);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_playlists_user ON playlists(user_id);

CREATE TABLE playlist_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  duration INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  position REAL NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX idx_playlist_items_playlist_position ON playlist_items(playlist_id, position);

-- Replaces .play-history.json. Trimmed to the newest 500 rows per user.
CREATE TABLE history (
  user_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  play_count INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_key)
);
CREATE INDEX idx_history_user_updated ON history(user_id, updated_at DESC);

-- Replaces subtitle_preferences. source_key = 'default' holds the latest choice.
CREATE TABLE track_preferences (
  user_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  selection TEXT NOT NULL,              -- {"subtitles":[pref…],"audio":pref|null}
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_key)
);
