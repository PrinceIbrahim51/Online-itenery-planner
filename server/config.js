'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { z } = require('zod');

// Load .env (if present) without a third-party dependency. Real environment
// variables always take precedence over the file.
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def)
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_PATH: z.string().min(1).default('./data/voyagr.db'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(12),
  COOKIE_SECURE: bool('true'),
  OPENTRIPMAP_API_KEY: z.string().default(''),
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Print only the variable names that failed, never their values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  const c = parsed.data;

  const corsOrigins = c.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    let u;
    try {
      u = new URL(origin);
    } catch {
      throw new Error('Invalid environment configuration: CORS_ORIGINS');
    }
    if (origin === '*' || u.origin !== origin) {
      throw new Error('Invalid environment configuration: CORS_ORIGINS must list exact origins');
    }
    if (c.NODE_ENV === 'production' && u.protocol !== 'https:') {
      throw new Error('Invalid environment configuration: CORS_ORIGINS must be https in production');
    }
  }

  if (c.NODE_ENV === 'production' && !c.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production (serve the app over HTTPS).');
  }

  return Object.freeze({
    env: c.NODE_ENV,
    isProd: c.NODE_ENV === 'production',
    isTest: c.NODE_ENV === 'test',
    port: c.PORT,
    host: c.HOST,
    databasePath: c.DATABASE_PATH,
    corsOrigins: Object.freeze(corsOrigins),
    trustProxy: c.TRUST_PROXY,
    sessionTtlMs: c.SESSION_TTL_HOURS * 60 * 60 * 1000,
    cookieSecure: c.COOKIE_SECURE,
    openTripMapKey: c.OPENTRIPMAP_API_KEY,
  });
}

module.exports = { loadConfig };
