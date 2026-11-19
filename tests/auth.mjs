// Checks the cookie storage used for admin sign-in (docs/auth.js).
// A real Supabase session is bigger than one cookie, so it must be split across
// several cookies and put back together, and Logout must remove every piece.
import assert from 'node:assert/strict';

// A tiny fake browser cookie jar: understands "name=value; max-age=0" (delete).
const jar = new Map();
globalThis.location = { protocol: 'https:' };
globalThis.document = {
  get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
  set cookie(text) {
    const [pair, ...attrs] = text.split('; ');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    if (attrs.includes('max-age=0')) jar.delete(name); else jar.set(name, value);
    // Browsers drop cookies over ~4 KB; fail loudly if we ever write one that big.
    assert.ok(pair.length < 4000, `cookie "${name}" is too large for browsers`);
  },
};

const { cookieStorage } = await import('../docs/auth.js');

// A session-shaped value, well over 4 KB, with characters that need URL-encoding.
const session = JSON.stringify({ access_token: 'a.b.c'.repeat(900), user: { email: 'ta+grader@example.com', note: 'é ü "quotes" ; = &' } });
assert.ok(session.length > 4500);

cookieStorage.setItem('ft-admin-auth', session);
assert.ok(jar.size > 1, 'a large session is split into several cookies');
assert.equal(cookieStorage.getItem('ft-admin-auth'), session, 'pieces are rejoined exactly');

// Saving a smaller value must not leave pieces of the old one behind.
cookieStorage.setItem('ft-admin-auth', '{"small":true}');
assert.equal(jar.size, 1);
assert.equal(cookieStorage.getItem('ft-admin-auth'), '{"small":true}');

// Logout: every piece is removed.
cookieStorage.setItem('ft-admin-auth', session);
cookieStorage.removeItem('ft-admin-auth');
assert.equal(jar.size, 0);
assert.equal(cookieStorage.getItem('ft-admin-auth'), null);
console.log('PASS admin session cookies: split, rejoin, shrink, and logout removes them all');
