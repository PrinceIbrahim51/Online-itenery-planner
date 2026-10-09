// Reads GPS coordinates from a JPEG's EXIF data entirely in the browser.
// The photo itself is never uploaded for this step — only the coordinates are used.

const MAX_SCAN = 256 * 1024; // EXIF lives at the start of the file

/** Returns { lat, lng } or null when the photo carries no (valid) GPS data. */
export async function readGps(file) {
  const buf = await file.slice(0, MAX_SCAN).arrayBuffer();
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (marker === 0xe1 && size >= 8 && offset + 4 + 6 <= view.byteLength) {
      // "Exif\0\0"
      if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
        return parseTiff(view, offset + 10, Math.min(offset + 2 + size, view.byteLength));
      }
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data / end — no EXIF found
    offset += 2 + size;
  }
  return null;
}

function parseTiff(view, start, end) {
  if (start + 8 > end) return null;
  const order = view.getUint16(start);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  const u16 = (o) => (o + 2 <= end ? view.getUint16(o, little) : NaN);
  const u32 = (o) => (o + 4 <= end ? view.getUint32(o, little) : NaN);
  if (u16(start + 2) !== 42) return null;

  const readIfd = (ifdOffset) => {
    const at = start + ifdOffset;
    const count = u16(at);
    if (!Number.isFinite(count) || count > 500) return null;
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > end) break;
      entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8, pointer: u32(e + 8) });
    }
    return entries;
  };

  const ifd0 = readIfd(u32(start + 4));
  const gpsPtr = ifd0?.get(0x8825);
  if (!gpsPtr) return null;
  const gps = readIfd(gpsPtr.pointer);
  if (!gps) return null;

  const ref = (tag) => {
    const e = gps.get(tag);
    return e ? String.fromCharCode(view.getUint8(e.valueOffset)) : null;
  };
  const rationals = (tag) => {
    const e = gps.get(tag);
    if (!e || e.type !== 5 || e.count !== 3) return null;
    const base = start + e.pointer;
    const vals = [];
    for (let i = 0; i < 3; i++) {
      const num = u32(base + i * 8);
      const den = u32(base + i * 8 + 4);
      if (!Number.isFinite(num) || !den) return null;
      vals.push(num / den);
    }
    return vals[0] + vals[1] / 60 + vals[2] / 3600;
  };

  let lat = rationals(2);
  let lng = rationals(4);
  if (lat === null || lng === null) return null;
  if (ref(1) === 'S') lat = -lat;
  if (ref(3) === 'W') lng = -lng;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/**
 * Shrinks a photo for upload (max 1600 px, JPEG). Re-encoding also strips all
 * metadata, so no hidden location or device data is sent along with the image.
 */
export async function shrinkForUpload(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the image'))), 'image/jpeg', 0.85)
  );
}
