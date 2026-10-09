'use strict';

/**
 * Sunrise / sunset from the standard sunrise equation (accurate to ~1–2 minutes,
 * plenty for planning photos). Times are returned in Indian Standard Time.
 */
const RAD = Math.PI / 180;
const IST_OFFSET_MIN = 330;

function julianFromDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5;
}

const toIstMinutes = (julian) => {
  const ms = (julian - 2440587.5) * 86400000;
  const utcMin = (ms / 60000) % 1440;
  return Math.round((utcMin + IST_OFFSET_MIN + 1440) % 1440);
};

const fmt = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** { sunrise, sunset, goldenMorning, goldenEvening } as "HH:MM" IST strings, or null in polar edge cases. */
function sunTimes(lat, lng, isoDate) {
  const n = Math.ceil(julianFromDate(isoDate) - 2451545.0 + 0.0008);
  const jStar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
  if (cosH < -1 || cosH > 1) return null;
  const h = Math.acos(cosH) / RAD;
  const rise = toIstMinutes(jTransit - h / 360);
  const set = toIstMinutes(jTransit + h / 360);
  return {
    sunrise: fmt(rise),
    sunset: fmt(set),
    goldenMorning: `${fmt(rise)}–${fmt(rise + 60)}`,
    goldenEvening: `${fmt(set - 60)}–${fmt(set)}`,
  };
}

module.exports = { sunTimes };
