// Safe DOM helpers. Data is ONLY ever inserted with textContent / setAttribute,
// never innerHTML, so API data cannot inject markup or script (XSS protection).

const ALLOWED_LINK_HOSTS = new Set([
  'www.google.com',
  'www.booking.com',
  'm.uber.com',
  'book.olacabs.com',
  'www.rapido.bike',
  'indrive.com',
  'goamiles.com',
  'maps.google.com',
  'in.bookmyshow.com',
]);

/** Returns the URL only if it is https and points to an allow-listed host. */
export function safeUrl(value) {
  // Phone links: digits only (with optional leading +), nothing else.
  if (typeof value === 'string' && /^tel:\+?\d{3,15}$/.test(value)) return value;
  try {
    const u = new URL(String(value));
    if (u.protocol === 'https:' && ALLOWED_LINK_HOSTS.has(u.hostname)) return u.href;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * h('div', { class: 'x', dataset: { id: 1 }, onClick: fn }, 'text', childNode, [more])
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'href') {
      const url = safeUrl(value);
      if (url) {
        el.setAttribute('href', url);
        if (!url.startsWith('tel:')) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer nofollow');
        }
      }
    } else if (key === 'style') {
      // Only CSS custom properties with numeric values are permitted.
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--') && /^[\d.]+%?$/.test(String(v))) el.style.setProperty(prop, String(v));
        else if (prop === 'width' && /^[\d.]+%$/.test(String(v))) el.style.width = String(v);
      }
    } else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const money = (n) => inr.format(Number(n) || 0);

export function stars(rating) {
  const r = Number(rating) || 0;
  return `★ ${r.toFixed(1)}`;
}
