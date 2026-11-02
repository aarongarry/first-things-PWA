// Request handler for the google-calendar Edge Function. index.ts supplies the
// environment, a database adapter and fetch, so Node tests can run this file.
//
// Routes
//   OPTIONS            CORS preflight from an allowed app origin.
//   GET  ?state&code   Google's redirect after the consent screen.
//   POST {action}      "start", "today" or "disconnect" from the app.
//
// Accounts are unverified phone numbers, so a phone number alone never reads a
// calendar. Each device that connects keeps a random key; only its SHA-256 hash
// is stored, and "today" requires it.
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const SCOPES = ['openid', 'email', CALENDAR_SCOPE];
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const STATE_TTL = 10 * 60 * 1000;
const PHONE = /^\+[0-9]{11,15}$/;
const KEY = /^[0-9a-f]{64}$/;
const MAX_DEVICES = 10;

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = size => hex(crypto.getRandomValues(new Uint8Array(size)));
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return {};
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(fromBase64(base64)));
}

export function createHandler({ env, db, fetch: fetcher = fetch, now = Date.now }) {
  const origins = String(env.APP_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY'])
    if (!env[name]) throw Error(`Missing secret ${name}. See README → Google Calendar.`);
  let cipherKey;
  const key = () => cipherKey ??= crypto.subtle.importKey(
    'raw', fromBase64(env.TOKEN_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text)));
    return toBase64(new Uint8Array([...iv, ...sealed]));
  }
  async function decrypt(text) {
    const bytes = fromBase64(text);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(), bytes.slice(12));
    return new TextDecoder().decode(plain);
  }

  const cors = origin => origins.includes(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    Vary: 'Origin',
  } : {};
  const json = (origin, body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
  const page = (message, status = 400) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>First Things</title><p style="font:16px system-ui;margin:40px 20px">${message}</p>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

  // Only pages on an allowed origin can receive the user after Google.
  function safeReturn(value) {
    try {
      const url = new URL(value);
      if (!origins.includes(url.origin)) return null;
      url.search = ''; url.hash = '';
      return url.href;
    } catch { return null; }
  }
  const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  async function revoke(token) {
    try { await fetcher(GOOGLE_REVOKE, form({ token })); } catch { /* Best effort; the row is deleted anyway. */ }
  }

  async function start(origin, body) {
    const returnTo = safeReturn(body.returnTo);
    if (!returnTo) return json(origin, { error: 'This page can’t connect a calendar.' }, 400);
    const account = await db.accountId(body.phone);
    if (!account) return json(origin, { error: 'Wait for “All changes synced”, then try connecting again.' }, 409);
    const state = randomHex(32);
    await db.saveState({
      state, identity_id: account, key_hash: await sha256(body.key), return_to: returnTo,
      expires_at: new Date(now() + STATE_TTL).toISOString(),
    });
    const url = new URL(GOOGLE_AUTH);
    url.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI, response_type: 'code',
      scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state,
    });
    return json(origin, { url: url.href });
  }

  async function callback(url) {
    const state = url.searchParams.get('state');
    const attempt = state ? await db.takeState(state) : null;
    if (!attempt || Date.parse(attempt.expires_at) < now())
      return page('This sign-in link has expired. Return to First Things and tap Connect Google Calendar again.');
    const back = result => {
      const target = new URL(attempt.return_to);
      target.searchParams.set('calendar', result);
      return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store' } });
    };
    try {
      const failure = url.searchParams.get('error');
      if (failure) return back(failure === 'access_denied' ? 'denied' : 'error');
      const code = url.searchParams.get('code');
      if (!code) return back('error');
      const response = await fetcher(GOOGLE_TOKEN, form({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
      }));
      if (!response.ok) return back('error');
      const tokens = await response.json();
      const granted = String(tokens.scope || '').split(' ').filter(Boolean);
      // Google lets people untick individual permissions on the consent screen.
      if (!granted.includes(CALENDAR_SCOPE)) {
        await revoke(tokens.refresh_token || tokens.access_token);
        return back('missing');
      }
      const email = decodeJwtPayload(tokens.id_token).email;
      if (!tokens.refresh_token || typeof email !== 'string') return back('error');
      const existing = await db.getConnection(attempt.identity_id);
      const sameAccount = existing?.email === email;
      if (existing && !sameAccount) await revoke(await decrypt(existing.refresh_token).catch(() => ''));
      const keys = sameAccount ? [attempt.key_hash, ...existing.key_hashes.filter(k => k !== attempt.key_hash)] : [attempt.key_hash];
      await db.saveConnection({
        identity_id: attempt.identity_id, email, refresh_token: await encrypt(tokens.refresh_token),
        scopes: granted, key_hashes: keys.slice(0, MAX_DEVICES), connected_at: new Date(now()).toISOString(),
      });
      return back('connected');
    } catch {
      return back('error');
    }
  }

  async function today(origin, body, account, connection) {
    if (!connection) return json(origin, { connected: false });
    if (!KEY.test(body.key || '') || !connection.key_hashes.includes(await sha256(body.key)))
      return json(origin, { connected: false, elsewhere: true });
    const from = Date.parse(body.timeMin), to = Date.parse(body.timeMax);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 2 * 86400000)
      return json(origin, { error: 'Invalid day.' }, 400);
    const refresh = await fetcher(GOOGLE_TOKEN, form({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await decrypt(connection.refresh_token), grant_type: 'refresh_token',
    }));
    const grant = await refresh.json().catch(() => ({}));
    if (!refresh.ok) {
      // Access was removed in the Google account, or expired (Testing mode: 7 days).
      if (grant.error === 'invalid_grant') {
        await db.deleteConnection(account);
        return json(origin, { connected: false, revoked: true });
      }
      return json(origin, { error: 'Google Calendar didn’t respond. Try again soon.' }, 502);
    }
    const list = new URL(EVENTS);
    list.search = new URLSearchParams({
      timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
      fields: 'items(summary,start,end,status,transparency,attendees(self,responseStatus))',
      ...(typeof body.timeZone === 'string' && body.timeZone.length < 64 ? { timeZone: body.timeZone } : {}),
    });
    const response = await fetcher(list.href, { headers: { Authorization: `Bearer ${grant.access_token}` } });
    if (!response.ok) return json(origin, { error: 'Google Calendar didn’t respond. Try again soon.' }, 502);
    const items = (await response.json()).items || [];
    const events = items
      .filter(e => e.status !== 'cancelled' && !e.attendees?.some(a => a.self && a.responseStatus === 'declined'))
      .map(e => ({
        title: String(e.summary || 'Busy').slice(0, 120),
        start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
        allDay: !e.start?.dateTime, free: e.transparency === 'transparent',
      }))
      .filter(e => e.start && e.end);
    return json(origin, { connected: true, email: connection.email, events });
  }

  async function disconnect(origin, account, connection) {
    if (connection) {
      await revoke(await decrypt(connection.refresh_token).catch(() => ''));
      await db.deleteConnection(account);
    }
    return json(origin, { connected: false });
  }

  return async function handle(request) {
    const origin = request.headers.get('origin') || '';
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: origins.includes(origin) ? 204 : 403, headers: cors(origin) });
    if (request.method === 'GET') return callback(url);
    if (request.method !== 'POST') return json(origin, { error: 'Not found.' }, 404);
    if (!origins.includes(origin)) return json(origin, { error: 'Origin not allowed.' }, 403);
    try {
      const body = await request.json().catch(() => ({}));
      if (!PHONE.test(body.phone || '')) return json(origin, { error: 'Invalid account.' }, 400);
      if (body.action === 'start') {
        if (!KEY.test(body.key || '')) return json(origin, { error: 'Invalid device key.' }, 400);
        return await start(origin, body);
      }
      if (body.action !== 'today' && body.action !== 'disconnect') return json(origin, { error: 'Unknown action.' }, 400);
      const account = await db.accountId(body.phone);
      const connection = account ? await db.getConnection(account) : null;
      return body.action === 'today'
        ? await today(origin, body, account, connection)
        : await disconnect(origin, account, connection);
    } catch {
      return json(origin, { error: 'Google Calendar is unavailable right now. Try again soon.' }, 500);
    }
  };
}
