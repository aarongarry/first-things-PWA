import assert from 'node:assert/strict';
import { createHandler, CALENDAR_SCOPE } from '../supabase/functions/google-calendar/handler.js';
import { createCalendar, deviceKey, forgetDeviceKey, moveDeviceKey, freeTime, dayRange, eventTime, CALENDAR_FUNCTION_URL } from '../docs/calendar.js';

const APP = 'https://aarongarry.github.io';
const FN = 'https://project.supabase.co/functions/v1/google-calendar';
const env = {
  GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REDIRECT_URI: FN,
  APP_ORIGINS: `${APP},http://localhost:4173`, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const PHONE = '+15555550123', ID = 'identity-1';
const KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64);
const jwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

function world() {
  const db = {
    accounts: new Map([[PHONE, ID]]), states: new Map(), connections: new Map(),
    accountId: async phone => db.accounts.get(phone) ?? null,
    saveState: async row => { db.states.set(row.state, row); },
    takeState: async state => { const row = db.states.get(state) ?? null; db.states.delete(state); return row; },
    getConnection: async id => db.connections.get(id) ?? null,
    saveConnection: async row => { db.connections.set(row.identity_id, row); },
    deleteConnection: async id => { db.connections.delete(id); },
  };
  const google = { scope: `openid email ${CALENDAR_SCOPE}`, email: 'you@gmail.com', refresh: 'refresh-1', revoked: [], invalid: false, calls: [] };
  const fetcher = async (url, options = {}) => {
    google.calls.push(String(url));
    const body = options.body instanceof URLSearchParams ? options.body : new URLSearchParams();
    if (url === 'https://oauth2.googleapis.com/revoke') { google.revoked.push(body.get('token')); return Response.json({}); }
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(body.get('client_secret'), 'client-secret');
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('redirect_uri'), FN);
        return Response.json({ access_token: 'access', refresh_token: google.refresh, scope: google.scope, id_token: jwt({ email: google.email }) });
      }
      assert.equal(body.get('refresh_token'), google.refresh);
      return google.invalid ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: 'access-2' });
    }
    if (String(url).startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
      assert.equal(options.headers.Authorization, 'Bearer access-2');
      const params = new URL(url).searchParams;
      assert.equal(params.get('singleEvents'), 'true');
      assert.equal(params.get('timeZone'), 'America/Denver');
      return Response.json({ items: [
        { summary: 'Lecture', start: { dateTime: '2026-11-01T10:00:00-07:00' }, end: { dateTime: '2026-11-01T11:00:00-07:00' } },
        { summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-11-01T12:00:00-07:00' }, end: { dateTime: '2026-11-01T13:00:00-07:00' } },
        { summary: 'Declined', attendees: [{ self: true, responseStatus: 'declined' }], start: { dateTime: '2026-11-01T14:00:00-07:00' }, end: { dateTime: '2026-11-01T15:00:00-07:00' } },
        { start: { date: '2026-11-01' }, end: { date: '2026-11-02' }, transparency: 'transparent' },
      ] });
    }
    throw Error('Unexpected fetch ' + url);
  };
  return { db, google, handle: createHandler({ env, db, fetch: fetcher }) };
}
const post = (handle, body, origin = APP) => handle(new Request(FN, {
  method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const day = { timeMin: '2026-11-01T06:00:00.000Z', timeMax: '2026-11-02T06:00:00.000Z', timeZone: 'America/Denver' };
async function connect(w, key = KEY_A, result = {}) {
  const started = await post(w.handle, { action: 'start', phone: PHONE, key, returnTo: `${APP}/first-things-PWA/?old=1#x` });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('access-control-allow-origin'), APP);
  const auth = new URL((await started.json()).url);
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.ok(auth.searchParams.get('scope').includes(CALENDAR_SCOPE));
  assert.equal(auth.searchParams.get('redirect_uri'), FN);
  const query = new URLSearchParams({ state: auth.searchParams.get('state'), ...result });
  if (!result.error) query.set('code', 'code-1');
  return w.handle(new Request(`${FN}?${query}`));
}
const landing = response => new URL(response.headers.get('location'));

// Connect, read today, then reuse the one-time state.
{
  const w = world();
  const response = await connect(w);
  assert.equal(response.status, 302);
  assert.equal(landing(response).href, `${APP}/first-things-PWA/?calendar=connected`);
  const saved = w.db.connections.get(ID);
  assert.equal(saved.email, 'you@gmail.com');
  assert.ok(!saved.refresh_token.includes('refresh-1'), 'refresh token is encrypted at rest');
  assert.equal(saved.key_hashes.length, 1);
  assert.ok(!saved.key_hashes.includes(KEY_A), 'only the device key hash is stored');
  assert.equal(w.db.states.size, 0);
  const today = await (await post(w.handle, { action: 'today', phone: PHONE, key: KEY_A, ...day })).json();
  assert.equal(today.connected, true);
  assert.equal(today.email, 'you@gmail.com');
  assert.deepEqual(today.events.map(e => e.title), ['Lecture', 'Busy']);
  assert.deepEqual(today.events[1], { title: 'Busy', start: '2026-11-01', end: '2026-11-02', allDay: true, free: true });
  // A phone number without this device's key can't read the calendar.
  assert.deepEqual(await (await post(w.handle, { action: 'today', phone: PHONE, ...day })).json(), { connected: false, elsewhere: true });
  assert.deepEqual(await (await post(w.handle, { action: 'today', phone: PHONE, key: KEY_B, ...day })).json(), { connected: false, elsewhere: true });
  // A second device on the same Google account is added, not swapped in.
  await connect(w, KEY_B);
  assert.equal(w.db.connections.get(ID).key_hashes.length, 2);
  assert.equal((await (await post(w.handle, { action: 'today', phone: PHONE, key: KEY_A, ...day })).json()).connected, true);
  // A different Google account replaces the old connection and its devices.
  w.google.email = 'other@gmail.com'; w.google.refresh = 'refresh-2';
  await connect(w, KEY_B);
  assert.deepEqual(w.google.revoked, ['refresh-1']);
  assert.equal(w.db.connections.get(ID).key_hashes.length, 1);
  assert.equal((await (await post(w.handle, { action: 'today', phone: PHONE, key: KEY_A, ...day })).json()).elsewhere, true);
}
console.log('PASS Google sign-in, encrypted token storage, device keys, today’s events, multiple devices, account switch');

// Deny, untick the calendar box, expired or replayed state, bad origins.
{
  const w = world();
  assert.equal(landing(await connect(w, KEY_A, { error: 'access_denied' })).searchParams.get('calendar'), 'denied');
  assert.equal(w.db.connections.size, 0);
  w.google.scope = 'openid email';
  assert.equal(landing(await connect(w)).searchParams.get('calendar'), 'missing');
  assert.deepEqual(w.google.revoked, ['refresh-1']);
  assert.equal(w.db.connections.size, 0);
  const replay = await w.handle(new Request(`${FN}?state=unknown&code=c`));
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /expired/);
  const old = world();
  const started = await (await post(old.handle, { action: 'start', phone: PHONE, key: KEY_A, returnTo: APP + '/' })).json();
  const state = new URL(started.url).searchParams.get('state');
  old.db.states.get(state).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await old.handle(new Request(`${FN}?state=${state}&code=c`))).status, 400);
  assert.equal((await post(w.handle, { action: 'start', phone: PHONE, key: KEY_A, returnTo: 'https://evil.test/' })).status, 400);
  assert.equal((await post(w.handle, { action: 'start', phone: PHONE, key: KEY_A, returnTo: APP + '/' }, 'https://evil.test')).status, 403);
  assert.equal((await post(w.handle, { action: 'start', phone: PHONE, key: 'short', returnTo: APP + '/' })).status, 400);
  assert.equal((await post(w.handle, { action: 'start', phone: '+15555550999', key: KEY_A, returnTo: APP + '/' })).status, 409);
  const preflight = await w.handle(new Request(FN, { method: 'OPTIONS', headers: { origin: 'http://localhost:4173' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:4173');
  assert.throws(() => createHandler({ env: { ...env, GOOGLE_CLIENT_SECRET: '' }, db: w.db }), /GOOGLE_CLIENT_SECRET/);
}
console.log('PASS denied access, missing calendar permission, expired and replayed sign-ins, origin and redirect checks');

// Access removed in Google, then disconnect from the app.
{
  const w = world();
  await connect(w);
  w.google.invalid = true;
  assert.deepEqual(await (await post(w.handle, { action: 'today', phone: PHONE, key: KEY_A, ...day })).json(), { connected: false, revoked: true });
  assert.equal(w.db.connections.size, 0);
  w.google.invalid = false;
  await connect(w);
  assert.deepEqual(await (await post(w.handle, { action: 'disconnect', phone: PHONE, key: KEY_A })).json(), { connected: false });
  assert.deepEqual(w.google.revoked, ['refresh-1']);
  assert.equal(w.db.connections.size, 0);
  assert.equal((await post(w.handle, { action: 'today', phone: PHONE, key: KEY_A, timeMin: 'x', timeMax: 'y' })).status, 200);
}
console.log('PASS revoked Google access and in-app disconnect');

// Browser side: client requests, device keys, free time.
{
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  assert.equal(deviceKey(storage, PHONE), null);
  const key = deviceKey(storage, PHONE, true);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(deviceKey(storage, PHONE, true), key);
  moveDeviceKey(storage, PHONE, '+15555550124');
  assert.equal(deviceKey(storage, PHONE), null);
  assert.equal(deviceKey(storage, '+15555550124'), key);
  forgetDeviceKey(storage, '+15555550124');
  assert.equal(deviceKey(storage, '+15555550124'), null);
  assert.equal(deviceKey({ getItem() { throw Error('blocked'); } }, PHONE, true), null);

  const sent = [];
  const api = createCalendar(async (url, options) => {
    assert.equal(url, CALENDAR_FUNCTION_URL);
    assert.equal(options.cache, 'no-store');
    const body = JSON.parse(options.body); sent.push(body);
    if (body.action === 'start') return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    if (body.action === 'today') return Response.json({ connected: true, email: 'you@gmail.com', events: [] });
    return Response.json({ connected: false });
  });
  assert.equal(await api.start(PHONE, key, APP + '/'), 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  assert.equal((await api.today(PHONE, key, new Date(2026, 10, 1, 15))).email, 'you@gmail.com');
  assert.equal(sent[1].timeMin, new Date(2026, 10, 1).toISOString());
  assert.equal(sent[1].timeMax, new Date(2026, 10, 2).toISOString());
  await api.disconnect(PHONE, null);
  assert.equal('key' in sent[2], false);
  await assert.rejects(createCalendar(async () => Response.json({ url: 'https://evil.test/' })).start(PHONE, key, APP), /couldn’t start/);
  await assert.rejects(createCalendar(async () => Response.json({ error: 'Wait for sync' }, { status: 409 })).start(PHONE, key, APP), /Wait for sync/);
  await assert.rejects(createCalendar(async () => { throw Error('offline'); }).today(PHONE, key), /unavailable/);
  assert.equal(typeof dayRange().timeZone, 'string');

  const at = (h, m = 0) => new Date(2026, 10, 1, h, m).getTime();
  const iso = (h, m = 0) => new Date(at(h, m)).toISOString();
  const events = [
    { start: iso(10), end: iso(11), allDay: false, free: false },
    { start: iso(10, 30), end: iso(12), allDay: false, free: false },
    { start: iso(12, 10), end: iso(13), allDay: false, free: false },
    { start: iso(15), end: iso(16), allDay: false, free: true },
    { start: '2026-11-01', end: '2026-11-02', allDay: true, free: false },
  ];
  assert.deepEqual(freeTime(events, at(8), at(22)), [{ start: at(8), end: at(10) }, { start: at(13), end: at(22) }]);
  assert.deepEqual(freeTime(events, at(10, 45), at(12, 20)), []);
  assert.equal(eventTime('2026-11-01'), at(0));
}
console.log('PASS calendar client requests, device key storage, free-time gaps and all-day dates');
