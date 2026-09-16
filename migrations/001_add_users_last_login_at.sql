-- Adds the last successful sign-in timestamp to existing databases.
--
-- schema.sql declares this column too, but its CREATE TABLE is IF NOT EXISTS,
-- so re-running that file leaves an existing users table untouched. This is the
-- path for a database that already holds data.
--
-- Unix seconds, matching created_at/updated_at. NULL means the user has not
-- signed in since the column was added, which the admin screen shows as "Never".
--
-- Safe to run once. SQLite has no ADD COLUMN IF NOT EXISTS, so a second run
-- fails with "duplicate column name: last_login_at" — that error means it is
-- already applied, not that anything broke.

ALTER TABLE users ADD COLUMN last_login_at INTEGER;
