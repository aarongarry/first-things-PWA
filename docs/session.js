// Remember only the demo login. Never store tasks, goals, or daily progress here.
export const SESSION_KEY = 'first-things-demo-login-v1';

export function restoreLogin(state, storage) {
  try {
    const saved = JSON.parse(storage.getItem(SESSION_KEY));
    if (saved?.version !== 1 || saved.verified !== true ||
        typeof saved.profile?.name !== 'string' || !saved.profile.name.trim() ||
        typeof saved.profile?.phone !== 'string' ||
        typeof saved.onboarded !== 'boolean') return state;
    state.profile = { name: saved.profile.name, phone: saved.profile.phone };
    state.loginVerified = true;
    state.onboarded = saved.onboarded;
    state.screen = saved.onboarded ? 'home' : 'tone';
  } catch {
    // Unavailable or invalid browser storage must not prevent using the demo.
  }
  return state;
}

export function saveLogin(state, storage) {
  try {
    if (!state.loginVerified) {
      storage.removeItem(SESSION_KEY);
    } else {
      storage.setItem(SESSION_KEY, JSON.stringify({
        version: 1,
        verified: true,
        onboarded: state.onboarded === true,
        profile: { name: state.profile.name, phone: state.profile.phone },
      }));
    }
    return true;
  } catch {
    return false;
  }
}
