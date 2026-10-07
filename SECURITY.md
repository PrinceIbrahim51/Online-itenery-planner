# Security

## Reporting a vulnerability

Please do **not** open a public issue. Email the maintainer privately instead. Include steps to reproduce, and give us reasonable time to fix the issue before you disclose it.

## Security audit

The table below lists every control and where it is implemented. Most controls are also covered by automated regression tests in `test/security.test.js`, so a future change that breaks one makes CI fail.

| # | Requirement | Status | Implementation |
|---|---|---|---|
| 1 | **Hide API keys** | ✅ | The only third-party key (`OPENTRIPMAP_API_KEY`) is read from the server environment and used only in `server/services/opentripmap.js`. The browser never calls third-party APIs. A test asserts that the key never appears in API responses. |
| 2 | **Check env variables** | ✅ | `server/config.js` validates every variable with zod at startup and refuses to start on bad values. Errors name the variable but never echo its value. Production refuses `COOKIE_SECURE=false`, wildcard CORS and non-https origins. `.env` is git-ignored, and `.env.example` holds placeholders only. |
| 3 | **Protect admin routes** | ✅ | `/api/admin/*` is behind `requireAdmin`, which checks the role in the database-backed session on **every** request. Hiding the admin link in the UI is only cosmetic. There are no default admin credentials: admins are created with `npm run create-admin` and need a password of at least 14 characters. Admin accounts cannot be disabled through the API. |
| 4 | **Proper authentication** | ✅ | Server-side sessions: the browser gets a random 256-bit token in an `HttpOnly; SameSite=Strict; Secure` cookie, and the database stores only its SHA-256 hash. Sessions expire (`SESSION_TTL_HOURS`) and are revoked on logout and when an admin disables a user. Login errors are generic, and an unknown email takes the same time as a wrong password (dummy hash), which prevents user enumeration. Accounts lock for 15 minutes after 5 failed attempts. |
| 5 | **Access control** | ✅ | Every trip query is scoped `WHERE user_id = ?`, so one user cannot read or delete another user's trips by guessing IDs (IDOR). Strict schemas reject unknown fields, which blocks mass assignment such as `role: "admin"` at registration. Tests cover both. |
| 6 | **Sanitize forms** | ✅ | All input passes zod schemas with types, ranges and lengths, and `.strict()` rejects unknown keys. Free text is Unicode-normalised, and control characters, bidi overrides and `< > " ' \` \\` are stripped (`server/security/sanitize.js`). The query parser is `simple`, so the query string cannot inject nested objects or arrays (parameter pollution). |
| 7 | **XSS protection** | ✅ | The frontend never uses `innerHTML`: every value is inserted with `textContent` (`public/js/dom.js`). Outbound links must be `https` and on an allow-list of hosts, and they open with `rel="noopener noreferrer"`. A strict CSP (`script-src 'self'`, `object-src 'none'`, `script-src-attr 'none'`, `base-uri 'self'`) applies, with no inline scripts or styles. Input sanitisation adds defence in depth. |
| 8 | **Rate limiting** | ✅ | `/api/*`: 300 requests per 15 minutes per IP. Login and register: 10 failed attempts per 15 minutes. Plan and fare endpoints: 40 per minute. Responses include standard `RateLimit` headers. `TRUST_PROXY` makes the limits see real client IPs. |
| 9 | **Secure API endpoints** | ✅ | Write requests must send `Content-Type: application/json` (otherwise 415). Bodies are capped at 10 kB. Writes from a signed-in session need a per-session **CSRF token** in the `X-CSRF-Token` header, compared in constant time. Responses are `Cache-Control: no-store`. The error handler never returns stack traces or internal messages. There are HTTP server timeouts against slow-loris. |
| 10 | **CORS settings** | ✅ | Same-origin only by default. Cross-origin access needs an exact origin in the `CORS_ORIGINS` allow-list (`*` is rejected), with a fixed list of methods and headers. Unknown origins get no CORS headers. |
| 11 | **Security headers** | ✅ | Helmet sets CSP, HSTS (2 years, preload, production only), `X-Content-Type-Options: nosniff`, `X-Frame-Options` plus `frame-ancestors 'none'`, `Referrer-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`. A restrictive `Permissions-Policy` is also set, and `X-Powered-By` is removed. |
| 12 | **Debug mode off** | ✅ | `npm start` forces `NODE_ENV=production`, and `NODE_ENV` defaults to production when unset. Express runs in production mode, error details are hidden from clients and nothing logs secrets or passwords. |
| 13 | **Update dependencies** | ✅ | All dependencies are on their latest majors (Express 5, Helmet 8, zod 4, express-rate-limit 8), and `npm audit` reports **0 vulnerabilities**. Dependabot opens weekly update PRs, and CI runs `npm audit` on every push plus a weekly scheduled run. |
| 14 | **Remove unused packages** | ✅ | There are 6 runtime dependencies, all used, and **no** dev dependencies. Tests use the built-in `node:test`. SQLite is the built-in `node:sqlite`, and `.env` loading uses the built-in `process.loadEnvFile`. |
| 15 | **Check exposed files** | ✅ | Only `public/` is served, with `dotfiles: 'deny'` and no directory listing. Tests confirm that `/.env`, `/.git/config`, `/package.json`, server sources, the database, `node_modules` and path-traversal attempts all return 404. `robots.txt` excludes `/api/`. |
| 16 | **Secure database** | ✅ | Every query uses prepared statements with bound parameters, so SQL injection is not possible by construction. The database file is created with mode `0600` in a `0700` directory outside `public/`, and is git-ignored. `secure_delete` and foreign keys are on. Password hashes are never selected by any API. |
| 17 | **Hash passwords** | ✅ | scrypt (N=2¹⁷, r=8, p=1, the OWASP baseline) with a 16-byte random salt per password, verified with `timingSafeEqual`. The password policy requires at least 10 characters with letters and digits, rejects common passwords, and rejects passwords that contain the email name. |
| 18 | **Scan git for leaked secrets** | ✅ | `npm run scan:secrets` scans the working tree and **every commit on every branch**. It checks for AWS, Google, GitHub, Slack, Stripe, OpenAI and Anthropic keys, private keys, JWTs, credentialed connection strings, hard-coded secrets and committed `.env`, key or database files. CI also runs **Gitleaks** and **CodeQL** (`security-extended`). |
| 19 | **Full security audit** | ✅ | This document, the automated tests in `test/security.test.js`, and the CI workflow `.github/workflows/security.yml`. |

### Results at the time of writing

```
npm audit            → found 0 vulnerabilities
npm run scan:secrets → ✔ No secrets found (working tree + full git history)
npm test             → all tests pass, including 18 security regression tests
```

## Deployment checklist

1. Serve over **HTTPS** only (TLS-terminating proxy) and keep `COOKIE_SECURE=true`.
2. Set `TRUST_PROXY` to the number of proxies in front of the app.
3. Store secrets in your host's secret manager, not in files in the repo.
4. After running `npm run create-admin`, **remove `ADMIN_PASSWORD`** from the environment.
5. Keep `DATABASE_PATH` on a private volume and back it up encrypted.
6. Run `npm run security:check` before every release.
7. If a secret ever leaks, **rotate it first**, then purge it from history with `git filter-repo`.

## Known limitations

- Fares, prices and timings are estimates from public rate cards, not live quotes.
- Rate-limit counters are kept in memory per process. For several instances, use a shared store such as Redis with `express-rate-limit`.
- There is no email verification or password reset flow yet. Add one with signed, single-use, expiring tokens before a public launch.
