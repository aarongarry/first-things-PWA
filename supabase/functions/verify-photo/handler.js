// Request handler for the verify-photo Edge Function. index.ts supplies the
// environment, a database adapter and the judge, so Node tests can run this file.
//
//   OPTIONS                                CORS preflight from an allowed app origin.
//   POST {phone, title, image, mediaType}  image is base64 without a data: prefix.
//
// 200 {verdict, reason}   verdict is "pass", "unsure" or "fail".
// Any answer with fallback: true means "couldn't check": the app then accepts
// the photo as proof, so a task never gets stuck on this service.
// Photos are never stored; each one is sent to Anthropic once and dropped.
export const PER_ACCOUNT_DAILY = 30;
export const PER_APP_DAILY = 1000;
export const MAX_IMAGE_CHARS = 2_000_000;   // about 1.5 MB of JPEG
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHONE = /^\+[0-9]{11,15}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function createHandler({ env, db, judge }) {
  const origins = String(env.APP_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  if (!env.ANTHROPIC_API_KEY) throw Error('Missing secret ANTHROPIC_API_KEY. See README → Photo verification.');
  const perAccount = Number(env.PHOTO_CHECKS_PER_ACCOUNT) || PER_ACCOUNT_DAILY;
  const perApp = Number(env.PHOTO_CHECKS_PER_APP) || PER_APP_DAILY;

  const cors = origin => origins.includes(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    Vary: 'Origin',
  } : {};
  const json = (origin, body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
  const fallback = (origin, error, status) => json(origin, { error, fallback: true }, status);

  return async function handle(request) {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: origins.includes(origin) ? 204 : 403, headers: cors(origin) });
    if (request.method !== 'POST') return json(origin, { error: 'Not found.' }, 404);
    if (!origins.includes(origin)) return json(origin, { error: 'Origin not allowed.' }, 403);

    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!PHONE.test(body.phone || '')) return json(origin, { error: 'Invalid account.' }, 400);
    if (!title || title.length > 200) return json(origin, { error: 'Invalid task.' }, 400);
    if (!MEDIA_TYPES.includes(body.mediaType) || typeof body.image !== 'string' ||
        !body.image || body.image.length > MAX_IMAGE_CHARS || !BASE64.test(body.image))
      return json(origin, { error: 'That photo couldn’t be read. Try taking it again.' }, 400);

    try {
      const account = await db.accountId(body.phone);
      if (!account) return fallback(origin, 'Your account isn’t synced yet, so your photo counts as proof.', 409);
      const slot = await db.takeCheck(account, perAccount, perApp);
      if (slot !== 'ok') return fallback(origin, 'Photo checks are resting for today, so your photo counts as proof.', 429);
      return json(origin, await judge({ image: body.image, mediaType: body.mediaType, title }));
    } catch (error) {
      console.error(error);
      return fallback(origin, 'Photo checking is unavailable right now, so your photo counts as proof.', 503);
    }
  };
}
