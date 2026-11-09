// Photo verification. The camera photo is shrunk on the phone, checked once by
// the verify-photo Edge Function (Claude Haiku), and never stored on a server.
// A small copy stays in this browser until the day ends.
import { SUPABASE_URL } from './supabase-config.js';

export const PHOTO_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/verify-photo`;
export const PHOTO_STORE_PREFIX = 'first-things-photos-v1:';
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_KEPT = 20;

// Draws the image no larger than `size` px on its longest side, as JPEG.
export async function shrinkPhoto(file, size, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close?.();
  }
}

// One photo for the check (1024 px) and a small one to keep for today (320 px).
export async function preparePhoto(file) {
  if (!file?.type?.startsWith('image/')) throw Error('That file isn’t a photo. Try taking it again. No check was counted.');
  if (file.size > MAX_SOURCE_BYTES) throw Error('That photo is too large. Try taking it again. No check was counted.');
  try {
    const [check, keep] = [await shrinkPhoto(file, 1024), await shrinkPhoto(file, 320, 0.7)];
    return { preview: check, keep, image: check.split(',')[1], mediaType: 'image/jpeg' };
  } catch {
    throw Error('That photo couldn’t be opened. Try taking it again. No check was counted.');
  }
}

// Returns {verdict, reason} from the AI check, or {fallback: true, message}
// when the check can't run (offline, not set up, daily limit, outage): the app
// then accepts the photo as proof. Throws only when the photo itself is bad.
export function createPhotoChecker(fetcher = fetch) {
  return async function check(phone, title, photo) {
    let response, result = null;
    try {
      // text/plain with no custom headers skips the CORS preflight, as in calendar.js.
      response = await fetcher(PHOTO_FUNCTION_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, cache: 'no-store',
        body: JSON.stringify({ phone, title, image: photo.image, mediaType: photo.mediaType }),
        signal: AbortSignal.timeout(30000),
      });
      result = await response.json();
    } catch { /* Handled below. */ }
    if (response?.ok && ['pass', 'unsure', 'fail'].includes(result?.verdict))
      return { verdict: result.verdict, reason: typeof result.reason === 'string' ? result.reason : '' };
    if (response?.status === 400 && typeof result?.error === 'string') throw Error(result.error);
    return {
      fallback: true,
      message: typeof result?.error === 'string' && result.fallback
        ? result.error
        : 'Photo checking is unavailable right now, so your photo counts as proof.',
    };
  };
}

// Today's kept photos for one account: {taskId: dataUrl}. Other days are dropped.
export function dayPhotos(storage, phone, day) {
  try {
    const saved = JSON.parse(storage.getItem(PHOTO_STORE_PREFIX + phone) || 'null');
    if (saved?.day === day && saved.photos && typeof saved.photos === 'object') return saved.photos;
    if (saved) storage.removeItem(PHOTO_STORE_PREFIX + phone);
  } catch { /* Storage may be blocked or corrupt; photos are optional. */ }
  return {};
}

function writePhotos(storage, phone, day, photos) {
  try {
    if (Object.keys(photos).length) storage.setItem(PHOTO_STORE_PREFIX + phone, JSON.stringify({ day, photos }));
    else storage.removeItem(PHOTO_STORE_PREFIX + phone);
  } catch { /* Full or blocked storage: skip keeping the copy. */ }
}

export function keepPhoto(storage, phone, day, taskId, dataUrl) {
  const photos = { ...dayPhotos(storage, phone, day), [taskId]: dataUrl };
  const ids = Object.keys(photos);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_KEPT))) delete photos[old];
  writePhotos(storage, phone, day, photos);
}

export function forgetPhoto(storage, phone, day, taskId) {
  const photos = dayPhotos(storage, phone, day);
  if (!(taskId in photos)) return;
  delete photos[taskId];
  writePhotos(storage, phone, day, photos);
}
