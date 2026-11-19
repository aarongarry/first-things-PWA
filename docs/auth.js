// =====================================================================
// auth.js - sign-in / sign-out for the landing page and the admin pages.
//
// What it does:
//   * Signs in with Supabase Auth (e-mail + password).
//   * Keeps the session in COOKIES (not localStorage), so "Logout" really removes
//     the cookies, as the assignment requires.
//   * Asks the database "am I an admin?" (public.admin_whoami in supabase/admin.sql).
//   * Wraps the calls the admin pages make (RPC functions + the admin-users Edge Function).
//
// This is separate from the phone app (app.html), which uses anonymous sign-in and
// its own storage. Admin sessions use their own storage key so the two never mix.
// =====================================================================
import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';

const STORAGE_KEY = 'ft-admin-auth';   // base name of the session cookie(s)
const CHUNK_SIZE = 3000;               // browsers cap one cookie at ~4 KB; the session is bigger
const MAX_CHUNKS = 10;                 // safety limit when reading/clearing chunks
const MAX_AGE = 60 * 60 * 24 * 7;      // cookie lifetime: 7 days (in seconds)

// ---------- Cookie storage ----------
// Supabase calls getItem / setItem / removeItem to save its session. A session token
// can be larger than one cookie allows, so we split it into numbered pieces:
//   ft-admin-auth.0, ft-admin-auth.1, ...
function cookieAttributes() {
  // "Secure" makes the browser send the cookie only over HTTPS (CloudFront). It is
  // skipped on plain http://localhost, where some browsers would refuse to save it.
  return `; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}

function readCookie(name) {
  const hit = document.cookie.split('; ').find(part => part.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

export const cookieStorage = {  // exported so tests/auth.mjs can check it
  // Put the pieces back together and decode them.
  getItem(key) {
    let encoded = '';
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const piece = readCookie(`${key}.${i}`);
      if (piece === null) break;
      encoded += piece;
    }
    return encoded ? decodeURIComponent(encoded) : null;
  },
  // Encode the value, split it into pieces, and write one cookie per piece.
  setItem(key, value) {
    cookieStorage.removeItem(key); // clear old pieces first so a shorter value leaves no leftovers
    const encoded = encodeURIComponent(value);
    for (let i = 0, n = 0; i < encoded.length; i += CHUNK_SIZE, n++) {
      document.cookie = `${key}.${n}=${encoded.slice(i, i + CHUNK_SIZE)}; max-age=${MAX_AGE}${cookieAttributes()}`;
    }
  },
  // Expire every piece immediately (max-age=0). This is what Logout relies on.
  removeItem(key) {
    for (let i = 0; i < MAX_CHUNKS; i++) {
      document.cookie = `${key}.${i}=; max-age=0${cookieAttributes()}`;
    }
  },
};

// ---------- Supabase client ----------
// The Supabase library is loaded only when needed, so the landing page still
// displays (read-only) if the visitor is offline.
let clientPromise;
export function getAuthClient() {
  if (!clientPromise) {
    clientPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          storage: cookieStorage,       // keep the session in cookies
          storageKey: STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,    // we never sign in through a link
        },
      }))
      .catch((error) => { clientPromise = undefined; throw error; });
  }
  return clientPromise;
}

// ---------- Public helpers ----------

// Is somebody signed in AND allowed to maintain data?
// Returns { email } for an admin, or null for everyone else.
export async function currentAdmin() {
  const client = await getAuthClient();
  const { data } = await client.auth.getSession();
  if (!data.session) return null;                       // nobody signed in
  const { data: who, error } = await client.rpc('admin_whoami');
  if (error || !who?.is_admin) return null;             // signed in, but not an admin
  return { email: who.email || data.session.user.email };
}

// Sign in with e-mail + password. Throws a friendly Error if it fails or the
// account is not an admin (in that case the session is removed again).
export async function signIn(email, password) {
  const client = await getAuthClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error('That e-mail and password did not match. Please try again.');
  const admin = await currentAdmin();
  if (!admin) {
    await signOut();
    throw new Error('This account is not allowed to maintain data.');
  }
  return admin;
}

// Sign out: end the session on this browser and make sure every cookie is gone.
export async function signOut() {
  try {
    const client = await getAuthClient();
    await client.auth.signOut({ scope: 'local' });
  } catch { /* even if the network fails, still clear the cookies below */ }
  cookieStorage.removeItem(STORAGE_KEY);
}

// Call one of the admin SQL functions, e.g. rpc('admin_list_users').
// Returns the data or throws an Error with a readable message.
export async function rpc(name, args = {}) {
  const client = await getAuthClient();
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// Call the admin-users Edge Function (create/update/delete a LOGIN account).
// These need the server-side service key, so they cannot run in the browser.
export async function adminFunction(body) {
  const client = await getAuthClient();
  const { data, error } = await client.functions.invoke('admin-users', { body });
  if (error) {
    // For HTTP errors the real message is in the response body.
    let message = error.message;
    try { message = (await error.context.json()).error || message; } catch { /* keep default */ }
    throw new Error(message);
  }
  return data;
}
