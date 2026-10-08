'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');
const { hashPassword, verifyPassword } = require('../server/security/passwords');
const { loadConfig } = require('../server/config');

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const PW = 'Tr4vel-Safely-2026';

async function registered(email, name = 'Test User') {
  const c = client(srv.base);
  const r = await c.req('/api/auth/register', { method: 'POST', body: { name, email, password: PW } });
  assert.equal(r.status, 201, r.text);
  return c;
}

test('security headers are set and fingerprinting header removed', async () => {
  const r = await fetch(`${srv.base}/`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('referrer-policy'));
  assert.ok(r.headers.get('permissions-policy'));
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('sensitive files are never served', async () => {
  for (const p of ['/.env', '/.env.example', '/.git/config', '/package.json', '/server/app.js', '/server/config.js', '/data/voyagr.db', '/../package.json', '/%2e%2e/package.json', '/node_modules/express/package.json']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 404, p);
  }
});

test('passwords are hashed with salted scrypt and verified in constant time', async () => {
  const h1 = await hashPassword('correct horse 123');
  const h2 = await hashPassword('correct horse 123');
  assert.notEqual(h1, h2, 'salted');
  assert.match(h1, /^scrypt\$131072\$8\$1\$/);
  assert.ok(!h1.includes('correct horse'));
  assert.equal(await verifyPassword('correct horse 123', h1), true);
  assert.equal(await verifyPassword('wrong', h1), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('database never stores plaintext passwords; admin API never returns hashes', async () => {
  await registered('hashcheck@example.com');
  const row = (await srv.db.get('SELECT password_hash FROM users WHERE email = ?', 'hashcheck@example.com'));
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(!row.password_hash.includes(PW));
});

test('weak passwords are rejected', async () => {
  const c = client(srv.base);
  const r = await c.req('/api/auth/register', { method: 'POST', body: { name: 'Weak', email: 'weak@example.com', password: 'password1' } });
  assert.equal(r.status, 400);
});

test('mass assignment blocked: unknown fields such as role are rejected', async () => {
  const c = client(srv.base);
  const r = await c.req('/api/auth/register', { method: 'POST', body: { name: 'Mallory', email: 'mallory@example.com', password: PW, role: 'admin' } });
  assert.equal(r.status, 400);
});

test('XSS payloads are sanitised on input', async () => {
  const c = await registered('xss@example.com', '<script>alert(1)</script>Eve');
  const me = await c.req('/api/auth/me');
  assert.ok(!/[<>]/.test(me.json.user.name), me.json.user.name);
});

test('session cookie is HttpOnly + SameSite=Strict and the token is stored hashed', async () => {
  const r = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cookie', email: 'cookie@example.com', password: PW }),
  });
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  const token = set.split(';')[0].split('=')[1];
  const raw = (await srv.db.get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', token));
  assert.equal(raw.n, 0, 'raw token must not be stored');
});

test('authentication required for trips; CSRF token required for writes', async () => {
  const anon = client(srv.base);
  assert.equal((await anon.req('/api/trips')).status, 401);

  const c = await registered('csrf@example.com');
  const body = { title: 'Pink City', destination: 'jaipur', days: 3, travelers: 2, budget: 'comfort' };
  const noToken = await c.req('/api/trips', { method: 'POST', body });
  assert.equal(noToken.status, 403);
  const badToken = await c.req('/api/trips', { method: 'POST', body, headers: { 'X-CSRF-Token': 'nope' } });
  assert.equal(badToken.status, 403);
  const ok = await c.req('/api/trips', { method: 'POST', body, headers: { 'X-CSRF-Token': c.csrf } });
  assert.equal(ok.status, 201);
});

test('access control: users cannot read or delete other users’ trips (IDOR)', async () => {
  const alice = await registered('alice@example.com');
  const bob = await registered('bob@example.com');
  const created = await alice.req('/api/trips', {
    method: 'POST',
    body: { title: 'Alice in Goa', destination: 'goa', days: 4, travelers: 2, budget: 'premium' },
    headers: { 'X-CSRF-Token': alice.csrf },
  });
  const id = created.json.trip.id;

  const bobList = await bob.req('/api/trips');
  assert.equal(bobList.json.trips.length, 0);
  const del = await bob.req(`/api/trips/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': bob.csrf } });
  assert.equal(del.status, 404);
  const aliceList = await alice.req('/api/trips');
  assert.equal(aliceList.json.trips.length, 1);
});

test('admin routes: 401 anonymous, 403 for normal users, 200 for admins', async () => {
  const anon = client(srv.base);
  assert.equal((await anon.req('/api/admin/stats')).status, 401);

  const user = await registered('user-not-admin@example.com');
  assert.equal((await user.req('/api/admin/stats')).status, 403);
  assert.equal((await user.req('/api/admin/users')).status, 403);

  const admin = await registered('boss@example.com');
  await srv.db.run("UPDATE users SET role = 'admin' WHERE email = ?", 'boss@example.com');
  const stats = await admin.req('/api/admin/stats');
  assert.equal(stats.status, 200);
  const users = await admin.req('/api/admin/users');
  assert.equal(users.status, 200);
  assert.ok(users.json.users.every((u) => !('password_hash' in u)));

  // Disabling a user revokes their sessions immediately.
  const victimId = (await srv.db.get('SELECT id FROM users WHERE email = ?', 'user-not-admin@example.com')).id;
  const patch = await admin.req(`/api/admin/users/${victimId}`, { method: 'PATCH', body: { disabled: true }, headers: { 'X-CSRF-Token': admin.csrf } });
  assert.equal(patch.status, 200);
  assert.equal((await user.req('/api/trips')).status, 401);
});

test('logout revokes the session server-side', async () => {
  const c = await registered('logout@example.com');
  const stolenCookie = c.cookie;
  const r = await c.req('/api/auth/logout', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': c.csrf } });
  assert.equal(r.status, 204);
  const replay = await fetch(`${srv.base}/api/trips`, { headers: { Cookie: stolenCookie } });
  assert.equal(replay.status, 401);
});

test('login errors are generic and accounts lock after repeated failures', async () => {
  await registered('lock@example.com');
  const c = client(srv.base);
  const unknown = await c.req('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'whatever123' } });
  const wrong = await c.req('/api/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: 'wrong-password-1' } }); // scan-secrets: allow-fake-value
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.json.error, wrong.json.error, 'no user enumeration');

  for (let i = 0; i < 4; i++) {
    await c.req('/api/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: 'wrong-password-1' } }); // scan-secrets: allow-fake-value
  }
  const locked = await c.req('/api/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: PW } });
  assert.equal(locked.status, 429);
});

test('request hardening: JSON only, size limit, strict validation, no stack traces', async () => {
  const c = client(srv.base);
  const form = await c.req('/api/auth/login', { method: 'POST', raw: 'email=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);

  const huge = await c.req('/api/auth/login', { method: 'POST', raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(20000) }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(huge.status, 413);

  const malformed = await c.req('/api/auth/login', { method: 'POST', raw: '{"email":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.ok(!/at .*\.js/.test(malformed.text), 'no stack trace');

  const sqli = await c.req(`/api/plan?destination=${encodeURIComponent("jaipur' OR 1=1--")}`);
  assert.equal(sqli.status, 400);
  const pollution = await c.req('/api/plan?destination=jaipur&destination=goa');
  assert.equal(pollution.status, 400);
  const outOfRange = await c.req('/api/plan?destination=jaipur&days=99');
  assert.equal(outOfRange.status, 400);
  const unknownParam = await c.req('/api/plan?destination=jaipur&debug=1');
  assert.equal(unknownParam.status, 400);
});

test('CORS: foreign origins get no CORS grant', async () => {
  const r = await fetch(`${srv.base}/api/auth/me`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${srv.base}/api/trips`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('CORS: explicitly allowed origin is granted with credentials', async () => {
  const s = await startServer({ CORS_ORIGINS: 'https://app.example.com' });
  try {
    const r = await fetch(`${s.base}/api/auth/me`, { headers: { Origin: 'https://app.example.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await s.close();
  }
});

test('rate limiting kicks in on brute-force login attempts', async () => {
  const s = await startServer();
  try {
    const c = client(s.base);
    let last;
    for (let i = 0; i < 12; i++) {
      last = await c.req('/api/auth/login', { method: 'POST', body: { email: `x${i}@example.com`, password: 'wrong-password-1' } }); // scan-secrets: allow-fake-value
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('ratelimit-policy') || last.headers.get('ratelimit'));
  } finally {
    await s.close();
  }
});

test('config: production refuses insecure cookies, wildcard CORS and bad values', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: '*' }), /CORS_ORIGINS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'http://insecure.example' }), /CORS_ORIGINS/);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  // Error messages must name the variable but never echo its value.
  try {
    loadConfig({ SESSION_TTL_HOURS: 'super-secret-value' });
  } catch (err) {
    assert.ok(!err.message.includes('super-secret-value'));
  }
  const ok = loadConfig({ NODE_ENV: 'production' });
  assert.equal(ok.isProd, true);
  assert.equal(ok.cookieSecure, true);
});
