'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');

const { openDatabase } = require('./db');
const { createSessionStore } = require('./security/sessions');
const {
  loadSession,
  csrfProtection,
  requireJson,
  notFound,
  errorHandler,
  HttpError,
} = require('./security/middleware');
const { authRouter } = require('./routes/auth');
const { planRouter } = require('./routes/plan');
const { tripsRouter } = require('./routes/trips');
const { adminRouter } = require('./routes/admin');
const { createOpenTripMap } = require('./services/opentripmap');
const { createOverpass } = require('./services/overpass');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createLogger(config) {
  const quiet = config.isTest;
  return {
    info: (m) => !quiet && console.log(`[info] ${m}`),
    warn: (m) => !quiet && console.warn(`[warn] ${m}`),
    error: (m) => !quiet && console.error(`[error] ${m}`),
  };
}

function createApp(config, { db, openTripMap, overpass } = {}) {
  const logger = createLogger(config);
  // Accounts need persistent storage; without it (e.g. Vercel with no DATABASE_URL) the
  // planner still works and every account route answers 503.
  const database = config.accountsEnabled ? (db ?? openDatabase(config)) : null;
  const sessions = database ? createSessionStore(database, config.sessionTtlMs) : null;
  const otm = openTripMap ?? (config.openTripMapKey ? createOpenTripMap(config.openTripMapKey) : null);
  const places = overpass === undefined ? createOverpass({ logger }) : overpass;

  const audit = async (req, action, detail = null, userId = req.user?.id ?? null) => {
    if (!database) return;
    await database.run(
      'INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)',
      userId,
      action,
      detail ? String(detail).slice(0, 200) : null,
      req.ip ?? null,
      Date.now()
    );
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy); // correct client IPs for rate limiting behind a proxy
  app.set('env', config.isProd ? 'production' : config.env); // never run Express in debug mode in prod
  app.set('query parser', 'simple'); // no nested objects/arrays from query strings

  // Vercel's rewrite to the single API function can append the matched route as a
  // `path` query parameter. Strip it so strict query validation sees only client params.
  if (config.onVercel) {
    app.use((req, _res, next) => {
      const i = req.url.indexOf('?');
      if (i !== -1) {
        const params = new URLSearchParams(req.url.slice(i + 1));
        if (params.has('path')) {
          params.delete('path');
          const qs = params.toString();
          req.url = req.url.slice(0, i) + (qs ? `?${qs}` : '');
        }
      }
      next();
    });
  }

  // ---------- Security headers ----------
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          scriptSrcAttr: ["'none'"],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      strictTransportSecurity: config.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      xFrameOptions: { action: 'deny' },
      crossOriginEmbedderPolicy: false, // allow Google Fonts
    })
  );
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    next();
  });

  // ---------- CORS: same-origin by default, explicit allow-list otherwise ----------
  const allowed = new Set(config.corsOrigins);
  app.use(
    '/api',
    cors({
      origin(origin, cb) {
        if (!origin || allowed.has(origin)) return cb(null, true);
        return cb(null, false); // no CORS headers → browser blocks the response
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      maxAge: 600,
    })
  );

  // ---------- Rate limiting ----------
  const limiterOpts = {
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'Too many requests — please slow down and try again shortly.')),
  };
  app.use('/api', rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, limit: 300 }));
  const authLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true });
  const planLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, limit: 40 });

  // ---------- Parsing (strict size limits) ----------
  app.use('/api', express.json({ limit: '10kb', strict: true }));
  app.use(cookieParser());

  // ---------- API ----------
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', loadSession(sessions), requireJson, csrfProtection);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRouter({ db: database, sessions, config, audit, authLimiter }));
  app.use('/api', planRouter({ openTripMap: otm, overpass: places, logger, planLimiter }));
  app.use('/api/trips', tripsRouter({ db: database, audit }));
  app.use('/api/admin', adminRouter({ db: database, sessions, audit }));
  app.use('/api', notFound);

  // ---------- Static frontend (only the public/ folder is ever served) ----------
  app.use(
    express.static(PUBLIC_DIR, {
      dotfiles: 'deny', // never serve .env, .git, etc.
      index: 'index.html',
      redirect: false,
      maxAge: config.isProd ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      },
    })
  );
  app.use(notFound);
  app.use(errorHandler(logger));

  // Periodically clear expired sessions (long-running servers; serverless instances are short-lived).
  if (sessions && !config.onVercel) {
    const timer = setInterval(() => sessions.purgeExpired().catch((e) => logger.warn(e.message)), 60 * 60 * 1000);
    timer.unref();
  }

  return { app, db: database, logger };
}

module.exports = { createApp };
