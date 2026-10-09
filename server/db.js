'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Async database adapter with two interchangeable backends:
 *   - PostgreSQL when DATABASE_URL is set (production / Vercel, e.g. Neon)
 *   - SQLite (built-in node:sqlite) for local development and tests
 *
 * Every query goes through parameterised statements — SQL is never built by
 * string concatenation with user data. Placeholders are written as `?` and
 * translated to `$1, $2…` for Postgres.
 *
 * Interface: get(sql, ...params) → row | undefined, all() → rows,
 *            run() → { changes }, ready (Promise), close(), kind
 */

const SQLITE_SCHEMA = `
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
`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    disabled        INTEGER NOT NULL DEFAULT 0,
    failed_logins   INTEGER NOT NULL DEFAULT 0,
    locked_until    BIGINT NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token  TEXT NOT NULL,
    expires_at  BIGINT NOT NULL,
    created_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS trips (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    destination TEXT NOT NULL,
    days        INTEGER NOT NULL,
    travelers   INTEGER NOT NULL,
    budget      TEXT NOT NULL,
    created_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
  CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT,
    action     TEXT NOT NULL,
    detail     TEXT,
    ip         TEXT,
    created_at BIGINT NOT NULL
  );
`;

function openSqlite(file) {
  // Loaded lazily so environments without node:sqlite (or that never need it) don't pay for it.
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      fs.chmodSync(path.resolve(file), 0o600); // owner read/write only
    } catch {
      /* not fatal on filesystems without POSIX permissions */
    }
  }
  db.exec(SQLITE_SCHEMA);
  // Migrations: add columns introduced after the first release (idempotent).
  const tripCols = new Set(db.prepare('PRAGMA table_info(trips)').all().map((c) => c.name));
  if (!tripCols.has('start_date')) db.exec('ALTER TABLE trips ADD COLUMN start_date TEXT');
  if (!tripCols.has('custom')) db.exec('ALTER TABLE trips ADD COLUMN custom TEXT');
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    kind: 'sqlite',
    ready: Promise.resolve(),
    async get(sql, ...params) {
      return stmt(sql).get(...params);
    },
    async all(sql, ...params) {
      return stmt(sql).all(...params);
    },
    async run(sql, ...params) {
      const info = stmt(sql).run(...params);
      return { changes: Number(info.changes) };
    },
    async close() {
      db.close();
    },
  };
}

const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

function openPostgres(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => Number(v)); // BIGINT → number (ids, ms timestamps, counts)
  const pool = new Pool({
    connectionString: url,
    max: 3, // serverless-friendly
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  pool.on('error', () => {
    /* idle client errors are retried on next query */
  });
  const ready = pool
    .query(PG_SCHEMA)
    .then(() => pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_date TEXT; ALTER TABLE trips ADD COLUMN IF NOT EXISTS custom TEXT;'));
  ready.catch(() => {});
  const q = async (sql, params) => {
    await ready;
    return pool.query(toPg(sql), params);
  };
  return {
    kind: 'postgres',
    ready,
    async get(sql, ...params) {
      return (await q(sql, params)).rows[0];
    },
    async all(sql, ...params) {
      return (await q(sql, params)).rows;
    },
    async run(sql, ...params) {
      return { changes: (await q(sql, params)).rowCount };
    },
    async close() {
      await pool.end();
    },
  };
}

function openDatabase(config) {
  if (config.databaseUrl) return openPostgres(config.databaseUrl);
  return openSqlite(config.databasePath);
}

module.exports = { openDatabase, openSqlite, PG_SCHEMA, toPg };
