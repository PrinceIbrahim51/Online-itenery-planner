'use strict';

/**
 * Scans the working tree AND the full git history for leaked secrets.
 * Dependency-free; complements the Gitleaks GitHub Action in CI.
 *
 *   npm run scan:secrets
 *
 * Exit code 1 if anything suspicious is found.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const RULES = [
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe secret key', /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
  ['OpenAI / Anthropic key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['Connection string with password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/]+:[^\s@/]{3,}@/i],
  [
    'Hard-coded secret assignment',
    /\b(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)\b\s*[:=]\s*['"][^'"\s$<{]{12,}['"]/i,
  ],
];

const SENSITIVE_FILES = [/(^|\/)\.env(\..+)?$/, /\.(pem|key|p12|pfx)$/, /(^|\/)id_(rsa|ed25519|ecdsa)$/, /\.(db|sqlite3?)$/];
const ALLOWED_FILES = new Set(['.env.example', 'scripts/scan-secrets.js', '.gitleaks.toml']);

// Put this marker in a comment on a line holding an obviously fake test value.
const ALLOW_MARKER = 'scan-secrets: allow-fake-value';

const findings = [];

function scanText(label, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.length > 2000 || line.includes(ALLOW_MARKER)) return;
    for (const [name, re] of RULES) {
      if (re.test(line)) findings.push(`${label}:${i + 1}  ${name}`);
    }
  });
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// 1) Files tracked or about to be committed
let files = [];
try {
  files = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean);
} catch {
  console.error('Not a git repository — scanning skipped.');
  process.exit(0);
}
for (const f of files) {
  if (ALLOWED_FILES.has(f)) continue;
  if (SENSITIVE_FILES.some((re) => re.test(f))) findings.push(`${f}  sensitive file is tracked by git`);
  const full = path.join(ROOT, f);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
  scanText(f, fs.readFileSync(full, 'utf8'));
}

// 2) Full history: every added line in every commit on every branch
let history = '';
try {
  history = git(['log', '--all', '-p', '--no-color', '--unified=0', '--format=commit %H']);
} catch {
  /* no commits yet */
}
let commit = '';
let file = '';
for (const line of history.split('\n')) {
  if (line.startsWith('commit ')) commit = line.slice(7, 15);
  else if (line.startsWith('+++ b/')) {
    file = line.slice(6);
    if (!ALLOWED_FILES.has(file) && SENSITIVE_FILES.some((re) => re.test(file))) {
      findings.push(`history ${commit} ${file}  sensitive file was committed`);
    }
  } else if (line.startsWith('+') && !line.startsWith('+++') && !ALLOWED_FILES.has(file) && !line.includes(ALLOW_MARKER)) {
    for (const [name, re] of RULES) {
      if (re.test(line)) findings.push(`history ${commit} ${file}  ${name}`);
    }
  }
}

const unique = [...new Set(findings)];
if (unique.length) {
  console.error(`✖ Potential secrets found (${unique.length}):`);
  unique.forEach((f) => console.error(`  - ${f}`));
  console.error('Rotate any real credential immediately, then purge it from history (git filter-repo).');
  process.exit(1);
}
console.log(`✔ No secrets found (${files.length} files + full git history scanned).`);
