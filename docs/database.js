import { USE_SUPABASE, getSupabaseClient } from './supabase-config.js';

// Only database-backed fields enter this payload. Photos and chat are excluded.
export function databaseSnapshot(s) {
  return JSON.stringify({
    profile: s.profile,
    goals: s.goals,
    tasks: s.tasks,
    daily: {
      day: s.day, templates: s.templates, ledger: s.ledger,
      activeUntil: s.activeUntil, requestedBreaks: s.requestedBreaks,
      selectedApps: s.selectedApps, timeOffset: s.timeOffset,
    },
  });
}

// Serialize writes and keep failed changes in memory for an explicit retry.
export function createSync(write, report) {
  let saved = '', desired = '', running = false, failed = false;
  async function drain() {
    if (running || failed || desired === saved) return;
    running = true;
    report('saving');
    try {
      while (desired !== saved) {
        const payload = desired;
        await write(JSON.parse(payload));
        saved = payload;
      }
      report('saved');
    } catch (error) {
      failed = true;
      report('error', error.message || String(error));
    } finally {
      running = false;
    }
  }
  return {
    seed(payload) { saved = desired = payload; },
    push(payload) { desired = payload; void drain(); },
    retry() { failed = false; void drain(); },
    pending() { return desired !== saved; },
  };
}

export async function connectDatabase() {
  if (!USE_SUPABASE) return null;
  const db = await getSupabaseClient();
  const { data, error } = await db.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    const { error } = await db.auth.signInAnonymously();
    if (error) throw error;
  }
  const loaded = await db.rpc('first_things_load');
  if (loaded.error) throw loaded.error;
  let version = loaded.data.version;
  return {
    state: loaded.data.state,
    async save(snapshot) {
      const result = await db.rpc('first_things_save', {
        payload: snapshot, expected_version: version,
      });
      if (result.error) throw result.error;
      version = result.data;
    },
  };
}
