'use strict';

const crypto = require('node:crypto');
const { COOKIE_NAME } = require('./sessions');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

/** Attaches req.user / req.csrf when a valid session cookie is present. */
function loadSession(sessions) {
  return async (req, _res, next) => {
    req.user = null;
    req.csrf = null;
    req.sessionToken = null;
    if (!sessions) return next(); // accounts disabled
    try {
      const token = req.cookies?.[COOKIE_NAME];
      const session = token ? await sessions.lookup(token) : null;
      req.user = session?.user ?? null;
      req.csrf = session?.csrf ?? null;
      req.sessionToken = session ? token : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  next();
}

/** Admin routes: must be signed in AND hold the admin role (checked server-side on every request). */
function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'You do not have access to this resource.'));
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for authenticated state-changing requests (defence in depth
 * on top of SameSite=Strict cookies): the per-session token must be echoed in
 * the X-CSRF-Token header, which a cross-site form cannot set.
 */
function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method) || !req.user) return next();
  const sent = req.get('x-csrf-token') || '';
  const a = Buffer.from(sent);
  const b = Buffer.from(req.csrf || '');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new HttpError(403, 'Invalid or missing security token. Please refresh the page.'));
  }
  next();
}

/** Only accept JSON bodies on write requests (blocks form-encoded CSRF/content-sniffing tricks). */
function requireJson(req, _res, next) {
  if (SAFE_METHODS.has(req.method) || req.method === 'DELETE') return next();
  if (!req.is('application/json')) return next(new HttpError(415, 'Content-Type must be application/json.'));
  next();
}

/** Validates req[part] against a zod schema; replaces it with the parsed (sanitised) value. */
function validate(schema, part = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path?.join('.') || part;
      return next(new HttpError(400, `Invalid ${field}: ${issue?.message ?? 'bad input'}`));
    }
    req.valid ??= {};
    req.valid[part] = result.data;
    next();
  };
}

function notFound(_req, _res, next) {
  next(new HttpError(404, 'Not found.'));
}

/** Never leaks stack traces or internal messages to clients. */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let status = Number(err.status || err.statusCode) || 500;
    if (status < 400 || status > 599) status = 500;
    if (err.type === 'entity.too.large') status = 413;
    if (err.type === 'entity.parse.failed') status = 400;

    let message = 'Something went wrong. Please try again.';
    if (err.expose && status < 500) message = err.message;
    else if (status === 413) message = 'Request body too large.';
    else if (status === 400) message = 'Malformed request.';

    if (status >= 500) logger.error(`${req.method} ${req.path} -> ${status}: ${err.message}`);
    res.status(status).json({ error: message });
  };
}

module.exports = {
  HttpError,
  loadSession,
  requireAuth,
  requireAdmin,
  csrfProtection,
  requireJson,
  validate,
  notFound,
  errorHandler,
};
