import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';

export function createCloud(fetcher = fetch) {
  async function rpc(name, body) {
    const response = await fetcher(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000), cache: 'no-store',
    });
    if (!response.ok) {
      if (response.status === 404) throw Error('Cloud setup is not ready. Your changes are saved on this device.');
      throw Error('Cloud is unavailable. Your changes are saved on this device; we’ll retry.');
    }
    return response.json();
  }
  return {
    rename: (phone, target, name, version, requestId) => rpc('first_things_demo_rename', {
      account_phone: phone, new_phone: target, new_name: name,
      expected_version: version, request_id: requestId,
    }),
    load: phone => rpc('first_things_demo_load', { account_phone: phone }),
    save: (phone, state, version) => rpc('first_things_demo_save', {
      account_phone: phone, payload: state, expected_version: version,
    }),
  };
}
