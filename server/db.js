'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Opens the SQLite database and applies the schema.
 * Every query in the app goes through prepared statements with bound
 * parameters — no SQL is ever built by string concatenation.
 */
function openDatabase(file) {
  if (file !== ':memory:') {
    const dir = path.dirname(path.resolve(file));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      fs.chmodSync(path.resolve(file), 0o600); // owner read/write only
    } catch {
      /* not fatal on filesystems without POSIX permissions */
    }
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;

    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name            TEXT NOT NULL,
      password_hash   TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      disabled        INTEGER NOT NULL DEFAULT 0,
      failed_logins   INTEGER NOT NULL DEFAULT 0,
      locked_until    INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token  TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS trips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      destination TEXT NOT NULL,
      days        INTEGER NOT NULL,
      travelers   INTEGER NOT NULL,
      budget      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      action     TEXT NOT NULL,
      detail     TEXT,
      ip         TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

module.exports = { openDatabase };
