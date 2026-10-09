'use strict';

const { z } = require('zod');
const { cleanText } = require('../security/sanitize');

/**
 * OPTIONAL Google Cloud Vision landmark detection, enabled only when
 * GOOGLE_VISION_API_KEY is set. Used for photos that carry no GPS data.
 * The image is forwarded once and never stored; the key stays server-side.
 */
const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const TIMEOUT_MS = 12000;

const responseSchema = z.object({
  responses: z
    .array(
      z.object({
        landmarkAnnotations: z
          .array(
            z.object({
              description: z.string().optional(),
              score: z.number().optional(),
              locations: z.array(z.object({ latLng: z.object({ latitude: z.number(), longitude: z.number() }) })).optional(),
            })
          )
          .optional(),
        error: z.object({ message: z.string().optional() }).optional(),
      })
    )
    .optional(),
});

function createVision(apiKey, { fetchImpl = fetch } = {}) {
  /** @param {Buffer} image JPEG/PNG/WebP bytes */
  async function landmarks(image) {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify({
        requests: [{ image: { content: image.toString('base64') }, features: [{ type: 'LANDMARK_DETECTION', maxResults: 3 }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Vision ${res.status}`);
    const parsed = responseSchema.safeParse(JSON.parse(await res.text()));
    if (!parsed.success) throw new Error('Unexpected Vision response');
    const first = parsed.data.responses?.[0];
    if (first?.error) throw new Error('Vision could not process the image');
    return (first?.landmarkAnnotations ?? [])
      .filter((l) => l.description && l.locations?.length)
      .map((l) => ({
        name: cleanText(l.description).slice(0, 90),
        score: Math.round((l.score ?? 0) * 100) / 100,
        lat: l.locations[0].latLng.latitude,
        lng: l.locations[0].latLng.longitude,
      }));
  }
  return { landmarks };
}

/** Accept only real JPEG / PNG / WebP data (checked by magic bytes, not the Content-Type header). */
function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

module.exports = { createVision, imageKind };
