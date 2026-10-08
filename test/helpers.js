'use strict';

const { createApp } = require('../server/app');
const { loadConfig } = require('../server/config');
const { openSqlite } = require('../server/db');

async function startServer(envOverrides = {}, options = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    DATABASE_PATH: ':memory:',
    ...envOverrides,
  });
  const db = openSqlite(':memory:');
  // No network in tests: live place lookups use an injected fake (or none).
  const { app } = createApp(config, { db, overpass: options.overpass ?? null });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, close: () => new Promise((r) => server.close(r)) };
}

/** Minimal cookie-aware client. */
function client(base) {
  let cookie = '';
  let csrf = null;
  async function req(path, { method = 'GET', body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined && !raw) h['Content-Type'] ??= 'application/json';
    const res = await fetch(base + path, {
      method,
      headers: h,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: res.status, headers: res.headers, json, text };
  }
  return {
    req,
    get csrf() {
      return csrf;
    },
    get cookie() {
      return cookie;
    },
  };
}

module.exports = { startServer, client };
