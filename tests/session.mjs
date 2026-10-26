import assert from 'node:assert/strict';
import { initial, addTask } from '../dist/model.js';
import { SESSION_KEY, restoreLogin, saveLogin } from '../dist/session.js';
import { USE_SUPABASE, getSupabaseClient } from '../dist/supabase-config.js';
const values = new Map();
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};
const s = initial();
s.profile = { name: 'Test Person', phone: '5551234567' };
s.loginVerified = true;
s.onboarded = true;
s.goals = [{ id: 'g', title: 'Study' }];
addTask(s, { title: 'Must disappear', recurrence: 'daily', goalId: 'g' });
s.ledger = { 1: { used: false } };
s.activeUntil = Date.now() + 600000;
assert.equal(saveLogin(s, storage), true);
const saved = JSON.parse(storage.getItem(SESSION_KEY));
assert.deepEqual(Object.keys(saved).sort(), ['onboarded', 'profile', 'verified', 'version']);
// Model a page reload: a fresh state restores only the allowlisted login fields.
const reloaded = restoreLogin(initial(), storage);
assert.deepEqual(reloaded.profile, s.profile);
assert.equal(reloaded.screen, 'home');
assert.equal(reloaded.onboarded, true);
assert.deepEqual(reloaded.tasks, []);
assert.deepEqual(reloaded.templates, []);
assert.deepEqual(reloaded.goals, []);
assert.deepEqual(reloaded.ledger, {});
assert.equal(reloaded.activeUntil, 0);
// Edits to the profile persist; task payloads never enter localStorage.
s.profile.name = 'Updated Name';
saveLogin(s, storage);
assert.equal(restoreLogin(initial(), storage).profile.name, 'Updated Name');
assert.equal(storage.getItem(SESSION_KEY).includes('Must disappear'), false);
// A verified user midway through onboarding skips phone verification on reload.
s.onboarded = false;
saveLogin(s, storage);
assert.equal(restoreLogin(initial(), storage).screen, 'tone');
// Restart removes remembered login, while leaving unrelated storage untouched.
values.set('unrelated-app', 'keep');
saveLogin(initial(), storage);
assert.equal(storage.getItem(SESSION_KEY), null);
assert.equal(storage.getItem('unrelated-app'), 'keep');
assert.equal(restoreLogin(initial(), storage).screen, 'welcome');
// Corrupt and blocked storage are recoverable.
values.set(SESSION_KEY, '{bad json');
assert.equal(restoreLogin(initial(), storage).screen, 'welcome');
values.set(SESSION_KEY, JSON.stringify({ ...saved, verified: false }));
assert.equal(restoreLogin(initial(), storage).screen, 'welcome');
const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
assert.equal(restoreLogin(initial(), blocked).screen, 'welcome');
assert.equal(saveLogin(s, blocked), false);
if (!USE_SUPABASE) assert.equal(await getSupabaseClient(), null);
console.log('PASS login-only refresh, profile edits, onboarding, restart, corrupt/blocked storage, and disabled Supabase');
