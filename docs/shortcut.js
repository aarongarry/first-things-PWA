import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';

export function shortcutConfig(key, zone, pageURL) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key)) throw Error('Shortcut setup returned an invalid link. Try again.');
  const url = new URL(`${SUPABASE_URL}/rest/v1/rpc/first_things_instagram_status`);
  url.searchParams.set('access_key', key);
  url.searchParams.set('timezone_name', zone);
  const reminder = new URL('./', pageURL);
  reminder.searchParams.set('instagram', 'paused');
  return { url: url.href, apiKey: SUPABASE_KEY, reminder: reminder.href, zone };
}

export async function checkInstagram(config, fetcher = fetch) {
  const response = await fetcher(config.url, {
    headers: { apikey: config.apiKey }, cache: 'no-store', signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error('Instagram check is unavailable. Reconnect and try again.');
  const result = await response.json();
  if (!['allow', 'pause', 'refresh'].includes(result?.decision) || typeof result.message !== 'string')
    throw Error('The check returned an unexpected response. Try again.');
  return result;
}
