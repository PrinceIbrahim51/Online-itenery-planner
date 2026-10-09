'use strict';

const express = require('express');
const { z } = require('zod');
const india = require('../services/india');
const { haversineKm } = require('../services/geo');
const { imageKind } = require('../services/vision');
const { HttpError, validate } = require('../security/middleware');

// India's bounding box (with a little margin) — we only plan trips in India.
const lat = z.coerce.number().min(6).max(37.5);
const lng = z.coerce.number().min(68).max(98);
const locateQuery = z.object({ lat, lng }).strict();

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const mapsPoint = (la, ln) => `https://www.google.com/maps/search/?api=1&query=${la.toFixed(6)},${ln.toFixed(6)}`;
const mapsName = (name, city) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${city}`)}`;

/**
 * "Where was this photo taken?"
 *  - GET  /locate          — the browser reads GPS from the photo's EXIF data itself and
 *                            sends only the coordinates; the photo never leaves the device.
 *  - POST /photo/landmark  — optional (needs GOOGLE_VISION_API_KEY): recognise a landmark in a
 *                            photo without GPS. Size-capped, type-checked by magic bytes,
 *                            strictly rate-limited, forwarded once and never stored.
 */
function photoRouter({ wikipedia, vision, logger, photoLimiter, planLimiter }) {
  const router = express.Router();

  async function describePoint(la, ln) {
    const nearest = india.nearestCity(la, ln);
    let nearby = [];
    if (wikipedia) {
      try {
        const { sights } = await wikipedia.placesAround(`pt:${la.toFixed(3)},${ln.toFixed(3)}`, la, ln);
        nearby = sights
          .map((s) => ({ name: s.name, category: s.wikiCategory, km: Math.round(haversineKm({ lat: la, lng: ln }, s) * 10) / 10, lat: s.lat, lng: s.lng }))
          .sort((a, b) => a.km - b.km)
          .slice(0, 6)
          .map((s) => ({ ...s, mapsUrl: mapsName(s.name, nearest?.name || '') }));
      } catch (err) {
        logger.warn(`Nearby lookup failed: ${err.message}`);
      }
    }
    return { point: { lat: Math.round(la * 1e5) / 1e5, lng: Math.round(ln * 1e5) / 1e5, mapsUrl: mapsPoint(la, ln) }, nearest, nearby };
  }

  router.get('/locate', planLimiter, validate(locateQuery, 'query'), async (req, res) => {
    res.set('Cache-Control', 'no-store'); // a user's location is private
    res.json(await describePoint(req.valid.query.lat, req.valid.query.lng));
  });

  router.get('/photo/capabilities', (_req, res) => {
    res.json({ landmarkRecognition: Boolean(vision) });
  });

  router.post(
    '/photo/landmark',
    photoLimiter,
    (req, _res, next) => (vision ? next() : next(new HttpError(503, 'Landmark recognition is not enabled on this deployment.'))),
    express.raw({ type: IMAGE_TYPES, limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'Send a JPEG, PNG or WebP image.');
      if (!imageKind(buf)) throw new HttpError(415, 'That file is not a JPEG, PNG or WebP image.');
      let found;
      try {
        found = await vision.landmarks(buf);
      } catch (err) {
        logger.warn(`Vision failed: ${err.message}`);
        throw new HttpError(502, 'Photo recognition is temporarily unavailable. Please try again later.');
      }
      if (!found.length) return res.json({ landmarks: [], message: 'No famous landmark recognised in this photo.' });
      const top = found[0];
      const inIndia = top.lat >= 6 && top.lat <= 37.5 && top.lng >= 68 && top.lng <= 98;
      res.json({ landmarks: found, ...(inIndia ? await describePoint(top.lat, top.lng) : { nearest: null, nearby: [] }) });
    }
  );

  return router;
}

module.exports = { photoRouter };
