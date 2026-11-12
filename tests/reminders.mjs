import assert from 'node:assert/strict';
import { validTime, formatTime, urlBase64ToUint8Array, reminderPrefs, reminderSupport } from '../docs/reminders.js';

assert.equal(validTime('18:00'), true);
assert.equal(validTime('07:05'), true);
assert.equal(validTime('24:00'), false);
assert.equal(validTime('6:00'), false);
assert.equal(validTime(''), false);
assert.equal(formatTime('18:30'), '6:30 PM');
assert.equal(formatTime('nope'), '');
assert.deepEqual([...urlBase64ToUint8Array('AQID')], [1, 2, 3]);
assert.deepEqual([...urlBase64ToUint8Array('-_8')], [251, 255]);

const store = data => ({ getItem: () => data, setItem() {} });
assert.deepEqual(reminderPrefs('+15551234567', store(JSON.stringify({ on: true, phone: '+15551234567', time: '09:15' }))), { on: true, time: '09:15' });
assert.equal(reminderPrefs('+15559999999', store(JSON.stringify({ on: true, phone: '+15551234567', time: '09:15' }))).on, false);
assert.equal(reminderPrefs('+1555', store('not json')).on, false);
assert.equal(reminderPrefs('+1555', { getItem() { throw Error('blocked'); } }).on, false);

// With no public key configured the feature reports it needs setup instead of failing.
assert.deepEqual(reminderSupport({ navigator: {} }), { ok: false, reason: 'setup' });
console.log('PASS reminder time validation, key decoding, per-account preferences, setup detection');
