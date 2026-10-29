import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
const manifest = JSON.parse(await readFile(new URL('../docs/manifest.webmanifest',import.meta.url),'utf8'));
assert.equal(manifest.start_url,'./'); assert.equal(manifest.scope,'./'); assert.equal(manifest.display,'standalone');
for (const icon of manifest.icons) await access(new URL('../docs/'+icon.src,import.meta.url));
const handlers = {}, cached = new Map(); let claims=0, skipped=0;
const origin='https://example.test/first-things-PWA/';
const cache = {
  async addAll(paths) { for(const p of paths) { await access(new URL('../docs/'+(p==='./'?'index.html':p),import.meta.url)); cached.set(new URL(p,origin).href,{asset:p}); } },
  async match(p) { return cached.get(new URL(typeof p==='string'?p:p.url,origin).href); },
};
vm.runInNewContext(await readFile(new URL('../docs/sw.js',import.meta.url),'utf8'),{
  URL, Set, caches:{open:async()=>cache,keys:async()=>['other-app','first-things-shell-old','first-things-shell-v3'],delete:async key=>assert.equal(key,'first-things-shell-old')},
  fetch:()=>{throw Error('offline');},
  self:{registration:{scope:origin},clients:{claim:async()=>claims++},skipWaiting:()=>skipped++,addEventListener:(n,fn)=>handlers[n]=fn},
});
let work; handlers.install({waitUntil:p=>work=p}); await work;
handlers.activate({waitUntil:p=>work=p}); await work; assert.equal(claims,1);
let response;
handlers.fetch({request:{method:'GET',url:origin,mode:'navigate'},respondWith:p=>response=p});
assert.equal((await response).asset,'./index.html');
handlers.fetch({request:{method:'GET',url:origin+'offline.js',mode:'cors'},respondWith:p=>response=p});
assert.equal((await response).asset,'./offline.js');
let intercepted=false;
for (const request of [{method:'POST',url:'https://db.test/rest/v1/rpc/save'}, {method:'GET',url:'https://db.test/rest/v1/rpc/load'},{method:'GET',url:'https://example.test/another-app/'}])
  handlers.fetch({request,respondWith:()=>intercepted=true});
assert.equal(intercepted,false);
handlers.message({data:{type:'ACTIVATE_UPDATE'}}); assert.equal(skipped,1);
console.log('PASS install assets, subpath scope, offline navigation/modules, API exclusion, scoped cache cleanup, update activation');
