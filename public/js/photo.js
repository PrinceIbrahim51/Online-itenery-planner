import { h, clear, $ } from './dom.js';
import { readGps, shrinkForUpload } from './exif.js';

/**
 * "Where was this photo taken?"
 * 1. Reads GPS from the photo in the browser (nothing uploaded) → nearest town + sights.
 * 2. No GPS? If the server has landmark recognition enabled, asks for consent, then sends a
 *    shrunk, metadata-free copy for Google Vision to recognise.
 */
export function initPhotoFinder({ api, toast, planPlace }) {
  const input = $('#photo-input');
  const out = $('#photo-result');
  let visionEnabled = false;
  api('/photo/capabilities')
    .then((c) => (visionEnabled = Boolean(c.landmarkRecognition)))
    .catch(() => {});

  const busy = (text) => clear(out).append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text));

  function render(result, how) {
    clear(out);
    const card = h('div', { class: 'photo-card glass' });
    if (result.landmarks?.length) {
      const top = result.landmarks[0];
      card.append(h('p', { class: 'eyebrow' }, 'Recognised landmark'), h('h3', {}, top.name), h('p', { class: 'muted' }, `Confidence ${Math.round(top.score * 100)}%`));
    } else {
      card.append(h('p', { class: 'eyebrow' }, how));
    }
    if (result.nearest) {
      card.append(
        h('p', {}, `Near ${result.nearest.name}, ${result.nearest.state} (${result.nearest.km} km from the town centre).`),
        h(
          'div',
          { class: 'photo-actions' },
          result.point ? h('a', { href: result.point.mapsUrl, class: 'btn btn-ghost btn-sm' }, 'Exact spot on Google Maps ↗') : null,
          h('button', { type: 'button', class: 'btn btn-gold btn-sm', onClick: () => planPlace(result.nearest.slug, `${result.nearest.name}, ${result.nearest.state}`) }, `Plan a trip to ${result.nearest.name}`)
        )
      );
    } else if (!result.landmarks?.length) {
      card.append(h('p', { class: 'muted' }, 'This place is outside India, so we can’t plan a trip there yet.'));
    }
    if (result.nearby?.length) {
      card.append(
        h('h4', {}, 'Famous places right around it'),
        h('ul', { class: 'photo-nearby' }, result.nearby.map((n) => h('li', {}, h('a', { href: n.mapsUrl }, n.name), h('span', { class: 'muted' }, ` · ${n.km} km`))))
      );
    }
    out.append(card);
  }

  function noGps(file) {
    clear(out);
    const card = h(
      'div',
      { class: 'photo-card glass' },
      h('p', { class: 'eyebrow' }, 'No location in this photo'),
      h('p', {}, 'This photo has no GPS data. That’s normal for screenshots and photos shared through WhatsApp or social media, which remove it.')
    );
    if (visionEnabled) {
      card.append(
        h('p', { class: 'muted' }, 'We can ask Google to recognise a famous landmark in it. A smaller copy without any hidden data is sent once and not stored.'),
        h('button', { type: 'button', class: 'btn btn-gold btn-sm', onClick: () => recognise(file) }, 'Recognise landmark')
      );
    } else {
      card.append(h('p', { class: 'muted' }, 'Tip: use the original photo from your camera app, with location turned on in the camera settings.'));
    }
    out.append(card);
  }

  async function recognise(file) {
    busy('Recognising the landmark…');
    try {
      const blob = await shrinkForUpload(file);
      const result = await api('/photo/landmark', { method: 'POST', rawBody: blob, contentType: 'image/jpeg' });
      if (!result.landmarks?.length) {
        clear(out).append(h('div', { class: 'photo-card glass' }, h('p', {}, result.message || 'No famous landmark recognised in this photo.')));
        return;
      }
      render(result, 'Recognised landmark');
    } catch (err) {
      clear(out).append(h('div', { class: 'empty glass' }, err.message));
    }
  }

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('Please choose a photo.', true);
    if (file.size > 25 * 1024 * 1024) return toast('That photo is too large (max 25 MB).', true);
    busy('Reading the photo’s location…');
    let gps = null;
    try {
      gps = await readGps(file);
    } catch {
      gps = null;
    }
    if (!gps) return noGps(file);
    if (gps.lat < 6 || gps.lat > 37.5 || gps.lng < 68 || gps.lng > 98) {
      clear(out).append(h('div', { class: 'photo-card glass' }, h('p', {}, 'This photo was taken outside India — we only plan trips within India for now.')));
      return;
    }
    try {
      const result = await api(`/locate?${new URLSearchParams({ lat: gps.lat.toFixed(6), lng: gps.lng.toFixed(6) })}`);
      render(result, 'Location found in the photo');
    } catch (err) {
      clear(out).append(h('div', { class: 'empty glass' }, err.message));
    }
  });
}
