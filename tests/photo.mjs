import assert from 'node:assert/strict';
import { createHandler, PER_ACCOUNT_DAILY, MAX_IMAGE_CHARS } from '../supabase/functions/verify-photo/handler.js';
import { createJudge, MODEL, SCHEMA } from '../supabase/functions/verify-photo/judge.js';
import { createPhotoChecker, dayPhotos, keepPhoto, forgetPhoto, PHOTO_FUNCTION_URL, PHOTO_STORE_PREFIX } from '../docs/photo.js';
import { initial, addTask, photoAttempt } from '../docs/model.js';

const APP = 'https://aarongarry.github.io';
const env = { ANTHROPIC_API_KEY: 'sk-test', APP_ORIGINS: `${APP},http://localhost:4173` };
const PHONE = '+15555550123', ID = 'identity-1';
const IMAGE = Buffer.from('fake jpeg bytes').toString('base64');

function world({ verdict = 'pass', limit = PER_ACCOUNT_DAILY, judgeFails = false } = {}) {
  const db = {
    accounts: new Map([[PHONE, ID]]), counts: new Map(),
    accountId: async phone => db.accounts.get(phone) ?? null,
    takeCheck: async (id, perAccount) => {
      const used = db.counts.get(id) ?? 0;
      if (used >= Math.min(perAccount, limit)) return 'account';
      db.counts.set(id, used + 1);
      return 'ok';
    },
  };
  const judged = [];
  const judge = async input => {
    judged.push(input);
    if (judgeFails) throw Error('Anthropic is down');
    return { verdict, reason: `Saw ${input.title}.` };
  };
  return { db, judged, handle: createHandler({ env, db, judge }) };
}
const post = (body, origin = APP) => new Request('https://fn.test/verify-photo', {
  method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: JSON.stringify(body),
});
const good = (extra = {}) => ({ phone: PHONE, title: 'Read chapter 3', image: IMAGE, mediaType: 'image/jpeg', ...extra });
const quiet = async fn => { const log = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = log; } };

// --- Edge Function handler ---------------------------------------------------
{
  const { handle, judged, db } = world();
  const response = await handle(post(good()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { verdict: 'pass', reason: 'Saw Read chapter 3.' });
  assert.equal(response.headers.get('access-control-allow-origin'), APP);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(judged[0], { image: IMAGE, mediaType: 'image/jpeg', title: 'Read chapter 3' });
  assert.equal(db.counts.get(ID), 1);
  for (const verdict of ['fail', 'unsure'])
    assert.equal((await (await world({ verdict }).handle(post(good()))).json()).verdict, verdict);
  console.log('PASS checks a photo and returns pass, unsure or fail');
}
{
  const { handle, judged } = world();
  assert.equal((await handle(post(good(), 'https://evil.test'))).status, 403);
  assert.equal((await handle(new Request('https://fn.test/', { method: 'OPTIONS', headers: { origin: APP } }))).status, 204);
  assert.equal((await handle(new Request('https://fn.test/', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }))).status, 403);
  assert.equal((await handle(new Request('https://fn.test/', { method: 'GET', headers: { origin: APP } }))).status, 404);
  for (const bad of [
    { phone: '5555550123' }, { title: '' }, { title: 'x'.repeat(201) }, { mediaType: 'image/gif' },
    { image: '' }, { image: 'not base64!' }, { image: 'A'.repeat(MAX_IMAGE_CHARS + 4) },
  ]) assert.equal((await handle(post(good(bad)))).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal(judged.length, 0, 'bad requests never reach Claude');
  assert.throws(() => createHandler({ env: { APP_ORIGINS: APP }, db: {}, judge: async () => ({}) }), /ANTHROPIC_API_KEY/);
  console.log('PASS origin, method and input checks, and a missing API key');
}
{
  const { handle, judged, db } = world({ limit: 2 });
  db.accounts.delete(PHONE);
  let response = await handle(post(good()));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).fallback, true);
  db.accounts.set(PHONE, ID);
  await handle(post(good())); await handle(post(good()));
  response = await handle(post(good()));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).fallback, true);
  assert.equal(judged.length, 2, 'the daily limit stops calls to Claude');
  const down = world({ judgeFails: true });
  response = await quiet(() => down.handle(post(good())));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).fallback, true);
  console.log('PASS unsynced accounts, daily limits and outages fall back to photo-as-proof');
}

// --- Claude request (judge) ----------------------------------------------------
{
  const requests = [];
  const client = reply => ({ messages: { create: async request => { requests.push(request); return reply; } } });
  const answer = (verdict, reason) => ({ stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: JSON.stringify({ verdict, reason }) },
  ] });
  const result = await createJudge(client(answer('pass', '  Your notes are open on the desk.  ')))({ image: IMAGE, mediaType: 'image/jpeg', title: 'Review notes' });
  assert.deepEqual(result, { verdict: 'pass', reason: 'Your notes are open on the desk.' });
  const request = requests[0];
  assert.equal(request.model, MODEL);
  assert.equal(MODEL, 'claude-haiku-5-5');
  assert.deepEqual(request.output_config, { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } });
  assert.ok(request.max_tokens >= 1024, 'room for thinking before the answer');
  for (const banned of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(banned in request, false);
  const [image, text] = request.messages[0].content;
  assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE } });
  assert.equal(text.text, 'Task: "Review notes"');
  assert.equal(request.messages.at(-1).role, 'user');

  assert.equal((await createJudge(client({ stop_reason: 'refusal', content: [] }))({ image: IMAGE, mediaType: 'image/jpeg', title: 'x' })).verdict, 'fail');
  await assert.rejects(createJudge(client({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }))({ image: IMAGE, mediaType: 'image/jpeg', title: 'x' }));
  await assert.rejects(createJudge(client(answer('maybe', 'hm')))({ image: IMAGE, mediaType: 'image/jpeg', title: 'x' }));
  const long = await createJudge(client(answer('fail', 'x'.repeat(500))))({ image: IMAGE, mediaType: 'image/jpeg', title: 'x' });
  assert.equal(long.reason.length, 200);
  console.log('PASS Claude request uses Haiku 5.5, low effort, JSON schema, and handles refusals and bad answers');
}

// --- Browser client ------------------------------------------------------------
{
  const photo = { image: IMAGE, mediaType: 'image/jpeg' };
  const calls = [];
  const reply = (body, status = 200) => async (url, options) => { calls.push({ url, options }); return Response.json(body, { status }); };
  let check = createPhotoChecker(reply({ verdict: 'fail', reason: 'That looks like the floor.' }));
  assert.deepEqual(await check(PHONE, 'Read', photo), { verdict: 'fail', reason: 'That looks like the floor.' });
  assert.equal(calls[0].url, PHOTO_FUNCTION_URL);
  assert.equal(calls[0].options.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.deepEqual(JSON.parse(calls[0].options.body), { phone: PHONE, title: 'Read', image: IMAGE, mediaType: 'image/jpeg' });

  check = createPhotoChecker(reply({ error: 'Photo checks are resting for today, so your photo counts as proof.', fallback: true }, 429));
  assert.deepEqual(await check(PHONE, 'Read', photo), { fallback: true, message: 'Photo checks are resting for today, so your photo counts as proof.' });
  check = createPhotoChecker(async () => { throw TypeError('offline'); });
  assert.equal((await check(PHONE, 'Read', photo)).fallback, true);
  check = createPhotoChecker(reply({ error: 'Not found.' }, 404));
  assert.equal((await check(PHONE, 'Read', photo)).fallback, true, 'function not deployed yet');
  check = createPhotoChecker(reply({ error: 'That photo couldn’t be read. Try taking it again.' }, 400));
  await assert.rejects(check(PHONE, 'Read', photo), /couldn’t be read/);
  console.log('PASS client maps verdicts, falls back when offline or limited, and reports bad photos');
}
{
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  keepPhoto(storage, PHONE, '2026-11-07', 't1', 'data:image/jpeg;base64,AAA');
  keepPhoto(storage, PHONE, '2026-11-07', 't2', 'data:image/jpeg;base64,BBB');
  assert.deepEqual(Object.keys(dayPhotos(storage, PHONE, '2026-11-07')), ['t1', 't2']);
  assert.deepEqual(dayPhotos(storage, '+15555550999', '2026-11-07'), {}, 'accounts are separate');
  forgetPhoto(storage, PHONE, '2026-11-07', 't1');
  assert.deepEqual(Object.keys(dayPhotos(storage, PHONE, '2026-11-07')), ['t2']);
  assert.deepEqual(dayPhotos(storage, PHONE, '2026-11-08'), {}, 'midnight clears them');
  assert.equal(store.has(PHOTO_STORE_PREFIX + PHONE), false);
  for (let i = 0; i < 25; i++) keepPhoto(storage, PHONE, '2026-11-08', `t${i}`, 'data:image/jpeg;base64,C');
  assert.equal(Object.keys(dayPhotos(storage, PHONE, '2026-11-08')).length, 20, 'keeps at most 20');
  store.set(PHOTO_STORE_PREFIX + PHONE, '{broken');
  assert.deepEqual(dayPhotos(storage, PHONE, '2026-11-08'), {});
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  keepPhoto(blocked, PHONE, '2026-11-08', 't', 'x');
  assert.deepEqual(dayPhotos(blocked, PHONE, '2026-11-08'), {});
  console.log('PASS today’s photos stay per account until midnight, capped, and survive blocked storage');
}
{
  const s = initial();
  const t = addTask(s, { title: 'Stretch', photo: true });
  assert.equal(photoAttempt(s, t.id, 0), 'retry');
  assert.equal(photoAttempt(s, t.id, 0), 'retry');
  assert.equal(photoAttempt(s, t.id, 0), 'supported');
  assert.equal(t.done, true);
  const u = addTask(s, { title: 'Walk', photo: true });
  assert.equal(photoAttempt(s, u.id, 1), 'verified');
  assert.equal(addTask(s, { title: 'Plain' }).photo, false, 'photo checks stay opt-in');
  console.log('PASS three failed checks still complete the task; photo checks stay opt-in');
}
