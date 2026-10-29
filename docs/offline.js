// Small demo accounts are saved atomically as one JSON record per phone number.
// The last cloud snapshot is retained to merge offline changes, not overwrite it.
export const ACCOUNT_PREFIX = 'first-things-account-v1:';
const copy = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizePhone(value) {
  const text = String(value).trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) throw Error('Enter a valid phone number.');
  let digits = text.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length < 11 || digits.length > 15) throw Error('Use 10 digits for US/Canada, or include your country code.');
  return '+' + digits;
}

export function accountSnapshot(s) {
  return copy({
    profile: s.profile, onboarded: s.onboarded, tone: s.tone,
    answers: s.answers, calendar: s.calendar, tutorial: s.tutorial,
    goals: s.goals, tasks: s.tasks,
    daily: { day: s.day, templates: s.templates, ledger: s.ledger,
      activeUntil: s.activeUntil, requestedBreaks: s.requestedBreaks,
      selectedApps: s.selectedApps, timeOffset: s.timeOffset },
  });
}

export function applySnapshot(s, snapshot) {
  if (!snapshot) return s;
  const { daily, ...rest } = copy(snapshot);
  Object.assign(s, rest, daily);
  s.loginVerified = true;
  return s;
}

// Three-way merge: unrelated changes survive. Local edits win a same-field
// conflict; deleting a task/goal wins over editing that deleted item.
export function mergeSnapshots(base, local, remote) {
  if (equal(local, base)) return copy(remote);
  if (equal(remote, base) || equal(local, remote)) return copy(local);
  if (local === undefined || remote === undefined) return undefined;
  if (Array.isArray(local) && Array.isArray(remote) &&
      [...local, ...remote, ...(Array.isArray(base) ? base : [])].every(x => object(x) && typeof x.id === 'string')) {
    const b = new Map((base || []).map(x => [x.id, x]));
    const l = new Map(local.map(x => [x.id, x]));
    const r = new Map(remote.map(x => [x.id, x]));
    return [...new Set([...r.keys(), ...l.keys()])].map(id => {
      if (!b.has(id)) return copy(l.get(id) ?? r.get(id));
      return mergeSnapshots(b.get(id), l.get(id), r.get(id));
    }).filter(x => x !== undefined);
  }
  if (object(local) && object(remote)) {
    const result = {};
    for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      // A new field on either side is an addition, not a deletion.
      const value = base?.[key] === undefined && (local[key] === undefined || remote[key] === undefined)
        ? copy(local[key] ?? remote[key])
        : mergeSnapshots(base?.[key], local[key], remote[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  return copy(local);
}

export function createAccountStore({ storage, remote, online = () => true, report = () => {}, changed = () => {} }) {
  const running = new Map();
  const read = phone => {
    const raw = storage.getItem(ACCOUNT_PREFIX + phone);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record.schema !== 1 || !Array.isArray(record.local?.tasks) || !Array.isArray(record.local?.goals))
      throw Error('The saved account could not be read. Keep this browser’s data and contact your team.');
    return record;
  };
  const write = (phone, record) => {
    // Let storage failures reach the UI; never claim an edit is safely saved.
    storage.setItem(ACCOUNT_PREFIX + phone, JSON.stringify(record));
    return record;
  };
  function open(phone, seed) {
    return read(phone) || write(phone, { schema: 1, local: copy(seed), base: copy(seed), version: 0, linked: false });
  }
  function update(phone, previous, next) {
    const record = read(phone) || open(phone, next);
    record.local = mergeSnapshots(previous, next, record.local);
    write(phone, record);
    return copy(record.local);
  }
  async function drain(phone) {
    try {
      if (!remote) { report(phone, 'local'); return; }
      if (!online()) { report(phone, 'offline'); return; }
      report(phone, 'syncing');
      for (let attempt = 0; attempt < 5; attempt++) {
        const cloud = await remote.load(phone);
        let record = read(phone);
        if (!record) return;
        const captured = copy(record.local);
        let merged = cloud.state ? mergeSnapshots(record.base, captured, cloud.state) : captured;
        // Never recreate a deleted goal through a dangling task reference.
        const goals = new Set(merged.goals.map(g => g.id));
        for (const task of [...merged.tasks, ...(merged.daily.templates || [])])
          if (task.goalId && !goals.has(task.goalId)) task.goalId = '';
        let version = cloud.version;
        if (!equal(merged, cloud.state)) {
          const result = await remote.save(phone, merged, cloud.version);
          if (result.conflict) continue;
          version = result.version;
        }
        record = read(phone);
        record.local = mergeSnapshots(captured, record.local, merged);
        record.base = copy(merged);
        record.version = version;
        record.linked = true;
        write(phone, record);
        changed(phone, copy(record.local));
        if (equal(record.local, record.base)) { report(phone, 'saved'); return; }
      }
      report(phone, 'error', 'Changes are saved on this device. Sync will retry shortly.');
    } catch (error) {
      report(phone, online() ? 'error' : 'offline', error.message);
    }
  }
  function sync(phone) {
    if (!running.has(phone)) running.set(phone, drain(phone).finally(() => running.delete(phone)));
    return running.get(phone);
  }
  function phones() {
    const result = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(ACCOUNT_PREFIX)) result.push(key.slice(ACCOUNT_PREFIX.length));
    }
    return result;
  }
  return { read, open, update, sync, phones };
}
