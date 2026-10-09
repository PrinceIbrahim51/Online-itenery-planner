'use strict';

/**
 * Parser for the common subset of OpenStreetMap `opening_hours` syntax, e.g.
 *   "24/7"
 *   "Mo-Su 09:00-22:00"
 *   "Mo-Fr 10:00-22:00; Sa,Su 11:00-23:30"
 *   "Mo-Sa 11:00-15:00,19:00-23:00; Su off"
 *   "11:00-23:00"                 (no days → every day)
 *   "Tu-Su 18:00-02:00"           (past midnight)
 * Anything outside this subset (month ranges, public holidays, sunrise…) makes the
 * result `null` = "unknown": we never guess whether a place is open.
 *
 * A parsed week is an array of 7 entries (index 0 = Monday) holding
 * [[startMin, endMin], …] ranges; endMin may exceed 1440 for overnight hours.
 */
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(',')) {
    const p = part.trim();
    const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(p);
    if (range) {
      const a = DAYS.indexOf(range[1]);
      const b = DAYS.indexOf(range[2]);
      if (a < 0 || b < 0) return null;
      for (let i = a; ; i = (i + 1) % 7) {
        days.add(i);
        if (i === b) break;
      }
    } else {
      const i = DAYS.indexOf(p);
      if (i < 0) return null;
      days.add(i);
    }
  }
  return days;
}

function parseRanges(spec) {
  const ranges = [];
  for (const part of spec.split(',')) {
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part.trim());
    if (!m) return null;
    const start = parseTime(m[1]);
    let end = parseTime(m[2]);
    if (start === null || end === null) return null;
    if (end <= start) end += 1440; // closes after midnight
    ranges.push([start, end]);
  }
  return ranges;
}

/** Returns a 7-day week array, or null when the string is outside the supported subset. */
function parseOpeningHours(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 200) return null;
  if (/^24\/7$/.test(text)) return Array.from({ length: 7 }, () => [[0, 1440]]);
  const week = Array.from({ length: 7 }, () => undefined);
  for (const rule of text.split(';')) {
    const r = rule.trim();
    if (!r) continue;
    if (/^PH\b/.test(r)) continue; // public-holiday rules don't affect normal days
    const m = /^(?:((?:[A-Z][a-z](?:-[A-Z][a-z])?)(?:\s*,\s*[A-Z][a-z](?:-[A-Z][a-z])?)*)\s+)?(.+)$/.exec(r);
    if (!m) return null;
    const days = m[1] ? parseDays(m[1].replace(/\s+/g, '')) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    const body = m[2].trim();
    let ranges;
    if (/^(off|closed)$/i.test(body)) ranges = [];
    else if (body === '24/7' || body === '00:00-24:00') ranges = [[0, 1440]];
    else ranges = parseRanges(body);
    if (!ranges) return null;
    for (const d of days) week[d] = ranges; // later rules override earlier ones (OSM semantics)
  }
  if (week.every((d) => d === undefined)) return null;
  // OSM semantics: once any rule exists, days that no rule mentions are closed.
  return week.map((d) => (d === undefined ? [] : d));
}

/** true / false, or null when unknown. `dayIndex` 0 = Monday. */
function isOpenAt(week, dayIndex, minute) {
  if (!week) return null;
  const today = week[dayIndex];
  const yesterday = week[(dayIndex + 6) % 7];
  if (today === undefined && yesterday === undefined) return null;
  if (today?.some(([s, e]) => minute >= s && minute < e)) return true;
  if (yesterday?.some(([, e]) => e > 1440 && minute + 1440 < e)) return true;
  if (today === undefined) return null;
  return false;
}

const fmt = (m) => {
  const mm = m % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};
const fmtRanges = (r) => (r.length ? r.map(([s, e]) => (s === 0 && e === 1440 ? 'Open 24 hours' : `${fmt(s)}–${fmt(e)}`)).join(', ') : 'Closed');

/** Human summary, grouping consecutive days with identical hours: "Mon–Sat 11:00–23:00 · Sun Closed". */
function describe(week) {
  if (!week) return null;
  if (week.every((d) => d && d.length === 1 && d[0][0] === 0 && d[0][1] === 1440)) return 'Open 24 hours';
  const parts = [];
  let i = 0;
  while (i < 7) {
    const key = week[i] === undefined ? null : JSON.stringify(week[i]);
    let j = i;
    while (j + 1 < 7 && (week[j + 1] === undefined ? null : JSON.stringify(week[j + 1])) === key) j++;
    if (key !== null) {
      const label = i === j ? DAY_LABEL[i] : `${DAY_LABEL[i]}–${DAY_LABEL[j]}`;
      parts.push(`${label} ${fmtRanges(week[i])}`);
    }
    i = j + 1;
  }
  return parts.join(' · ');
}

/** The opening-hours text for one weekday, e.g. "11:00–15:00, 19:00–23:00" or "Closed". */
function hoursOn(week, dayIndex) {
  if (!week || week[dayIndex] === undefined) return null;
  return fmtRanges(week[dayIndex]);
}

const TEMP_CLOSED = /\b(temporar(il)?y\s+closed|closed\s+temporar(il)?y|under\s+renovation|closed\s+for\s+renovation|renovation\s+in\s+progress)\b/i;
const PERM_CLOSED = /\b(permanently\s+closed|closed\s+permanently|shut\s+down)\b/i;

/**
 * Closure signals mapped onto OpenStreetMap tags:
 * opening_hours "off"/"closed", or notes/descriptions mentioning renovation / temporary closure.
 */
function closureFromTags(tags = {}) {
  const text = [tags.note, tags.description, tags.name].filter(Boolean).join(' ');
  if (PERM_CLOSED.test(text)) return 'permanently_closed';
  if (TEMP_CLOSED.test(text)) return 'temporarily_closed';
  if (typeof tags.opening_hours === 'string' && /^(off|closed)$/i.test(tags.opening_hours.trim())) return 'temporarily_closed';
  return null;
}

/** Weekday index (0 = Monday) of an ISO calendar date "YYYY-MM-DD". */
function weekdayIndex(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

module.exports = { parseOpeningHours, isOpenAt, describe, hoursOn, closureFromTags, weekdayIndex, DAY_LABEL };
