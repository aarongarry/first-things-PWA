// Google Calendar connection. Google tokens stay inside the google-calendar Edge
// Function; this device keeps only a random key that proves it connected.
import { SUPABASE_URL } from './supabase-config.js';

export const CALENDAR_KEY_PREFIX = 'first-things-calendar-key-v1:';
export const CALENDAR_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/google-calendar`;
const KEY = /^[0-9a-f]{64}$/;

// Messages for ?calendar=<result> after Google sends the person back.
export const CALENDAR_RESULTS = {
  denied: 'You didn’t give First Things access to your calendar. That’s okay. Try again, or continue without it.',
  missing: 'Calendar access wasn’t ticked on Google’s screen. Try again and allow “View events on all your calendars”, or continue without it.',
  error: 'The calendar couldn’t connect. Your setup is saved. Try again, or continue without it.',
};

export function deviceKey(storage, phone, create = false) {
  try {
    const saved = storage.getItem(CALENDAR_KEY_PREFIX + phone);
    if (KEY.test(saved || '')) return saved;
    if (!create) return null;
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    storage.setItem(CALENDAR_KEY_PREFIX + phone, key);
    return key;
  } catch {
    return null;
  }
}

export function forgetDeviceKey(storage, phone) {
  try { storage.removeItem(CALENDAR_KEY_PREFIX + phone); } catch { /* Storage may be blocked. */ }
}

// A phone-number change keeps the same server-side account, so keep the key too.
export function moveDeviceKey(storage, from, to) {
  const key = deviceKey(storage, from);
  if (!key) return;
  try { storage.setItem(CALENDAR_KEY_PREFIX + to, key); storage.removeItem(CALENDAR_KEY_PREFIX + from); } catch { /* Reconnect later. */ }
}

// Local midnight to the next local midnight.
export function dayRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return {
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// All-day dates ("2026-11-01") are local days, not UTC midnight.
export function eventTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  return Date.parse(value);
}

// Gaps of at least `minimum` ms between timed, busy events inside [from, to).
export function freeTime(events, from, to, minimum = 15 * 60000) {
  const busy = events
    .filter(e => !e.allDay && !e.free)
    .map(e => [Math.max(eventTime(e.start), from), Math.min(eventTime(e.end), to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const gaps = [];
  let cursor = from;
  for (const [a, b] of busy) {
    if (a - cursor >= minimum) gaps.push({ start: cursor, end: a });
    cursor = Math.max(cursor, b);
  }
  if (to - cursor >= minimum) gaps.push({ start: cursor, end: to });
  return gaps;
}

export function createCalendar(fetcher = fetch) {
  async function call(body) {
    let response, result = null;
    try {
      // A text/plain POST with no custom headers skips the CORS preflight, so a
      // missing function shows up as a readable 404 instead of a network error.
      response = await fetcher(CALENDAR_FUNCTION_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(15000),
      });
      result = await response.json();
    } catch { /* Handled below. */ }
    if (response?.ok && result && typeof result === 'object') return result;
    if (typeof result?.error === 'string' && response?.status !== 404) throw Error(result.error);
    if (response?.status === 404) throw Error('Calendar connection isn’t set up on the server yet. You can continue without it.');
    if (response) throw Error('The calendar service had a problem. Try again soon, or continue without it.');
    throw Error('Google Calendar is unavailable right now. Check your connection and try again.');
  }
  return {
    async start(phone, key, returnTo) {
      const { url } = await call({ action: 'start', phone, key, returnTo });
      if (typeof url !== 'string' || !url.startsWith('https://accounts.google.com/'))
        throw Error('Google sign-in couldn’t start. Try again.');
      return url;
    },
    async today(phone, key, date = new Date()) {
      const result = await call({ action: 'today', phone, key, ...dayRange(date) });
      if (result.connected && (typeof result.email !== 'string' || !Array.isArray(result.events)))
        throw Error('Google Calendar returned an unexpected response. Try again.');
      return result;
    },
    disconnect: (phone, key) => call({ action: 'disconnect', phone, ...(key ? { key } : {}) }),
  };
}
