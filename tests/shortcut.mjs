import assert from 'node:assert/strict';
import {shortcutConfig, checkInstagram} from '../docs/shortcut.js';
const key='12345678-1234-4234-8234-123456789abc';
const config=shortcutConfig(key,'America/Denver','https://example.com/first-things-PWA/?old=1#x');
assert.equal(new URL(config.url).searchParams.get('access_key'),key);
assert.equal(new URL(config.url).searchParams.get('timezone_name'),'America/Denver');
assert.equal(config.reminder,'https://example.com/first-things-PWA/?instagram=paused');
assert.throws(()=>shortcutConfig('not-a-key','UTC','https://example.com/'));
for(const decision of ['allow','pause','refresh']) {
  const result=await checkInstagram(config,async(url,options)=>{
    assert.equal(url,config.url);assert.equal(options.cache,'no-store');
    assert.equal(options.headers.apikey,config.apiKey);
    return {ok:true,json:async()=>({decision,message:'Test'})};
  });
  assert.equal(result.decision,decision);
}
await assert.rejects(checkInstagram(config,async()=>({ok:false})));
await assert.rejects(checkInstagram(config,async()=>({ok:true,json:async()=>({decision:'unknown'})})));
await assert.rejects(checkInstagram(config,async()=>{throw Error('offline');}));
console.log('PASS Instagram scoped URLs, private status requests, decisions and network failures');
