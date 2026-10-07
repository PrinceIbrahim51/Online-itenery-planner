'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// scrypt parameters (OWASP-recommended minimum: N=2^17, r=8, p=1).
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

/** Hashes a password with a per-password random salt. Format: scrypt$N$r$p$salt$hash */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time password verification. Returns false on any malformed hash. */
async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// A real hash of a random password, used to make "unknown email" logins take
// the same time as "wrong password" logins (prevents user enumeration by timing).
let dummyHashPromise;
function dummyHash() {
  dummyHashPromise ??= hashPassword(crypto.randomBytes(24).toString('base64'));
  return dummyHashPromise;
}

// Small deny-list of the most common passwords; length rules do the rest.
const COMMON = new Set([
  'password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop',
  'iloveyou', 'admin12345', 'welcome123', 'letmein123', 'football123', 'monkey12345',
  'abc1234567', 'qwerty12345', 'passw0rd123', 'india12345', 'princess123',
]);

function passwordProblems(password, email = '') {
  const problems = [];
  if (password.length < 10) problems.push('at least 10 characters');
  if (password.length > 128) problems.push('at most 128 characters');
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) problems.push('letters and numbers');
  if (COMMON.has(password.toLowerCase())) problems.push('not a commonly used password');
  const local = email.split('@')[0];
  if (local && local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) {
    problems.push('must not contain your email name');
  }
  return problems;
}

module.exports = { hashPassword, verifyPassword, dummyHash, passwordProblems };
