import assert from 'node:assert/strict';
import { createAccountStore, accountSnapshot, normalizePhone } from '../docs/offline.js';
import { initial, addTask } from '../docs/model.js';
const phone = '+12025550160', target = '+12025550161', taken = '+12025550162';
const data = new Map();
let online = true, lostResponse = false, failTargetWrite = false;
const storage = {
  getItem:k=>data.get(k)??null,
  setItem(k,v) { if(failTargetWrite && k.endsWith(target)) { failTargetWrite=false; throw Error('quota'); } data.set(k,v); },
  key:i=>[...data.keys()][i], get length(){return data.size;},
};
const s=initial(); s.profile={phone,name:'Original'};s.onboarded=true;addTask(s,{title:'Keep my task'});
const seed=accountSnapshot(s), cloud=new Map();
const remote={
  async load(p){return structuredClone(cloud.get(p)??{version:0,state:null});},
  async save(p,state,version){
    const old=cloud.get(p);if(old?.retired)return {retired:true};
    if((old?.version??0)!==version)return {conflict:true};
    cloud.set(p,{state:structuredClone(state),version:version+1,identity:old?.identity??crypto.randomUUID()});return {version:version+1};
  },
  async rename(p,to,name,version,id){
    const old=cloud.get(p);
    if(old.retired)return old.moveId===id&&old.to===to?structuredClone(cloud.get(to)):{retired:true};
    const targetRow=cloud.get(to);
    if(targetRow && (!targetRow.retired || targetRow.identity!==old.identity))return {taken:true};
    if(old.version!==version)return {conflict:true};
    const result={version:version+1,identity:old.identity,state:{...structuredClone(old.state),profile:{phone:to,name}}};
    cloud.set(to,result);cloud.set(p,{retired:true,moveId:id,to,identity:old.identity});
    if(lostResponse){lostResponse=false;throw Error('response lost');}
    return structuredClone(result);
  },
};
const events=[];
const options={storage,remote,online:()=>online,renamed:(...args)=>events.push(args)};
let store=createAccountStore(options);store.open(phone,seed);await store.sync(phone);
// Name changes remain an ordinary offline edit, including phone formatting equivalence.
assert.equal(normalizePhone('(202) 555-0160'),phone);
const next=structuredClone(seed);next.profile.name='Updated offline';online=false;
store.update(phone,seed,next);await store.sync(phone);
assert.equal(store.read(phone).local.profile.name,'Updated offline');
await assert.rejects(store.rename(phone,target,'New name'),/internet/);
assert.equal(store.read(phone).pendingMove,undefined);
online=true;await store.sync(phone);
// A destination account is never overwritten, and source tasks remain intact.
cloud.set(taken,{version:1,state:{...seed,profile:{phone:taken,name:'Another user'}}});
await assert.rejects(store.rename(phone,taken,'New name'),/already belongs/);
assert.equal(cloud.get(taken).state.profile.name,'Another user');
assert.equal(cloud.get(phone).state.tasks[0].title,'Keep my task');
// Lost acknowledgement: reload a fresh store and finish exactly the same move.
lostResponse=true;
await assert.rejects(store.rename(phone,target,'New name'),/response lost/);
assert.ok(store.read(phone).pendingMove);
store=createAccountStore(options);
failTargetWrite=true;
await store.sync(phone); // remote succeeded but local quota failure leaves journal
assert.ok(store.read(phone).pendingMove);
await store.sync(phone);
assert.equal(store.read(target).local.profile.name,'New name');
assert.equal(store.read(target).local.profile.phone,target);
assert.equal(store.read(target).local.tasks[0].title,'Keep my task');
assert.equal(events.length,1);
assert.equal(store.read(phone).retired,true);
assert.equal(store.read(phone).pendingMove,undefined);
assert.throws(()=>store.open(phone,seed),/new number/);
assert.deepEqual(store.phones(),[target]);
// Old devices cannot recreate the retired account or overwrite its destination.
assert.equal((await remote.save(phone,seed,0)).retired,true);
// Changed phone remains usable for future edits and syncing.
const current=store.read(target).local, edited=structuredClone(current);
edited.tasks[0].done=true;store.update(target,current,edited);await store.sync(target);
assert.equal(cloud.get(target).state.tasks[0].done,true);
await assert.rejects(store.rename(target,'bad','Name'),/valid phone/);
await assert.rejects(store.rename(target,'+12025550163',' '),/name/);
const retiredCache=storage.getItem('first-things-account-v1:'+phone);
await store.rename(target,phone,'Back to original number');
assert.equal(store.read(phone).local.profile.phone,phone);
assert.equal(store.read(phone).local.tasks[0].done,true);
assert.equal(store.read(target).retired,true);
storage.setItem('first-things-account-v1:'+phone,retiredCache);
await store.refreshRetired(phone);
assert.equal(store.open(phone,seed).local.tasks[0].done,true);
console.log('PASS offline name edits, online-only number changes, destination collision, lost-response recovery, storage recovery, task retention, retired number protection, subsequent sync');
