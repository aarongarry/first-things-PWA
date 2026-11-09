// Daily task reminders (Web Push). The phone side: ask permission, subscribe, tell the server.
// The server side lives in supabase/reminders.sql and supabase/functions/send-reminders.
import { VAPID_PUBLIC_KEY } from './supabase-config.js';

const STORAGE_KEY = 'first-things-reminder';

export const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');

export function formatTime(value) {
  if (!validTime(value)) return '';
  const [h, m] = value.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function urlBase64ToUint8Array(base64) {
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

// { ok: true } or { ok: false, reason: 'setup' | 'install' | 'unsupported' }
export function reminderSupport(env = globalThis) {
  if (!VAPID_PUBLIC_KEY) return { ok: false, reason: 'setup' };
  const nav = env.navigator || {};
  const hasPush = 'serviceWorker' in nav && 'PushManager' in env && 'Notification' in env;
  if (hasPush) return { ok: true };
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent || '');
  return { ok: false, reason: ios ? 'install' : 'unsupported' };
}

export function reminderPrefs(phone, storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (saved?.on && saved.phone === phone && validTime(saved.time)) return { on: true, time: saved.time };
  } catch { /* storage can be unavailable; treat reminders as off */ }
  return { on: false, time: '18:00' };
}

function remember(value, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* best effort */ }
}

// Call straight from a tap: iPhones only show the permission prompt for a direct user action.
export async function enableReminders({ cloud, phone, time, beforeSave = async () => {} }) {
  if (!validTime(time)) throw Error('Pick a time for your reminder.');
  if (!reminderSupport().ok) throw Error('This browser can’t send reminders.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw Error('Notifications are turned off for First Things. Allow them in your phone’s settings, then try again.');
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  await beforeSave();
  await cloud.reminderSave(phone, subscription.toJSON(), time, Intl.DateTimeFormat().resolvedOptions().timeZone);
  remember({ on: true, phone, time });
}

export async function disableReminders({ cloud, phone }) {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      try { await cloud.reminderRemove(phone, subscription.endpoint); } catch { /* server cleans up dead endpoints */ }
      await subscription.unsubscribe();
    }
  } finally {
    remember({ on: false });
  }
}
