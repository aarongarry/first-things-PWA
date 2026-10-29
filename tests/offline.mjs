import assert from 'node:assert/strict';
import { normalizePhone, accountSnapshot, applySnapshot, mergeSnapshots, createAccountStore } from '../docs/offline.js';
import { initial, addTask } from '../docs/model.js';
const phone = normalizePhone('(555) 123-4567');
assert.equal(phone, normalizePhone('+1 555 123 4567'));
assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
assert.throws(() => normalizePhone('bad'));
const memory = () => {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), key: i => [...values.keys()][i], get length() { return values.size; } };
};
const make = () => { const s = initial(); s.profile = { name: 'Tester', phone }; s.onboarded = true; return accountSnapshot(s); };
const cloud = new Map();
let available = true, conflictOnce = false;
const remote = {
  async load(p) { if (!available) throw Error('network failed'); return structuredClone(cloud.get(p) || { version: 0, state: null }); },
  async save(p, state, version) {
    if (!available) throw Error('network failed');
    if (conflictOnce) { conflictOnce = false; return { conflict: true }; }
    if ((cloud.get(p)?.version || 0) !== version) return { conflict: true };
    cloud.set(p, { version: version + 1, state: structuredClone(state) });
    return { version: version + 1 };
  },
};
const storage = memory();
let online = true;
const statuses = [];
const create = (storage) => createAccountStore({ storage, remote, online: () => online, report: (...v) => statuses.push(v) });
let a = create(storage);
a.open(phone, make());
await a.sync(phone);
assert.equal(cloud.get(phone).version, 1);
// Offline changes are durable across a completely new store instance.
online = false;
let before = a.read(phone).local;
let edited = structuredClone(before);
edited.tasks.push({ id:'a', title:'Offline task', done:false, goalId:'' });
a.update(phone, before, edited);
await a.sync(phone);
assert.equal(statuses.at(-1)[1], 'offline');
a = create(storage);
assert.equal(a.read(phone).local.tasks[0].title, 'Offline task');
online = true;
await a.sync(phone);
assert.equal(cloud.get(phone).state.tasks[0].title, 'Offline task');
// A different device loads the same account, irrespective of entered name.
const b = create(memory());
b.open(phone, { ...make(), profile: {phone, name:'Different input'} });
await b.sync(phone);
assert.equal(b.read(phone).local.profile.name, 'Tester');
assert.equal(b.read(phone).local.tasks[0].title, 'Offline task');
// Concurrent changes to separate fields and independent additions all survive.
const aBefore = a.read(phone).local, bBefore = b.read(phone).local;
const aNext = structuredClone(aBefore), bNext = structuredClone(bBefore);
aNext.tasks[0].done = true;
aNext.tasks.push({ id:'a2', title:'Device A', done:false, goalId:'' });
bNext.tasks[0].title = 'Edited on B';
bNext.tasks.push({ id:'b2', title:'Device B', done:false, goalId:'' });
a.update(phone, aBefore, aNext); b.update(phone, bBefore, bNext);
await b.sync(phone); conflictOnce = true; await a.sync(phone);
assert.equal(cloud.get(phone).state.tasks.length, 3);
assert.equal(cloud.get(phone).state.tasks.find(t => t.id === 'a').done, true);
assert.equal(cloud.get(phone).state.tasks.find(t => t.id === 'a').title, 'Edited on B');
// Deleted items don't resurrect when another device edits stale data.
await b.sync(phone);
const base = a.read(phone).local;
const deleted = structuredClone(base); deleted.tasks = deleted.tasks.filter(t => t.id !== 'a');
a.update(phone, base, deleted); await a.sync(phone);
const stale = b.read(phone).local, staleEdit = structuredClone(stale); staleEdit.tasks[0].title = 'Stale edit';
b.update(phone, stale, staleEdit); await b.sync(phone);
assert.equal(cloud.get(phone).state.tasks.some(t => t.id === 'a'), false);
// Network errors leave edits queued for a later retry.
available = false;
before = a.read(phone).local; edited = structuredClone(before); edited.profile.name = 'Offline name';
a.update(phone, before, edited); await a.sync(phone);
assert.equal(statuses.at(-1)[1], 'error');
available = true; await a.sync(phone);
assert.equal(cloud.get(phone).state.profile.name, 'Offline name');
// Account isolation and pending accounts remain discoverable after sign-out.
const other = normalizePhone('5551234568');
a.open(other, { ...make(), profile: {name:'Other', phone:other} });
assert.equal(a.read(other).local.tasks.length, 0);
assert.equal(a.phones().length, 2);
// Writes made during a network save survive its acknowledgement.
let release, saving;
const gated = { ...remote, async save(...args) { saving = true; await new Promise(r => release = r); return remote.save(...args); } };
const cStorage = memory();
const c = createAccountStore({storage:cStorage, remote:gated});
c.open(phone, make());
await c.sync(phone); // initial load matches existing remote, so no gated write
before=c.read(phone).local; edited=structuredClone(before); edited.profile.name='First edit';
c.update(phone,before,edited);
const pending=c.sync(phone);
while (!saving) await new Promise(r => setImmediate(r));
const inFlight=c.read(phone).local, newer=structuredClone(inFlight); newer.profile.name='Newer edit';
c.update(phone,inFlight,newer);
// Release first and subsequent gated saves.
const timer=setInterval(()=>release?.(),1);
await pending; clearInterval(timer);
assert.equal(cloud.get(phone).state.profile.name,'Newer edit');
// Storage failures must propagate instead of reporting successful local saves.
const blocked=createAccountStore({storage:{getItem:()=>null,setItem(){throw Error('quota');}}});
assert.throws(()=>blocked.open(phone,make()), /quota/);
const restored=applySnapshot(initial(),a.read(phone).local);
assert.equal(restored.profile.phone,phone);
console.log('PASS phone normalization, offline reload, reconnect, cross-device login, field merge, deletions, version conflict, network retry, account isolation, in-flight edits, storage failure');
