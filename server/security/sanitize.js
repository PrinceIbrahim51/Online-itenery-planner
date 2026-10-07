'use strict';

const { z } = require('zod');

/**
 * Input sanitisation. All user text is:
 *  - Unicode-normalised, trimmed and length-limited
 *  - stripped of control characters and HTML-significant characters (< > ` and quotes)
 * The frontend additionally renders every value with textContent (never innerHTML),
 * so even data that slipped through could not execute as script.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g;
const HTML_CHARS = /[<>`"'\\]/g;

function cleanText(value) {
  return String(value).normalize('NFKC').replace(CONTROL, ' ').replace(HTML_CHARS, '').replace(/\s+/g, ' ').trim();
}

const safeText = (min, max) =>
  z
    .string()
    .max(max * 4) // reject absurd payloads before doing any work
    .transform(cleanText)
    .pipe(z.string().min(min, `must be at least ${min} characters`).max(max, `must be at most ${max} characters`));

const email = z
  .string()
  .max(254)
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.email('must be a valid email address'));

// Passwords are never sanitised (that would silently change them) — only bounded.
const password = z.string().min(1).max(128);

const slug = z
  .string()
  .max(60)
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9 -]{0,58}$/, 'contains unsupported characters'));

const intIn = (min, max) => z.coerce.number().int().min(min).max(max);

module.exports = { cleanText, safeText, email, password, slug, intIn };
