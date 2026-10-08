'use strict';

/**
 * Typo- and transliteration-tolerant matching for Indian place names.
 *
 * `fold` gives a plain lowercase ASCII form ("Sūrat" → "surat").
 * `soundKey` additionally erases spelling variations that are common when
 * Indian names are written in English, so that e.g.
 *   Thirunelveli ≈ Tirunelveli, Kanniyakumari ≈ Kanyakumari,
 *   Thiruvananthapuram ≈ Tiruvananthapuram, Puri ≈ Poori, Vellore ≈ Velore.
 * `distance` is a bounded Damerau–Levenshtein distance for remaining typos.
 */
const fold = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function soundKey(s) {
  let k = fold(s).replace(/[^a-z]/g, '');
  k = k
    .replace(/^the/, '') // "The Nilgiris"
    .replace(/([bdgjkpt])h/g, '$1') // aspirates: th→t, dh→d, bh→b, kh→k …
    .replace(/sh/g, 's')
    .replace(/ph/g, 'f')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/ou/g, 'u')
    .replace(/iy/g, 'y')
    .replace(/(.)\1+/g, '$1'); // doubled letters
  return k;
}

/** Damerau–Levenshtein distance, giving up early once it exceeds `max`. */
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev2 = null;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[cols - 1];
}

/** How many typos to tolerate for a query of this length. */
const tolerance = (len) => (len >= 8 ? 2 : len >= 4 ? 1 : 0);

module.exports = { fold, soundKey, distance, tolerance };
