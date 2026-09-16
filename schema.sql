-- ChurchMouse Music - D1 Schema
-- Run with: wrangler d1 execute churchmouse-db --file=schema.sql

PRAGMA foreign_keys = ON;

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','content_manager','reader')),
  password_hash TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  reset_token TEXT,
  reset_token_expires INTEGER,
  -- Unix seconds of the last successful sign-in; NULL until the user has one.
  -- Existing databases get this via migrations/001_add_users_last_login_at.sql,
  -- since the CREATE TABLE above is IF NOT EXISTS and will not alter them.
  last_login_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─── Music Master (Parent) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS music_master (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title       TEXT NOT NULL,
  description TEXT,
  keywords    TEXT,
  melody      TEXT,
  composer    TEXT,
  notes       TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_master_title     ON music_master(title);
CREATE INDEX IF NOT EXISTS idx_master_composer  ON music_master(composer);

-- Full-text search virtual table for music_master
CREATE VIRTUAL TABLE IF NOT EXISTS music_master_fts USING fts5(
  id UNINDEXED,
  title,
  description,
  keywords,
  melody,
  composer,
  content='music_master',
  content_rowid='rowid'
);

-- ─── PDF Detail (Child) ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pdf_detail (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  master_id   TEXT NOT NULL REFERENCES music_master(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  key_signature TEXT,
  file_name   TEXT NOT NULL,
  r2_key      TEXT NOT NULL,          -- R2 object key (storage path)
  file_size   INTEGER,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_pdf_master   ON pdf_detail(master_id);
CREATE INDEX IF NOT EXISTS idx_pdf_filename ON pdf_detail(file_name);

-- Full-text search for pdf_detail (description + file_name)
CREATE VIRTUAL TABLE IF NOT EXISTS pdf_detail_fts USING fts5(
  id UNINDEXED,
  master_id UNINDEXED,
  description,
  file_name,
  content='pdf_detail',
  content_rowid='rowid'
);

-- ─── Playlists ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title       TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public   INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,        -- unix timestamp
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_playlist_owner  ON playlists(owner_id);
CREATE INDEX IF NOT EXISTS idx_playlist_public ON playlists(is_public);

-- ─── Playlist Items ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playlist_items (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  playlist_id   TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  pdf_detail_id TEXT NOT NULL REFERENCES pdf_detail(id) ON DELETE CASCADE,
  display_desc  TEXT,                  -- user-overrideable description
  sort_order    INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_pli_playlist ON playlist_items(playlist_id, sort_order);

-- ─── FTS Sync Triggers ────────────────────────────────────────────────────────

-- music_master FTS triggers
CREATE TRIGGER IF NOT EXISTS music_master_ai AFTER INSERT ON music_master BEGIN
  INSERT INTO music_master_fts(rowid, id, title, description, keywords, melody, composer)
  VALUES (new.rowid, new.id, new.title, new.description, new.keywords, new.melody, new.composer);
END;

CREATE TRIGGER IF NOT EXISTS music_master_au AFTER UPDATE ON music_master BEGIN
  INSERT INTO music_master_fts(music_master_fts, rowid, id, title, description, keywords, melody, composer)
  VALUES ('delete', old.rowid, old.id, old.title, old.description, old.keywords, old.melody, old.composer);
  INSERT INTO music_master_fts(rowid, id, title, description, keywords, melody, composer)
  VALUES (new.rowid, new.id, new.title, new.description, new.keywords, new.melody, new.composer);
END;

CREATE TRIGGER IF NOT EXISTS music_master_ad AFTER DELETE ON music_master BEGIN
  INSERT INTO music_master_fts(music_master_fts, rowid, id, title, description, keywords, melody, composer)
  VALUES ('delete', old.rowid, old.id, old.title, old.description, old.keywords, old.melody, old.composer);
END;

-- pdf_detail FTS triggers
CREATE TRIGGER IF NOT EXISTS pdf_detail_ai AFTER INSERT ON pdf_detail BEGIN
  INSERT INTO pdf_detail_fts(rowid, id, master_id, description, file_name)
  VALUES (new.rowid, new.id, new.master_id, new.description, new.file_name);
END;

CREATE TRIGGER IF NOT EXISTS pdf_detail_au AFTER UPDATE ON pdf_detail BEGIN
  INSERT INTO pdf_detail_fts(pdf_detail_fts, rowid, id, master_id, description, file_name)
  VALUES ('delete', old.rowid, old.id, old.master_id, old.description, old.file_name);
  INSERT INTO pdf_detail_fts(rowid, id, master_id, description, file_name)
  VALUES (new.rowid, new.id, new.master_id, new.description, new.file_name);
END;

CREATE TRIGGER IF NOT EXISTS pdf_detail_ad AFTER DELETE ON pdf_detail BEGIN
  INSERT INTO pdf_detail_fts(pdf_detail_fts, rowid, id, master_id, description, file_name)
  VALUES ('delete', old.rowid, old.id, old.master_id, old.description, old.file_name);
END;

-- ─── Seed: Default Admin User ─────────────────────────────────────────────────
-- Password: Admin@1234  (bcrypt hash — change immediately after first login)
-- Generate fresh hash with: node -e "const bcrypt=require('bcryptjs'); bcrypt.hash('Admin@1234',10).then(console.log)"
INSERT OR IGNORE INTO users (id, email, name, role, password_hash)
VALUES (
  'admin-000000000000000000000000000000',
  'admin@churchmouse.co.za',
  'Administrator',
  'admin',
  '$2a$10$placeholder_replace_with_real_bcrypt_hash_of_Admin1234'
);
