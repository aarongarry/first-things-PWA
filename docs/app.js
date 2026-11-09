import {
  uid,
  localDay,
  now,
  initial,
  stats,
  reconcile,
  addTask,
  editTask,
  removeTask,
  completeTask,
  photoAttempt,
  startBreak,
  endBreak,
  breakEndPreview,
  urgencyRank,
  rollover,
  deleteGoal,
  suggest,
} from "./model.js";
import { restoreLogin, saveLogin } from "./session.js";
import { USE_SUPABASE, SUPABASE_URL, SUPABASE_KEY } from "./supabase-config.js";
import { createCloud } from "./cloud.js";
import { normalizePhone, accountSnapshot, applySnapshot, createAccountStore } from "./offline.js";
import { shortcutConfig, checkInstagram } from "./shortcut.js";
import { reminderSupport, reminderPrefs, enableReminders, disableReminders, formatTime } from "./reminders.js";
import { setupPWA } from "./pwa.js";
import { preparePhoto, createPhotoChecker, dayPhotos, keepPhoto, forgetPhoto } from "./photo.js";
import { createCalendar, deviceKey, forgetDeviceKey, moveDeviceKey, freeTime, eventTime, CALENDAR_RESULTS } from "./calendar.js";
const root = document.querySelector("#app"),
  modal = document.querySelector("#modal");
// Login and account data are stored separately, so signing out keeps queued edits.
let loginStorage;
try { loginStorage = window.localStorage; } catch { /* Storage may be blocked. */ }
let s = restoreLogin(initial(), loginStorage);
let error = "",
  busy = false,
  photo = null,
  photoTask = "",
  photoError = "",
  photoBusy = false,
  photoPreparing = false,
  toastTimer,
  returnTo = "home",
  taskDraft = null,
  goalDraft = null,
  calendarBusy = false,
  modalVersion = 0;
let activePhone = null;
// Today's Google Calendar, fetched for this device only. Never synced or saved.
const emptyCalendar = () => ({ phase: "idle", email: "", events: [], notice: "", phone: "", day: "", loadedAt: 0, loading: false });
let cal = emptyCalendar();
let hadCalendarKey = false;
const calendarApi = USE_SUPABASE ? createCalendar() : null;
const checkPhoto = USE_SUPABASE ? createPhotoChecker() : null;
const todaysPhotos = () => (activePhone ? dayPhotos(loginStorage, activePhone, localDay(now(s))) : {});
let lastSnapshot = null;
let syncTimer;
let legacyPhone = null;
let legacyImport = null;
let storageFailed = false;
// Progress report: Key Results are calculated by the database (first_things_okrs)
// from everyone's real activity. Nothing on that screen is hard-coded.
let okr = { phase: "idle", data: null, message: "", requestId: 0 };
// The sync status stays out of the way when all is well: routine messages ("Saved on this
// device", "Syncing…", "All changes synced") float over the top as a small pill and fade
// away. Anything that needs attention (offline, errors, a changed phone number, a
// storage problem) stays as a banner until it is fixed. Add ?status=on to the address to
// keep the banner visible all the time, for example during a demo.
const alwaysShowStatus = new URL(location.href).searchParams.get("status") === "on";
let statusFadeTimer;
function databaseStatus(phase, message = "") {
  const element = document.querySelector("#database-status");
  const labels = {
    welcome: "Your day, on any device.",
    local: "Saved on this device",
    offline: "Offline · Saved on this device. Syncs when you reconnect.",
    syncing: "Saved on this device · Syncing…",
    saved: "All changes synced",
    error: message || "Saved on this device · Cloud sync will retry.",
    storage: "Couldn’t save on this device. Keep this app open and free some storage.",
  };
  element.textContent = labels[phase] || message;
  element.dataset.phase = phase;
  const routine = ["local", "syncing", "saved"].includes(phase) && !alwaysShowStatus;
  element.classList.toggle("floating", routine);
  element.classList.remove("faded");
  clearTimeout(statusFadeTimer);
  // "Syncing…" stays until the sync finishes; the other two fade after a moment.
  if (routine && phase !== "syncing") {
    statusFadeTimer = setTimeout(() => element.classList.add("faded"), 2500);
  }
  if (phase === "moved") {
    root.inert = true;
    const button = document.createElement("button");
    button.textContent = "Sign out";
    button.addEventListener("click", signOut);
    element.append(" ", button);
  }
  if (phase === "error" || phase === "offline" || phase === "storage") {
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.type = "button";
    retry.addEventListener("click", () => { persistAccount(); syncAccounts(); });
    element.append(" ", retry);
  }
}
const cloud = USE_SUPABASE ? createCloud() : null;
const accounts = createAccountStore({
  storage: loginStorage,
  remote: cloud,
  online: () => navigator.onLine,
  report(phone, phase, message) {
    // Already showing "All changes synced"? A routine check has nothing to announce.
    // (Edits switch the status to "Saved on this device" first, so real saves still show.)
    const quiet = (phase === "syncing" || phase === "saved") && document.querySelector("#database-status")?.dataset.phase === "saved";
    if (phone === activePhone && !storageFailed && !quiet) databaseStatus(phase, message);
    // A sync just finished, so the Key Results may have moved.
    if (phase === "saved" && phone === activePhone && s.screen === "progress") void refreshOkrs();
  },
  renamed(oldPhone, newPhone, snapshot) {
    if (activePhone !== oldPhone) return;
    moveDeviceKey(loginStorage, oldPhone, newPhone);
    cal.phone = newPhone;
    activePhone = newPhone;
    applySnapshot(s, snapshot);
    lastSnapshot = accountSnapshot(s);
    rememberLogin();
    closeModal();
    render();
    toast("Profile updated. Use your new number next time you sign in.");
  },
  changed(phone, snapshot) {
    if (phone !== activePhone || storageFailed) return;
    const wasOnboarded = s.onboarded;
    const before = JSON.stringify(accountSnapshot(s));
    applySnapshot(s, snapshot);
    lastSnapshot = accountSnapshot(s);
    if (!wasOnboarded && s.onboarded) s.screen = "home";
    rememberLogin();
    // The background check runs every 30 seconds. If nothing is new, leave the screen
    // alone: redrawing it makes images and layout flicker for no reason.
    const somethingNew = JSON.stringify(lastSnapshot) !== before || (!wasOnboarded && s.onboarded);
    if (somethingNew && !modal.open && !document.activeElement?.matches('input, textarea, select')) render();
  },
});
function persistAccount() {
  if (!activePhone || !s.loginVerified) return;
  try {
    const next = accountSnapshot(s);
    const dirty = JSON.stringify(next) !== JSON.stringify(lastSnapshot);
    if (dirty || storageFailed) {
      applySnapshot(s, accounts.update(activePhone, lastSnapshot, next));
      lastSnapshot = accountSnapshot(s);
      storageFailed = false;
      databaseStatus(navigator.onLine ? "local" : "offline");
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncAccounts, 400);
    }
    rememberLogin();
  } catch {
    storageFailed = true;
    databaseStatus("storage");
  }
}
function syncAccounts() {
  if (storageFailed) return;
  if (legacyPhone && navigator.onLine) {
    if (!legacyImport) legacyImport = importLegacyAccount().finally(() => { legacyImport = null; });
    return;
  }
  try {
    // Also deliver edits queued under an account that has since signed out.
    for (const phone of accounts.phones()) void accounts.sync(phone);
  } catch { databaseStatus("storage"); }
}
// Import only the old anonymous session held by this browser, into its own
// remembered phone account. Original ERD records stay intact.
async function importLegacyAccount() {
  const phone = legacyPhone;
  try {
    const project = new URL(SUPABASE_URL).hostname.split(".")[0];
    const token = JSON.parse(loginStorage.getItem(`sb-${project}-auth-token`) || "null")?.access_token;
    if (token) {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/first_things_load`, {
        method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(12000),
      });
      if (response.ok) {
        const old = await response.json();
        if (old.state) {
          const record = accounts.read(phone);
          const previous = record.local;
          const imported = structuredClone(previous);
          imported.goals = old.state.goals;
          imported.tasks = old.state.tasks;
          imported.daily = { ...imported.daily, ...old.state.daily };
          imported.onboarded = true;
          const result = accounts.update(phone, record.base, imported);
          if (activePhone === phone) {
            applySnapshot(s, result); lastSnapshot = accountSnapshot(s); s.screen = "home"; render();
          }
        }
      } else if (response.status >= 500) throw Error("Legacy import unavailable");
    }
    legacyPhone = null;
    loginStorage.removeItem("first-things-legacy-pending");
    syncAccounts();
  } catch {
    if (activePhone === phone) databaseStatus("error", "Your new edits are saved locally. Reconnect to finish importing your previous tasks.");
  }
}
function activateAccount(phone, name = "") {
  if (accounts.read(phone)?.retired) throw Error("This account changed phone numbers. Sign in with the new number.");
  activePhone = phone;
  cal = emptyCalendar();
  const seed = initial();
  seed.profile = { phone, name: name || "Friend" };
  seed.loginVerified = true;
  s = seed;
  try {
    applySnapshot(s, accounts.open(phone, accountSnapshot(seed)).local);
    storageFailed = false;
  } catch { storageFailed = true; databaseStatus("storage"); }
  lastSnapshot = accountSnapshot(s);
  s.screen = s.onboarded ? "home" : "tone";
  rememberLogin();
}
function signOut() {
  persistAccount();
  root.inert = false;
  activePhone = null;
  lastSnapshot = null;
  cal = emptyCalendar();
  s = initial();
  rememberLogin();
  closeModal();
  databaseStatus("welcome");
  render();
}
window.addEventListener("online", syncAccounts);
window.addEventListener("offline", () => { if (activePhone && !storageFailed) databaseStatus("offline"); });
window.addEventListener("focus", syncAccounts);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) persistAccount();
  else syncAccounts();
});
window.addEventListener("pagehide", persistAccount);
setInterval(() => { if (!document.hidden) syncAccounts(); }, 30000);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
const icons = {
  back: '<path d="m14 6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
  goal: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 8-8"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-2 2v-10a9 9 0 1 1 19-1Z"/><path d="M7 11h10M7 15h6"/>',
settings: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
unlock:
    '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 7-2M12 14v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
  camera: '<path d="M3 7h4l2-3h6l2 3h4v14H3z"/><circle cx="12" cy="13" r="4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  leaf: '<path d="M5 19C0 5 12 2 21 3c0 12-5 20-16 16Zm0 0L15 9"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6M17 2v6M3 11h18"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4"/>',
  spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/>',
  send: '<path d="m3 3 19 9-19 9 4-9-4-9ZM7 12h15"/>',
  phone:
    '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${
    icons[name] || icons.spark
  }</svg>`;
const btn = (text, action, cls = "", attrs = "") =>
  `<button class="button ${cls}" data-action="${action}" ${attrs}>${text}</button>`;
const avatar = () => '<img class="avatar" src="george.png" alt="George">';
const bubble = (text) =>
  `<div class="george-bubble">${avatar()}<div class="bubble"><strong>GEORGE</strong>${text}</div></div>`;
const tones = {
  gentle: {
    label: "Gentle",
    symbol: "☁",
    example: "One small step is enough. I’m here with you.",
  },
  balanced: {
    label: "Balanced",
    symbol: "✳",
    example: "You’ve got this. Let’s make a little progress.",
  },
  direct: {
    label: "Direct",
    symbol: "↗",
    example: "Pick one task. Start small, and give it your attention.",
  },
};
const apps = [
  {
    name: "Instagram",
    short: "◎",
    color: "#d54882",
    desc: "A little less endless scrolling",
  },
  {
    name: "TikTok",
    short: "♪",
    color: "#182239",
    desc: "Save the next video for later",
  },
  {
    name: "YouTube",
    short: "▶",
    color: "#ef514f",
    desc: "Make your watch time intentional",
  },
  {
    name: "Reddit",
    short: "r",
    color: "#ee6a39",
    desc: "The threads will still be there",
  },
  {
    name: "X",
    short: "𝕏",
    color: "#1a2238",
    desc: "Give the feed a little pause",
  },
  {
    name: "Snapchat",
    short: "◉",
    color: "#d2a800",
    desc: "Catch up after a small win",
  },
];
function resizeAvatar(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) return reject(Error("empty image"));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error("bad image")); };
    img.src = url;
  });
}
function toast(message) {
  clearTimeout(toastTimer);
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function rememberLogin() {
  if (!saveLogin(s, loginStorage))
    toast("Your browser couldn’t remember your login. You can still use the demo.");
}
function go(screen) {
  error = "";
  s.screen = screen;
  render();
  root.scrollTop = 0;
  if (screen === "progress") void refreshOkrs();
}
function today() {
  return new Date(now(s)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
function dateText(v) {
  return new Date(v + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function step(title, subtitle, number, body, footer = "", back = "") {
  return `<section class="page"><div class="step-top"><button class="back" data-action="${
    back || "back"
  }">${icon("back")} Back</button><span>${
    s.onboarded ? "YOUR PREFERENCES" : `GETTING STARTED · ${number} OF 8`
  }</span></div>${
    s.onboarded
      ? ""
      : `<div class="step-track">${Array.from(
          { length: 8 },
          (_, i) => `<i class="${i < number ? "done" : ""}"></i>`
        ).join("")}</div>`
  }<h1>${title}</h1><p class="body-copy">${subtitle}</p>${body}${
    footer ? `<div class="bottom-actions">${footer}</div>` : ""
  }</section>`;
}
function navigation(active) {
  return `<nav class="nav" aria-label="Main navigation">${[
    ["home", "Today", "home"],
    ["goals", "Goals", "goal"],
    ["settings", "Settings", "settings"],
  ]
    .map(
      ([page, text, img]) =>
        `<button class="${
          active === page ? "active" : ""
        }" data-action="nav" data-to="${page}" ${
          active === page ? 'aria-current="page"' : ""
        }>${icon(img)}${text}</button>`
    )
    .join("")}</nav>`;
}
function render() {

  rollover(s);
  reconcile(s);
  const map = {
    welcome: welcome,
    tone: tone,
    conversation: conversation,
    firstGoal: firstGoal,
    calendar: calendar,
    apps: appSelection,
    breaks: breakPrefs,
    tutorial: tutorial,
    suggestions: suggestions,
    home: home,
    goals: goals,
    progress: progressReport,
    settings: settings,
    locked: locked,
    lockscreen: lockscreen,
  };
  root.innerHTML = (map[s.screen] || home)();
  persistAccount();
  if (["calendar", "home", "settings"].includes(s.screen)) maybeLoadCalendar();
  if (s.screen === "conversation")
    root.scrollTop = root.scrollHeight;
  document.querySelector("#phone-time").textContent = new Date(
    now(s)
  ).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  syncHistory();
}

// ---- Back button support ----
// Every screen change is saved as a browser history entry, so the phone's Back
// gesture/button returns to the previous screen instead of leaving the app.
const ONBOARDING_SCREENS = ["welcome", "tone", "conversation", "firstGoal", "calendar", "apps", "breaks", "tutorial", "suggestions"];
const MAIN_SCREENS = ["home", "goals", "progress", "settings", "locked", "lockscreen"];
function syncHistory() {
  if (history.state?.ft === s.screen) return; // already recorded (also true right after Back)
  // Keep the hidden Progress route in the address; every other screen uses the plain address.
  const url = location.pathname + location.search + (s.screen === "progress" ? "#progress" : "");
  // The first entry of a visit has no screen saved yet, so tag it instead of adding a second one.
  if (history.state?.ft === undefined) history.replaceState({ ft: s.screen }, "", url);
  else history.pushState({ ft: s.screen }, "", url);
}
window.addEventListener("popstate", (event) => {
  const target = event.state?.ft;
  if (!target) return;
  // Only show a screen that still makes sense. For example, after setup is finished,
  // Back should not return to the setup steps, so skip over those entries.
  const allowed = !activePhone ? ["welcome"] : s.onboarded ? MAIN_SCREENS : ONBOARDING_SCREENS;
  if (!allowed.includes(target)) { history.back(); return; }
  closeModal();
  error = "";
  s.screen = target;
  render();
  root.scrollTop = 0;
  if (target === "progress") void refreshOkrs();
});
function welcome() {
  return `<section class="page welcome"><div class="wordmark"><span class="brand-mark">✓</span>first things<span class="brand-period">.</span></div><div class="hero-art"><img src="george.png" alt="George, your friendly blue companion"><span class="hello">Hey, I’m George!</span></div><h1>First, your goals.<br><span>Then, your scroll.</span></h1><p class="body-copy">Make a little progress on what matters.<br>Unlock a little time for everything else.</p><form data-form="signup" novalidate><label class="field"><span>Your name <small>(optional for returning users)</small></span><input name="name" value="${esc(
    s.profile.name
  )}" placeholder="Your first name" autocomplete="given-name" maxlength="40"></label><label class="field"><span>Phone number</span><input type="tel" name="phone" value="${esc(
    s.profile.phone
  )}" placeholder="(555) 123-4567" autocomplete="tel"></label>${
    error ? `<div class="error" role="alert">${esc(error)}</div>` : ""
  }<button class="button">Continue with phone number</button><p class="privacy-note">Use the same number to find your account.<br>Demo login: no code or text. Anyone with your number can open this demo account.</p></form><button class="button secondary install-button" data-install>Install First Things</button><p class="install-caption">Keep your day one tap away. Works offline.</p><button class="button ghost mobile-demo" data-action="demo">Demo controls</button></section>`;
}
function tone() {
  return step(
    s.onboarded ? "George, your way." : "Meet your new<br>first-things friend.",
    s.onboarded
      ? "Your choice changes his encouragement right away."
      : "I’m George. I’ll help turn your big intentions into small, doable things.",
    1,
    `<div class="george-intro">${avatar()}<span>A little help. A little accountability.<br>Always on your side.</span></div><p class="field-label">How should I cheer you on?</p>${Object.entries(
      tones
    )
      .map(
        ([id, t]) =>
          `<button class="choice ${
            s.tone === id ? "selected" : ""
          }" data-action="tone" data-value="${id}" aria-pressed="${
            s.tone === id
          }"><span class="tone-symbol">${
            t.symbol
          }</span><span><span class="choice-title">${
            t.label
          }</span><span class="choice-copy">“${
            t.example
          }”</span></span><span class="radio"></span></button>`
      )
      .join("")}`,
    btn(s.onboarded ? "Done" : "That sounds like me", "tone-next")
  );
}
const questions = [
  {
    text: "First, what does life look like for you right now?",
    options: [
      "I’m in college",
      "I’m studying and working",
      "I’m working full-time",
    ],
  },
  {
    text: "What do you love making time for outside your responsibilities?",
    options: [
      "Friends, music, and the gym",
      "Reading and creative projects",
      "Gaming and getting outside",
    ],
  },
  {
    text: "When do you have a little time, and what tends to get in the way?",
    options: [
      "After class. I get pulled into scrolling.",
      "Mornings. Big tasks feel overwhelming.",
      "Evenings. My schedule is unpredictable.",
    ],
  },
];
function conversation() {
  const n = s.answers.length;
  return step(
    "Let’s get to know you.",
    "Three quick exchanges. No perfect answers needed.",
    2,
    `<div class="conversation-log">${s.answers
      .map(
        (a, i) =>
          `${bubble(questions[i].text)}<div class="user-bubble">${esc(a)}</div>`
      )
      .join("")}${
      n < 3
        ? bubble(
            n
              ? [
                  "",
                  "That helps — we’ll keep your plan realistic. ",
                  "I hear you. Let’s work with your day, not against it. ",
                ][n] + questions[n].text
              : questions[0].text
          )
        : bubble(
            `Thanks, ${esc(
              s.profile.name
            )}. We’ll start small, make room for what you enjoy, and find one meaningful goal.`
          )
    }</div>${
      n < 3
        ? `<div class="chips">${questions[n].options
            .map(
              (o) =>
                `<button data-action="answer" data-value="${esc(o)}">${esc(
                  o
                )}</button>`
            )
            .join(
              ""
            )}</div><form class="composer" data-form="answer"><input name="answer" aria-label="Your reply to George" placeholder="Or tell me in your own words…" maxlength="500"><button aria-label="Send reply">${icon(
            "send"
          )}</button></form>`
        : ""
    }`,
    n === 3 ? btn("Choose my first goal", "first-goal") : ""
  );
}
function firstGoal() {
  const g = s.goals[0];
  return step(
    "What matters<br>to you right now?",
    "A goal is your bigger “why.” Your daily tasks will be the small steps that get you there.",
    3,
    `<form data-form="first-goal" novalidate><label class="field"><span>My bigger goal</span><textarea name="title" placeholder="Feel ready for my final exams" maxlength="180">${esc(
      s.goalDraftTitle ?? g?.title ?? ""
    )}</textarea></label><div class="chips"><button type="button" data-action="goal-example" data-value="Feel ready for my final exams">Be ready for finals</button><button type="button" data-action="goal-example" data-value="Build a consistent fitness routine">Move more</button></div><label class="field"><span>Target date</span><input type="date" min="${localDay()}" name="target" value="${
      s.goalDraftTarget ?? g?.target ?? localDay(now(s) + 30 * 86400000)
    }"></label><p class="small muted">A direction to work toward, not a deadline for every task. You can always change it.</p>${
      error ? `<div class="error" role="alert">${esc(error)}</div>` : ""
    }<button class="button">Save my first goal</button></form>`
  );
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const duration = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};
function calendarKey(create = false) {
  return activePhone ? deviceKey(loginStorage, activePhone, create) : null;
}
// Fetch today's events when a calendar screen opens. Cached for five minutes.
function maybeLoadCalendar(force = false) {
  if (!calendarApi || !activePhone || cal.loading || !calendarKey()) return;
  const fresh = cal.phone === activePhone && cal.day === localDay() &&
    Date.now() - cal.loadedAt < (cal.phase === "ready" ? 300000 : 60000);
  if (force || !fresh) void loadCalendar();
}
async function loadCalendar() {
  const phone = activePhone, key = calendarKey();
  Object.assign(cal, { loading: true, phone, day: localDay(), loadedAt: Date.now() });
  try {
    const result = await calendarApi.today(phone, key);
    if (phone !== activePhone) return;
    if (result.connected) {
      Object.assign(cal, { phase: "ready", email: result.email, events: result.events });
      s.googleCalendar = true;
    } else {
      Object.assign(cal, { phase: "idle", email: "", events: [] });
      // This device's key no longer opens a connection, so stop asking with it.
      forgetDeviceKey(loginStorage, phone);
      if (result.revoked) cal.notice = "Google Calendar access ended, so George can’t see your schedule. Connect again any time.";
      // "elsewhere": another device still holds the connection for this account.
      if (!result.elsewhere) s.googleCalendar = false;
    }
  } catch (err) {
    if (phone !== activePhone) return;
    if (cal.phase !== "ready") Object.assign(cal, { phase: "error", message: err.message });
  } finally {
    if (phone === activePhone) {
      cal.loading = false;
      if (["calendar", "home", "settings"].includes(s.screen) && !modal.open &&
          !document.activeElement?.matches("input, textarea, select")) render();
    }
  }
}
function calendarSchedule() {
  const events = cal.events.length
    ? cal.events.map((e) => {
        const start = eventTime(e.start), end = eventTime(e.end);
        return `<div class="calendar-event"><b>${e.allDay ? "All day" : clock(start)}</b><span>${esc(e.title)}<small>${
          e.allDay ? "All-day event" : duration(end - start)
        }${e.free ? " · shows as free" : ""}</small></span></div>`;
      }).join("")
    : '<p class="small muted">Nothing on your calendar today.</p>';
  // Free time from now (or 8 AM) until 10 PM, in gaps of 15 minutes or more.
  const d = new Date();
  const from = Math.max(Math.ceil(Date.now() / 300000) * 300000,
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8).getTime());
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 22).getTime();
  const gaps = from < to ? freeTime(cal.events, from, to) : [];
  const free = gaps.length
    ? gaps.map((g) => `<div class="calendar-event"><b>${clock(g.start)}</b><span>Free until ${clock(g.end)}<small>${duration(g.end - g.start)}</small></span></div>`).join("")
    : '<p class="small muted">No free time left before 10 PM.</p>';
  return `<div class="card"><p class="section-label">TODAY</p>${events}</div><div class="card"><p class="section-label">FREE TIME LEFT TODAY</p>${free}</div>`;
}
// Today screen: the next event, or the free time before it.
function calendarLine() {
  const now = Date.now();
  const next = cal.events.find((e) => !e.allDay && !e.free && eventTime(e.end) > now);
  if (!next) return "Nothing else on your calendar today";
  if (eventTime(next.start) <= now) return `Now: ${esc(next.title)} · until ${clock(eventTime(next.end))}`;
  return `Next up: ${esc(next.title)} · ${clock(eventTime(next.start))}`;
}
function calendar() {
  const key = calendarKey();
  const ready = cal.phase === "ready";
  const checking = !ready && !!key && (cal.loading || !cal.loadedAt);
  const loadError = !ready && !!key && !checking && cal.phase === "error";
  // Only an account already confirmed connected gets the "couldn't load" screen.
  // Otherwise (e.g. a key left by an attempt that never finished) offer Connect.
  const failed = loadError && s.googleCalendar;
  const elsewhere = !ready && !key && s.googleCalendar;
  const skip = btn(s.onboarded ? "Done" : "Skip for now", "calendar-next", "ghost");
  const disconnect = s.onboarded
    ? btn(calendarBusy ? "Disconnecting…" : "Disconnect calendar", "calendar-disconnect", "ghost", calendarBusy ? "disabled" : "")
    : "";
  let body, footer;
  if (ready) {
    body = `<div class="success-note">✓ Connected as <b>${esc(cal.email)}</b></div>${calendarSchedule()}`;
    footer = `${btn("Continue", "calendar-next")}${disconnect}`;
  } else if (checking) {
    body = '<div class="card"><p class="small muted" style="margin:0">Checking today’s calendar…</p></div>';
    footer = skip;
  } else if (failed) {
    body = `<div class="error" role="alert">Couldn’t load today’s schedule. ${esc(cal.message)}</div>`;
    footer = `${btn("Try again", "calendar-refresh")}${disconnect}${skip}`;
  } else {
    body = elsewhere
      ? '<div class="info-note">Google Calendar is connected on another device. Connect on this device too to see today’s schedule here.</div>'
      : '<div class="card row"><span class="google-g">G</span><div><b>Google Calendar</b><p class="small muted" style="margin:4px 0">Sign in with Google to see today’s events and free time here. First Things can read your events but never changes them.</p></div></div>';
    footer = `${btn(
      calendarBusy ? "Opening Google…" : elsewhere ? "Connect on this device" : "Connect Google Calendar",
      "calendar-connect", "", calendarBusy ? "disabled" : ""
    )}${elsewhere ? disconnect : ""}${skip}`;
  }
  return step(
    "A little context<br>for your day.",
    "Connecting a calendar helps George see where a small task might fit. It’s completely optional.",
    4,
    `<div class="calendar-illustration">${icon("calendar")}<span>Make space,<br>not more pressure.</span></div>${body}${
      cal.notice || (loadError && !failed)
        ? `<div class="error" role="alert">${esc(cal.notice || cal.message)}</div>`
        : ""
    }`,
    footer
  );
}
function appSelection() {
  return step(
    "Less distraction.<br>More intention.",
    "Choose the apps that wait while you have unfinished tasks. An earned break opens them temporarily.",
    5,
    `${apps
      .map(
        (a) =>
          `<button class="app-choice ${
            s.selectedApps.includes(a.name) ? "selected" : ""
          }" data-action="toggle-app" data-value="${
            a.name
          }" aria-pressed="${s.selectedApps.includes(
            a.name
          )}"><span class="app-logo" style="background:${a.color}">${
            `<img src="icons/apps/${a.name.toLowerCase()}.svg" alt="" width="28" height="28">`
          }</span><span><b>${a.name}</b><small>${
            a.desc
          }</small></span><span class="check-small">${
            s.selectedApps.includes(a.name) ? "✓" : ""
          }</span></button>`
      )
      .join("")}<div class="info-note">${
      s.selectedApps.length
        ? `${s.selectedApps.length} apps selected. Changes apply immediately.`
        : "No apps selected. You can still track your tasks; no apps will be restricted."
    }</div><p class="small muted">On iPhone, set up each selected app in Settings → App shortcuts. Desktop selection syncs to your phone; it does not block laptop apps.</p>`,
    btn(s.onboarded ? "Done" : "Keep these distractions for later", "apps-next")
  );
}
function breakPrefs() {
  const st = stats(s);
  return step(
    "Progress deserves<br>a little breathing room.",
    "Choose how many 10-minute breaks you’d like to earn. Start an earned break whenever you’re ready.",
    6,
    `<div class="break-hero">${icon(
      "leaf"
    )}<div class="counter"><button data-action="break-minus" aria-label="Fewer breaks" ${
      s.requestedBreaks === 0 ? "disabled" : ""
    }>−</button><div><strong>${s.requestedBreaks}</strong><span>break${
      s.requestedBreaks === 1 ? "" : "s"
    } a day</span></div><button data-action="break-plus" aria-label="More breaks" ${
      s.requestedBreaks === 10 ? "disabled" : ""
    }>+</button></div><span class="pill">10 MINUTES EACH</span></div><div class="info-note">${
      s.requestedBreaks === 0
        ? "No breaks — finish your list to unlock your apps."
        : `For example, with 6 tasks and ${Math.min(
            s.requestedBreaks,
            6
          )} break${
            Math.min(s.requestedBreaks, 6) === 1 ? "" : "s"
          }, you earn ${
            s.requestedBreaks === 1 ? "a break" : "breaks"
          } after task${s.requestedBreaks === 1 ? "" : "s"} ${Array.from(
            { length: Math.min(s.requestedBreaks, 6) },
            (_, i) =>
              Math.ceil(((i + 1) * 6) / (Math.min(s.requestedBreaks, 6) + 1))
          )
            .filter((x) => x < 6)
            .join(", ")}. Finishing all 6 fully unlocks your apps.`
    }</div><p class="small muted">Your effective break count can’t exceed your task count. Milestones are evenly spaced and rounded up to whole tasks. Full completion always takes priority.</p>${
      s.onboarded
        ? `<div class="card small">Today: ${st.effective} planned break${
            st.effective === 1 ? "" : "s"
          } across ${
            st.total
          } tasks. Settings update future milestones immediately. Already earned breaks stay yours.</div>`
        : ""
    }`,
    btn(s.onboarded ? "Done" : "Sounds good", "breaks-next")
  );
}
function tutorial() {
  return step(
    "Let’s try a tiny win.",
    "This is just practice. It won’t count toward your daily list or earn a break.",
    7,
    `${bubble(
      s.tutorial
        ? "See? Small steps count. Now let’s choose your real first things."
        : "Take a breath. Drop your shoulders. Then tap the circle below."
    )}<button class="task-card practice ${
      s.tutorial ? "completed" : ""
    }" data-action="practice"><span class="task-check">${
      s.tutorial ? "✓" : ""
    }</span><span><b>Take one slow breath</b><small>Practice task · just for you</small></span></button>${
      s.tutorial
        ? '<div class="success-note">✓ “Take one slow breath” — your first little win!</div>'
        : ""
    }<div class="tutorial-note">${icon(
      "check"
    )}Most tasks are this simple.<br>Photo checks are always your choice.</div>`,
    btn(
      "Let’s make my real list",
      "tutorial-next",
      "",
      s.tutorial ? "" : "disabled"
    )
  );
}
function suggestions() {
  const count = s.suggestions.filter((x) => x.selected).length;
  return step(
    "Big goal.<br>Small first things.",
    "Here are a few starting points. Choose what feels right, edit anything, or make your own list.",
    8,
    `${bubble(
      `For “${esc(
        s.goals[0]?.title
      )},” a short, focused start can go a long way.`
    )}${s.suggestions
      .map(
        (t) =>
          `<div class="suggestion-card"><label class="suggestion-choice"><input type="checkbox" data-suggestion="${
            t.id
          }" ${t.selected ? "checked" : ""}><span><b>${esc(
            t.title
          )}</b><small>${t.duration} min · ${esc(
            t.why
          )}</small></span></label><button class="text-link" data-action="edit-suggestion" data-id="${
            t.id
          }">Adjust task</button></div>`
      )
      .join(
        ""
      )}<p class="small muted">Only tasks you approve will enter today’s list.</p>`,
    `${btn(
      count
        ? `Add ${count} task${count === 1 ? "" : "s"} to today`
        : "Continue with an empty list",
      "approve-onboarding"
    )}${btn("I’ll create my own tasks", "own-tasks", "ghost")}`
  );
}
function nextBreakText() {
  const st = stats(s);
  if (!st.total) return "Add a task to start making progress.";
  if (!st.remaining) return "Your list is complete. Enjoy your time.";
  if (st.active) return "Your selected apps are open. Take a breath.";
  if (st.next) {
    const left = Math.max(0, st.next.at - st.done);
    return `${left} more task${
      left === 1 ? "" : "s"
    } to your next 10-minute break.`;
  }
  return s.requestedBreaks === 0
    ? "Finish your list to unlock your apps."
    : "Finish your list for unlimited access today.";
}
function home() {
  const st = stats(s);
  const name = s.profile.name || "friend";
  const done = s.tasks.filter((t) => t.done),
    todo = s.tasks.filter((t) => !t.done).sort((x, y) => urgencyRank(x) - urgencyRank(y)),
    reminderNote = st.reminders ? ` · ${st.reminders} reminder${st.reminders === 1 ? "" : "s"}` : "",
    photos = done.some((t) => t.photo) ? todaysPhotos() : {};
  return `<section class="page daily"><header class="daily-header"><div><span class="section-label">${today()}</span><h1>Your day, ${esc(
    name
  )}<span class="blue">.</span></h1></div><button class="profile-circle" data-action="nav" data-to="settings" aria-label="Open settings">${esc(
    name[0]?.toUpperCase()
  )}</button></header><div class="progress-card"><div><span class="overline">YOUR FIRST THINGS</span><h2>${
    st.total
      ? st.remaining === 0
        ? "Look at you go."
        : `${st.remaining} little step${st.remaining === 1 ? "" : "s"} left.`
      : s.tasks.length
      ? "Just reminders today."
      : "A fresh start."
  }</h2><span class="progress-detail">${st.done} of ${
    st.total
  } tasks complete${reminderNote}</span></div><div class="progress-ring" style="--progress:${
    st.percent
  }%"><span><b>${
    st.percent
  }<small>%</small></b><em>complete</em></span></div><div class="progress-line"><i style="width:${
    st.percent
  }%"></i></div></div><button class="access-strip ${
    st.blocked ? "" : "unlocked"
  }" data-action="try-apps">${icon(st.blocked ? "lock" : "unlock")}<span><b>${
    st.active
      ? "You’re on a break"
      : st.blocked
      ? `${s.selectedApps.length} apps paused for you`
      : !s.selectedApps.length
      ? "No apps restricted"
      : "Your apps are unlocked"
  }</b><small>${
    st.active
      ? "A little time for yourself."
      : st.blocked
      ? "A little focus now. A little freedom later."
      : st.remaining
      ? "Pick your apps in Settings."
      : "Until midnight, unless you add a task."
  }</small></span><span>›</span></button><div class="break-card"><span class="break-icon">${icon(
    "leaf"
  )}</span><div><b>${
    st.active
      ? "<span data-countdown></span> left"
      : st.banked
      ? `${st.banked} break${st.banked === 1 ? "" : "s"} waiting for you`
      : "A breather is on the way"
  }</b><small>${nextBreakText()}</small></div>${
    st.banked && st.remaining && !st.active
      ? '<button data-action="start-break">Start</button>'
      : `${
          st.active ? '<button data-action="end-break">End</button>' : ""
        }<button data-action="break-detail" aria-label="Break details">${icon(
          "clock"
        )}</button>`
  }</div><div class="task-heading"><h2>Today’s list <span>${
    s.tasks.length
  }</span></h2><button class="icon-btn blue" data-action="new-task" aria-label="Add a task">${icon(
    "plus"
  )}</button></div>${
    !s.tasks.length
      ? `<div class="empty-state">${icon(
          "spark"
        )}<h3>A little space for possibility.</h3><p>Add something you want to do today.<br>A few words are all you need.</p>${btn(
          "Add my first task",
          "new-task",
          "secondary"
        )}</div>`
      : todo.length
      ? todo.map((t) => taskRow(t)).join("")
      : `<div class="completed-banner"><span>✦</span><h3>First things, done.</h3><p>You made time for what matters.<br>Your apps are fully unlocked.</p><button class="text-link" data-action="celebrate">Enjoy this little moment</button></div>`
  }${
    done.length
      ? `<div class="done-label">COMPLETED · ${done.length}</div>${done
          .map((t) => taskRow(t, photos))
          .join("")}`
      : ""
  }<button class="add-task" data-action="new-task">${icon(
    "plus"
  )} Add a little first thing</button>${
    s.googleCalendar && cal.phase === "ready"
      ? '<div class="calendar-mini">' + icon("calendar") + " " + calendarLine() + "</div>"
      : ""
  }<p class="day-note">A new day starts at midnight. <button data-action="day-rules">How it works</button></p></section>${navigation(
    "home"
  )}`;
}
function taskRow(t, photos = {}) {
  const goal = s.goals.find((g) => g.id === t.goalId);
  const kept = t.done && t.photo ? photos[t.id] : "";
  return `<div class="task-card ${
    t.done ? "completed" : ""
  } ${t.urgency === "high" ? "urgency-high" : ""}"><button class="task-check" data-action="toggle-task" data-id="${
    t.id
  }" aria-label="${t.done ? "Mark incomplete:" : "Complete:"} ${esc(
    t.title
  )}" role="checkbox" aria-checked="${t.done}">${
    t.done ? "✓" : ""
  }</button><button class="task-title" data-action="edit-task" data-id="${
    t.id
  }"><b>${esc(t.title)}</b><small>${
    [
      t.duration ? `${t.duration} min` : null,
      t.recurrence !== "none" ? t.recurrence : null,
      t.urgency === "high" ? "High priority" : t.urgency === "low" ? "Low priority" : null,
      t.reminder ? "Reminder only" : null,
      t.photo ? "Photo check" : null,
      goal?.title,
    ]
      .filter(Boolean)
      .map(esc)
      .join(" · ") || "Your own little first thing"
  }</small></button>${
    t.photo && !t.done
      ? `<span class="photo-indicator">${icon("camera")}</span>`
      : kept && /^data:image\/jpeg;base64,/.test(kept)
      ? `<img class="photo-thumb" src="${kept}" alt="Your photo for ${esc(t.title)}">`
      : ""
  }<button class="task-menu" data-action="edit-task" data-id="${
    t.id
  }" aria-label="Edit ${esc(t.title)}">${icon("more")}</button></div>`;
}
const DAY_MS = 86400000;
const dayNumber = (day) => Math.round(new Date(day + "T12:00:00").getTime() / DAY_MS);
function goalMeta(g, associated) {
  const todayKey = localDay(now(s));
  const left = dayNumber(g.target) - dayNumber(todayKey);
  const tone = left < 0 ? "over" : left <= 7 ? "soon" : "ok";
  const label =
    left < 0 ? `Overdue by ${-left} day${left === -1 ? "" : "s"}`
    : left === 0 ? "Due today"
    : left === 1 ? "1 day left"
    : `${left} days left`;
  const done = associated.filter((t) => t.done).length;
  const todayPct = associated.length ? Math.round((done / associated.length) * 100) : 0;
  let timeBar = "";
  if (g.created) {
    const span = Math.max(1, dayNumber(g.target) - dayNumber(g.created));
    const pct = Math.max(0, Math.min(100, Math.round(((dayNumber(todayKey) - dayNumber(g.created)) / span) * 100)));
    timeBar = `<div class="goal-bar"><div class="goal-bar-head"><span>Time passed</span><b>${pct}%</b></div><div class="goal-track"><i class="time ${tone}" style="width:${pct}%"></i></div></div>`;
  }
  const finished = g.stepsDone || 0;
  return `<div class="goal-due"><span class="due-pill ${tone}">${icon("calendar")} ${label}</span><span class="small muted">Target ${dateText(g.target)}</span></div>${timeBar}<div class="goal-bar"><div class="goal-bar-head"><span>Today’s steps</span><b>${done} of ${associated.length}</b></div><div class="goal-track"><i style="width:${todayPct}%"></i></div></div><p class="goal-total">${finished ? `<b>${finished}</b> step${finished === 1 ? "" : "s"} finished toward this goal` : "Finish a step to start your count"}</p>`;
}
function goals() {
  const totalSteps = s.goals.reduce((n, g) => n + (g.stepsDone || 0), 0);
  return `<section class="page"><div class="page-top"><span class="section-label">THE BIGGER PICTURE</span><button class="icon-btn blue" data-action="new-goal" aria-label="Add goal">${icon(
    "plus"
  )}</button></div><h1>Things worth<br>working toward<span class="blue">.</span></h1><p class="body-copy">${totalSteps ? `${totalSteps} step${totalSteps === 1 ? "" : "s"} finished across your goals.` : "Your daily steps have somewhere to go."}</p>${
    s.goals.length
      ? s.goals
          .map((g, i) => {
            const associated = s.tasks.filter((t) => t.goalId === g.id);
            return `<div class="goal-card"><div class="row spread"><span class="goal-symbol">${icon(
              "goal"
            )}</span><button class="icon-btn" data-action="edit-goal" data-id="${
              g.id
            }" aria-label="Edit goal ${esc(g.title)}">${icon(
              "edit"
            )}</button></div><h2>${esc(
              g.title
            )}</h2>${goalMeta(g, associated)}${
              associated.length
                ? `<details><summary>See today’s steps</summary>${associated
                    .map(
                      (t) =>
                        `<button class="goal-task" data-action="edit-task" data-id="${
                          t.id
                        }">${t.done ? "✓" : "○"} ${esc(t.title)}</button>`
                    )
                    .join("")}</details>`
                : ""
            }</div>`;
          })
          .join("")
      : `<div class="empty-state"><h3>What matters to you next?</h3><p>Your daily tasks are still here. Add a new bigger goal whenever you’re ready.</p></div>`
  }<button class="add-task" data-action="new-goal">${icon(
    "plus"
  )} Add another goal</button></section>${navigation("goals")}`;
}
function settings() {
  return `<section class="page"><span class="section-label">MAKE IT YOURS</span><h1>A little more you<span class="blue">.</span></h1><div class="profile-card"><span class="profile-circle">
  ${s.profile.avatar
    ? `<img src="${esc(s.profile.avatar)}" alt="Profile picture" class="profile-avatar">`
    : esc(s.profile.name[0]?.toUpperCase() || "?")
  }
</span><div><b>${esc(s.profile.name)}</b><small>${esc(
    s.profile.phone
  )}</small></div><button class="text-link profile-edit" data-action="profile" aria-label="Edit profile">Edit ${icon(
    "edit"
  )}</button>
  <label for="avatar-upload" class="text-link profile-upload">
  <input type="file" id="avatar-upload" accept="image/png,image/jpeg,image/webp" style="display:none;">
  <span>Change Photo</span>
</label>
  </div><p class="section-label">YOUR DAILY RHYTHM</p>${[
    [
      "apps",
      "lock",
      "Restricted apps",
      s.selectedApps.length + " selected · changes apply immediately",
    ],
    [
      "breaks",
      "leaf",
      "Earned breaks",
      s.requestedBreaks + " preferred · 10 minutes each",
    ],
    ["tone", "chat", "George’s encouragement", tones[s.tone].label],
    [
      "calendar",
      "calendar",
      "Calendar connection",
      s.googleCalendar
        ? cal.phase === "ready" ? `Connected · ${esc(cal.email)}` : "Connected · Google Calendar"
        : "Optional · not connected",
    ],
  ]
    .map(
      ([page, i, title, sub]) =>
        `<button class="setting-row" data-action="settings-page" data-to="${page}">${icon(
          i
        )}<span><b>${title}</b><small>${sub}</small></span><span>›</span></button>`
    )
    .join(
      ""
    )}<button class="setting-row" data-action="instagram-setup">${icon("phone")}<span><b>App shortcuts</b><small>Set up your iPhone reminder</small></span><span>›</span></button>
    <button class="setting-row" data-action="reminders-setup">${icon("clock")}<span><b>Daily reminder</b><small>${reminderSummary()}</small></span><span>›</span></button>
<button class="setting-row" data-action="share-app">
  ${icon("send")}
  <span>
    <b>Share with Friends</b>
    <small>Invite someone to try First Things</small>
  </span>
  <span>›</span>
</button>
<button class="setting-row" data-action="copy-app-link">
  ${icon("check")}
  <span>
    <b>Copy Link</b>
    <small>Copy the app link to send anywhere</small>
  </span>
  <span>›</span>
</button>
<p class="section-label" style="margin-top:27px">EXPLORE THE PROTOTYPE</p><button class="setting-row" data-action="try-apps">${icon(
    "phone"
  )}<span><b>Try a distracting app</b><small>See why it’s paused or unlocked</small></span><span>›</span></button><button class="setting-row" data-action="lockscreen">${icon(
    "lock"
  )}<span><b>Lock-screen preview</b><small>A little reminder from George</small></span><span>›</span></button><button class="setting-row" data-action="demo">${icon(
    "spark"
  )}<span><b>Demo controls</b><small>Explore resets and recovery states</small></span><span>›</span></button><button class="setting-row" data-action="day-rules">${icon(
    "clock"
  )}<span><b>What happens at midnight?</b><small>Daily reset and prototype assumptions</small></span><span>›</span></button><button class="setting-row" data-install>${icon("phone")}<span><b>Install First Things</b><small>Add to your Home Screen</small></span><span>›</span></button><button class="setting-row" data-action="sign-out">${icon("back")}<span><b>Sign out / switch account</b><small>Your saved tasks stay on this device</small></span><span>›</span></button><p class="privacy-note">Tasks are saved on this device and sync when you’re online with the app open. Demo phone accounts do not use verification.<br>Photo checks use AI (Claude) and photos are never saved online. Google Calendar is optional and read-only. The optional Instagram shortcut redirects you; it does not enforce an iOS app lock.</p></section>${navigation(
    "settings"
  )}`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Older browsers need selection. */ }
  const field = document.createElement("textarea");
  field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.append(field); field.focus(); field.select(); field.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy"); field.remove();
  if (!copied) throw Error("Select the setup value and copy it manually.");
}
let instagramConfig;
async function instagramSetup(appName = "Instagram") {
  if (!apps.some(app => app.name === appName)) return;
  instagramConfig = null;
  openModal("A pause before Instagram.", '<p>Connecting your synced account…</p>');
  const version = modalVersion, phone = activePhone;
  try {
    if (!USE_SUPABASE || !navigator.onLine || legacyPhone || storageFailed) throw Error("Connect to the internet and wait for All changes synced first.");
    persistAccount();
    await accounts.sync(phone);
    const record = accounts.read(phone);
    if (!record?.linked || record.retired || record.pendingMove || JSON.stringify(record.local) !== JSON.stringify(record.base))
      throw Error("Wait for All changes synced, then try again.");
    const { access_key } = await createCloud().shortcut(phone);
    const config = shortcutConfig(access_key, Intl.DateTimeFormat().resolvedOptions().timeZone, location.href, appName);
    if (version !== modalVersion || phone !== activePhone) return;
    instagramConfig = config;
    const field = (label, key) => `<label class="field"><span>${label}</span><textarea readonly rows="2" data-shortcut-value="${key}">${esc(config[key])}</textarea></label><button class="text-link" data-action="shortcut-copy" data-value="${key}">Copy ${label.toLowerCase()}</button>`;
    openModal("A pause before ${esc(appName)}.", `<div class="chips">${apps.map(app => `<button data-action="instagram-setup" data-value="${app.name}">${app.name}</button>`).join("")}</div><p>When ${esc(appName)} opens, your shortcut checks your synced list. It leaves ${esc(appName)} open during a break or after your tasks are done. Otherwise, it opens a reminder.</p>
      <p class="small muted"> Set up once on your iPhone · Can be disabled in Shortcuts</p>
      <button class="button" data-action="shortcut-check">Test my ${esc(appName)} check</button><p id="shortcut-result" role="status"></p>
      <details class="shortcut-guide"><summary>1. Create “Check First Things”</summary><ol>
      <li>Open Apple <b>Shortcuts</b> and create a shortcut named <b>Check First Things</b>.</li>
      <li>Add <b>URL</b> and paste the Check URL below.</li>
      <li>Add <b>Get Contents of URL</b>. Use <b>GET</b>. Expand its options, add a header named <b>apikey</b>, and paste the API key below as its value.</li>
      <li>Add <b>Get Dictionary Value</b>. Get the value for <b>decision</b> from Contents of URL.</li>
      <li>Add <b>If</b>: Dictionary Value <b>is</b> <b>allow</b>. Inside this branch add <b>Nothing</b>.</li>
      <li>Inside <b>Otherwise</b>, first add <b>Go to Home Screen</b> to leave the app, then add <b>URL</b> with the Reminder URL below, then <b>Open URLs</b> using that URL. Keep these actions before <b>End If</b>.</li>
      <li>Run it once and allow its connection to our Supabase project and opening the reminder when prompted. Don’t add an Open ${esc(appName)} action; ${esc(appName)} is already open when the automation runs.</li></ol></details>
      <details class="shortcut-guide"><summary>2. Run it when ${esc(appName)} opens</summary><ol>
      <li>In Shortcuts, add an automation with the <b>App</b> trigger. Depending on your Shortcuts layout, use Automation → + or add an automation trigger to a shortcut.</li>
      <li>Select <b>${esc(appName)}</b> and <b>Is Opened</b>, then choose <b>Run Immediately</b>.</li>
      <li>Choose <b>Check First Things</b> (or add <b>Run Shortcut</b> and select it). Save the automation.</li>
      <li>In First Things → Restricted apps, select ${esc(appName)}. Add an unfinished task and wait for <b>All changes synced</b>. Open ${esc(appName)} to test the redirect.</li></ol></details>
      <details class="shortcut-guide"><summary>3. Copy your setup values</summary>${field("Check URL", "url")}${field("API key", "apiKey")}${field("Reminder URL", "reminder")}<p class="small muted">Time zone: ${esc(config.zone)}. If you travel to a different time zone, reopen this setup and replace the Check URL. Your link follows phone-number changes. Keep it private: it can read your ${esc(appName)} access status.</p></details>
      <p class="small muted">Open First Things each morning and after edits; wait for All changes synced. Offline requests may stop with a Shortcuts error and leave ${esc(appName)} open. A break ending won’t close an app that’s already open. The reminder may open in Safari; your Home Screen app keeps its own session.</p><p class="small muted">Repeated opening can outrun iOS automations. Run Immediately and Go to Home Screen reduce the window, but Shortcuts cannot guarantee an app lock.</p>`);
  } catch (problem) {
    if (version === modalVersion && phone === activePhone) openModal("Let’s reconnect.", `<p>${esc(problem.message)}</p><button class="button" data-action="instagram-setup">Try again</button>`);
  }
}

// ---- Task reminders (push notifications) ----
function remindersModal(message = "") {
  const support = reminderSupport();
  const prefs = reminderPrefs(activePhone);
  let body;
  if (!USE_SUPABASE) body = "<p>Reminders need the cloud connection. Turn it on in the app’s config first.</p>";
  else if (!support.ok && support.reason === "setup")
    body = "<p>Reminders aren’t set up for this app yet. Add the reminder key in <b>supabase-config.js</b> (see the README), then try again.</p>";
  else if (!support.ok && support.reason === "install")
    body = `<p>On iPhone, reminders work from the Home Screen app. Add First Things to your Home Screen, open it from there, and come back to this screen.</p>${btn("Show me how", "install-help", "secondary", "data-install")}`;
  else if (!support.ok) body = "<p>This browser can’t show reminders. Try the installed app on your phone.</p>";
  else
    body = `<p>A nudge on your phone when you still have first things to finish. One reminder a day, at the time you pick, and only if you have tasks left.</p>
      <label class="field"><span>Remind me at</span><input type="time" id="reminder-time" value="${esc(prefs.time)}" required></label>
      ${prefs.on ? btn("Save time", "reminders-enable") + btn("Turn off reminders", "reminders-disable", "secondary") : btn("Turn on reminders", "reminders-enable")}
      <p class="small muted">${prefs.on ? "Reminders are on for this phone." : "You’ll be asked to allow notifications."} Keep First Things open until All changes synced shows, so the reminder counts your latest tasks.</p>`;
  openModal("A little reminder.", `${body}<p id="reminder-result" class="small" role="status">${esc(message)}</p>`);
}
async function remindersEnable() {
  const time = document.querySelector("#reminder-time")?.value;
  const result = document.querySelector("#reminder-result");
  const phone = activePhone;
  const say = (text) => { if (result) result.textContent = text; };
  try {
    say("Turning on reminders…");
    await enableReminders({
      cloud: createCloud(), phone, time,
      beforeSave: async () => {
        if (!navigator.onLine || legacyPhone || storageFailed) throw Error("Connect to the internet and wait for All changes synced first.");
        persistAccount();
        await accounts.sync(phone);
        const record = accounts.read(phone);
        if (!record?.linked || record.retired || record.pendingMove) throw Error("Wait for All changes synced, then try again.");
      },
    });
    if (phone === activePhone) { render(); remindersModal(`Done. We’ll remind you at ${formatTime(time)} if you still have tasks left.`); }
  } catch (problem) {
    say(problem.message);
  }
}
async function remindersDisable() {
  try {
    await disableReminders({ cloud: createCloud(), phone: activePhone });
    render();
    remindersModal("Reminders are off.");
  } catch (problem) {
    const result = document.querySelector("#reminder-result");
    if (result) result.textContent = problem.message;
  }
}
const reminderSummary = () => {
  const prefs = reminderPrefs(activePhone);
  return prefs.on ? `On · ${formatTime(prefs.time)} each day` : "Get a nudge on your phone";
};

// ---- Progress report ----
async function refreshOkrs() {
  if (!cloud) return;
  const mine = ++okr.requestId; // lets us ignore an older answer that arrives late
  try {
    const data = await cloud.okrs();
    if (mine !== okr.requestId) return;
    okr.data = data;
    okr.phase = "ready";
    okr.message = "";
  } catch (e) {
    if (mine !== okr.requestId) return;
    okr.phase = "error";
    okr.message = navigator.onLine ? e.message || String(e) : "You’re offline.";
  }
  paintOkrs();
}
// Only the report body is swapped, so the page doesn't jump or lose its scroll position.
let lastOkrCards = "";
function paintOkrs() {
  const el = document.querySelector("#okr-report");
  if (!el) return;
  const { cards, note } = okrParts();
  if (cards === lastOkrCards) {
    // Same numbers: only refresh the "Updated" time, so nothing flashes every 10 seconds.
    const label = el.querySelector(".okr-updated");
    if (label && note) label.textContent = note;
    return;
  }
  lastOkrCards = cards;
  el.innerHTML = okrBody();
}
// While the Progress screen is open, re-read the numbers every 10 seconds. That
// way activity from other people's phones moves the numbers on this screen
// without anyone touching it, which is what makes them visibly live in a demo.
setInterval(() => {
  if (s.screen === "progress" && !document.hidden) void refreshOkrs();
}, 10000);
function krCard(kr, noun) {
  const value = Number(kr.value) || 0;
  const target = Number(kr.target) || 1;
  const pct = Math.min(100, Math.round((value / target) * 100)); // bar stops at 100%
  const met = value >= target;
  const isPercent = kr.unit === "%";
  const shown = isPercent ? value + "%" : String(value);
  const goal = isPercent ? target + "%" : target + " " + kr.unit;
  // numerator/denominator are the raw counts behind the number, so anyone can see it is real data
  const detail =
    kr.denominator === undefined
      ? "Average across every day someone used the app"
      : kr.numerator + " of " + kr.denominator + " " + noun;
  return `<article class="kr-card"><div class="kr-top"><h3>${esc(kr.title)}</h3><span class="pill${
    met ? " met" : ""
  }">${met ? "Target met" : "In progress"}</span></div><p class="kr-value">${esc(shown)}<small>Target ${esc(
    goal
  )}</small></p><div class="kr-bar" role="progressbar" aria-label="${esc(
    kr.title
  )}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div><p class="kr-detail">${esc(
    detail
  )}</p></article>`;
}
// The report has two parts: the Key Result cards and a small "Updated" note whose
// time changes on every refresh. They are split so the cards are only redrawn when
// their numbers change, while the note keeps ticking.
function okrParts() {
  if (!cloud)
    return { cards: '<p class="info-note">Key Results are calculated by the database. Turn on Supabase to see them.</p>', note: "" };
  if (!okr.data) {
    return {
      cards:
        okr.phase === "error"
          ? `<p class="error" role="alert">Couldn’t load Key Results: ${esc(okr.message)}</p>`
          : '<p class="info-note">Loading Key Results…</p>',
      note: "",
    };
  }
  const d = okr.data;
  const when = new Date(d.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const note =
    okr.phase === "error"
      ? "Couldn’t refresh just now · showing " + when
      : "Updated " + when + " · refreshes every 10 seconds";
  const cards = `<p class="overline-dark">OBJECTIVE 1</p><h2 class="obj-title">${esc(d.objective1.title)}</h2>${krCard(
    d.objective1.kr1,
    "tasks completed"
  )}${krCard(d.objective1.kr2, "daily lists finished")}<p class="overline-dark">OBJECTIVE 2</p><h2 class="obj-title">${esc(
    d.objective2.title
  )}</h2>${krCard(d.objective2.kr3, "")}${krCard(
    d.objective2.kr4,
    "people active 3+ days this week"
  )}`;
  return { cards, note };
}
function okrBody() {
  const { cards, note } = okrParts();
  return cards + (note ? `<p class="okr-updated">${esc(note)}</p>` : "");
}
function progressReport() {
  return `<section class="page progress-page"><header><span class="section-label">PROGRESS REPORT</span><h1>What First Things is doing</h1><p class="body-copy">Live numbers from everyone using the app. They move as people check off their first things.</p></header><div id="okr-report">${((lastOkrCards = okrParts().cards), okrBody())}</div><button class="button secondary" data-action="okr-refresh">Refresh now</button></section>${navigation(
    "progress"
  )}`;
}
function locked() {
  const st = stats(s),
    a = apps.find((a) => a.name === s.attemptedApp) || apps[0],
    isBlocked = st.remaining && !st.active && s.selectedApps.includes(a.name);
  return `<section class="page blocked-page"><button class="back" data-action="nav" data-to="home">${icon(
    "back"
  )} Today</button><span class="pill">SIMULATED APP EXPERIENCE</span><span class="big-app-logo" style="background:${
    a.color
  }">${a.short}</span><h1>${
    isBlocked ? "First things first." : `Hello, ${a.name}.`
  }</h1><p class="body-copy">${
    isBlocked
      ? `${a.name} is paused while you have ${st.remaining} unfinished task${
          st.remaining === 1 ? "" : "s"
        }.`
      : `${a.name} is available ${
          st.active
            ? "during your break"
            : !s.selectedApps.includes(a.name)
            ? "because you haven’t restricted it"
            : "because your daily list is complete or empty"
        }.`
  }</p>${bubble(
    isBlocked
      ? s.tone === "direct"
        ? "You chose to make this time count. Pick one task and get started."
        : s.tone === "gentle"
        ? "Your feed will be here later. Let’s give one small thing a little care first."
        : "A small step now, a little scroll later. You’ve got this."
      : "Enjoy a little time for yourself. You’re in control."
  )}<div class="bottom-actions">${
    isBlocked
      ? `${btn("Back to my first things", "nav", "", 'data-to="home"')}${
          st.banked
            ? btn("Start an earned 10-minute break", "start-break", "secondary")
            : ""
        }${st.remaining ? btn("Tackle my next task", "tackle", "ghost") : ""}`
      : `<div class="sim-feed"><div></div><b>${
          st.active
            ? "<span data-countdown></span> remaining"
            : "You’re free to explore"
        }</b><p>That’s the idea. In a real app, you’d be back in ${
          a.name
        }.</p></div>${
          st.active ? btn("End break early", "end-break", "secondary") : ""
        }${btn("Back to my day", "nav", "", 'data-to="home"')}`
  }</div><p class="privacy-note">No real app was opened or blocked.</p></section>`;
}
function lockscreen() {
  const st = stats(s);
  return `<section class="page lockscreen"><button class="back" data-action="nav" data-to="settings">${icon(
    "back"
  )} Back to Settings</button><span class="lock-clock">${new Date(
    now(s)
  ).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}</span><p>${today()}</p><div class="lock-widget"><div class="row">${avatar()}<b>first things.</b><span class="pill">PREVIEW</span></div><h2>${
    st.remaining
      ? `${st.remaining} small step${st.remaining === 1 ? "" : "s"} left.`
      : "Your first things are done."
  }</h2><p>${nextBreakText()}</p><button class="button" data-action="nav" data-to="home">${
    st.remaining ? "Take my next step" : "See my day"
  }</button></div><p class="privacy-note">A concept preview, inside this demo.<br>No access to your real lock screen.</p></section>`;
}
function openModal(title, body) {
  modalVersion++;
  modal.innerHTML = `<div class="modal-top"><h2>${title}</h2><button class="icon-btn" data-action="close-modal" aria-label="Close dialog">${icon(
    "close"
  )}</button></div>${body}`;
  if (!modal.open) modal.showModal();
}
function closeModal() {
  modalVersion++;
  modal.close();
  photo = null;
  photoError = "";
  taskDraft = null;
  goalDraft = null;
}
function taskEditor(id = "", kind = "task") {
  const source =
    kind === "suggestion"
      ? s.suggestions
      : s.tasks;
  const t = source?.find((x) => x.id === id) || {
    title: "",
    duration: "",
    recurrence: "none",
    photo: false,
    goalId: "",
    urgency: "normal",
    reminder: false,
  };
  taskDraft = { id, kind };
  openModal(
    id ? "A little adjustment." : "A little first thing.",
    `<form data-form="task" novalidate><label class="field"><span>What do you want to do?</span><input name="title" value="${esc(
      t.title
    )}" placeholder="Read, tidy up, call home…" maxlength="180" autofocus></label><p class="small muted">A title is enough. Make it yours.</p><div class="two-fields"><label class="field"><span>Minutes <em>optional</em></span><input name="duration" type="number" min="1" max="1440" placeholder="e.g. 15" value="${esc(
      t.duration
    )}"></label><label class="field"><span>Repeat</span><select name="recurrence">${[
      ["none", "Doesn’t repeat"],
      ["daily", "Daily"],
      ["weekly", "Weekly"],
      ["monthly", "Monthly"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${
            t.recurrence === v ? "selected" : ""
          }>${l}</option>`
      )
      .join(
        ""
      )}</select></label></div><label class="field"><span>Bigger goal <em>optional</em></span><select name="goalId"><option value="">Just for me</option>${s.goals
      .map(
        (g) =>
          `<option value="${g.id}" ${t.goalId === g.id ? "selected" : ""}>${esc(
            g.title
          )}</option>`
      )
      .join(
        ""
      )}</select></label><label class="field"><span>Priority</span><select name="urgency">${[
      ["high", "High"],
      ["normal", "Normal"],
      ["low", "Low"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${
            (t.urgency || "normal") === v ? "selected" : ""
          }>${l}</option>`
      )
      .join("")}</select></label><label class="toggle-label"><span><b>Verify with a photo</b><small>Optional. Otherwise, just check it off.</small></span><input type="checkbox" name="photo" ${
      t.photo ? "checked" : ""
    }></label><label class="toggle-label"><span><b>Reminder only</b><small>Won’t pause apps or count toward earning breaks.</small></span><input type="checkbox" name="reminder" ${
      t.reminder ? "checked" : ""
    }></label><p class="small muted">This task goes on today’s list. Weekly repeats follow today’s weekday; monthly repeats follow the calendar day, or the last day in a shorter month.</p><div class="form-error" role="alert"></div><button class="button">${
      id ? "Save changes" : "Add to today"
    }</button>${
      id && kind === "task"
        ? `<button class="button danger" type="button" data-action="delete-task" data-id="${id}">Delete task${
            t.recurrence !== "none" ? " and future repeats" : ""
          }</button>`
        : ""
    }</form>`
  );
}
function goalEditor(id = "") {
  const g = s.goals.find((g) => g.id === id) || {
    title: "",
    target: localDay(now(s) + 30 * 86400000),
  };
  goalDraft = { id };
  openModal(
    id ? "Keep your goal in view." : "What’s your bigger why?",
    `<form data-form="goal" novalidate><label class="field"><span>Your goal</span><textarea name="title" maxlength="180">${esc(
      g.title
    )}</textarea></label><label class="field"><span>Target date</span><input type="date" min="${localDay()}" name="target" value="${
      g.target
    }"></label><div class="form-error" role="alert"></div><button class="button">Save goal</button>${
      id
        ? `<button type="button" class="button danger" data-action="delete-goal" data-id="${id}">Remove goal</button><p class="small muted">Your daily tasks will stay in your list.</p>`
        : ""
    }</form>`
  );
}
function completion(t, earned = [], support = false, note = "") {
  render();
  const prefix =
    s.tone === "gentle"
      ? "That’s a lovely little step."
      : s.tone === "direct"
      ? "Done. Nice follow-through."
      : "A little win looks good on you!";
  toast(
    `${note || prefix} “${t.title}” is complete.${
      earned.length ? " You earned a 10-minute break!" : ""
    }`
  );
  if (!stats(s).remaining) {
    if (support)
      celebrate(
        "The photo checks weren’t cooperating. I trust your effort — your task is complete."
      );
    else celebrate();
  } else if (support)
    openModal(
      "I trust your effort.",
      `${bubble(
        "Three photo checks didn’t work out. That’s on the check, not on you. I’ve marked “" +
          esc(t.title) +
          "” complete so you can keep moving."
      )}<p>${esc(nextBreakText())}</p>${btn("Keep going", "close-modal")}`
    );
}
function celebrate(extra = "") {
  const st = stats(s);
  openModal(
    "First things, done.",
    `<div class="celebration-art"><img src="george.png" alt="George celebrating"></div><p class="celebration-text">${
      s.tone === "direct"
        ? "You followed through. Enjoy the time you earned."
        : s.tone === "gentle"
        ? "Look at all those little steps. You deserve to feel good about this."
        : "You showed up for yourself. That’s a pretty big little win."
    }</p>${
      extra ? `<div class="info-note">${esc(extra)}</div>` : ""
    }<div class="success-note">${st.done} of ${
      st.total
    } tasks complete · Apps unlocked</div><p>Your selected apps stay unlocked until midnight, unless you add another unfinished task.</p>${btn(
      "Enjoy my day",
      "close-modal"
    )}${btn("Review my accomplishments", "review-done", "ghost")}`
  );
}
function photoDialog(id) {
  photoTask = id;
  const t = s.tasks.find((t) => t.id === id);
  openModal(
    "Show your little win.",
    `<p class="small muted">${esc(t.title)}</p><div class="photo-preview">${
      photo
        ? `<img src="${photo.preview}" alt="Your photo for this task">`
        : photoPreparing
        ? `${icon("camera")}<span>Getting your photo ready…</span>`
        : `${icon("camera")}<span>Take a photo that shows this task done</span>`
    }</div>${
      photoError
        ? `<div class="error" role="alert">${esc(photoError)}</div>`
        : ""
    }<div class="row"><label class="button secondary upload-label">${
      photo ? "Retake photo" : "Take photo"
    }<input type="file" accept="image/*" capture="environment" id="photo-upload" ${
      photoBusy || photoPreparing ? "disabled" : ""
    }></label></div>${btn(
      photoBusy ? "Checking your photo…" : "Submit photo",
      "submit-photo",
      "",
      photoBusy || photoPreparing || !photo ? "disabled" : ""
    )}<p class="privacy-note">${
      t.failures
        ? `${t.failures} unsuccessful check${
            t.failures === 1 ? "" : "s"
          } so far. After three, George trusts your effort.`
        : "AI checks your photo once. It isn’t saved online; a small copy stays on this phone until midnight."
    }</p>`
  );
}
function demo() {
  openModal(
    "Explore the demo.",
    `<p>Use a sample phone number to try the new-user journey. App blocking and integrations are demonstrations.</p><div class="stack">${btn(
      "Open a ready-made day",
      "sample-day",
      "secondary"
    )}${
      s.onboarded
        ? `${btn("Try a distracting app", "try-apps", "secondary")}${btn(
            "Finish the active break",
            "finish-break",
            "secondary",
            stats(s).active ? "" : "disabled"
          )}${btn(
            "Simulate next local midnight",
            "midnight",
            "secondary"
          )}`
        : ""
    }${btn(
      "Restart the new-user journey",
      "reset",
      "danger"
    )}</div><p class="small muted">Changes to tasks and daily progress also sync to this demo phone account.</p>`
  );
}
function rules() {
  openModal(
    "A new day, a fresh start.",
    `<p>Today’s list resets at <b>midnight in your local time zone</b>.</p><ul class="rule-list"><li>Unfinished one-time tasks carry into tomorrow.</li><li>Completed one-time tasks leave the daily list.</li><li>Recurring tasks return incomplete on their scheduled day. Missed repeats don’t pile up.</li><li>Unused earned breaks expire and active breaks end at midnight.</li><li>Apps stay unlocked if the new list is empty; unfinished tasks pause your selected apps again.</li></ul><p class="small muted">These are the prototype’s assumptions for daily carryover and unused breaks. Weekly repeats use the creation weekday. Monthly repeats use the creation date, clamped to the last day of shorter months.</p>${btn(
      "Got it",
      "close-modal"
    )}`
  );
}
function tryApps() {
  openModal(
    "Try a little scroll.",
    `<p class="small muted">Tap an app to see its current access. This is a simulation.</p>${apps
      .map(
        (a) =>
          `<button class="app-choice" data-action="open-app" data-value="${
            a.name
          }"><span class="app-logo" style="background:${a.color}">${
            `<img src="icons/apps/${a.name.toLowerCase()}.svg" alt="" width="28" height="28">`
          }</span><span><b>${a.name}</b><small>${
            stats(s).remaining &&
            !stats(s).active &&
            s.selectedApps.includes(a.name)
              ? "Paused — first things are waiting"
              : "Available"
          }</small></span>${icon(
            stats(s).remaining &&
              !stats(s).active &&
              s.selectedApps.includes(a.name)
              ? "lock"
              : "unlock"
          )}</button>`
      )
      .join("")}`
  );
}
function breakDetail() {
  const st = stats(s);
  openModal(
    st.active ? "Enjoy your breather." : "A break, on your terms.",
    `<div class="break-display">${icon("leaf")}<strong>${
      st.active ? "<span data-countdown></span>" : st.banked
    }</strong><span>${
      st.active ? "remaining" : "earned breaks ready"
    }</span></div><p>${esc(nextBreakText())}</p>${
      st.milestones.length
        ? `<p class="small muted">Today’s milestones: ${st.milestones
            .map((m) =>
              m.at === st.total
                ? "full completion"
                : `after ${m.at} task${m.at === 1 ? "" : "s"}`
            )
            .join(
              ", "
            )}. Earned breaks stay yours when your list changes. Each milestone can be earned once per day.</p>`
        : ""
    }<p class="small muted">${
      st.active
        ? "Your selected apps are temporarily available. Restrictions return when time ends if unfinished tasks remain."
        : "Start a 10-minute break now, or save it for later today."
    }</p>${
      st.banked && st.remaining && !st.active
        ? btn("Start a 10-minute break", "start-break")
        : st.active
        ? btn("End break early", "end-break", "secondary") +
          btn("Back to my day", "close-modal", "ghost")
        : btn("Back to my day", "close-modal")
    }`
  );
}
function completeOnboarding(approve) {
  if (approve)
    for (const t of s.suggestions.filter((t) => t.selected)) addTask(s, t);
  s.suggestions = [];
  s.onboarded = true;
  rememberLogin();
  go("home");
  toast("Your day, your way. Let’s start small.");
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (root.inert) return;
  const a = el.dataset.action,
    id = el.dataset.id,
    v = el.dataset.value;
  error = "";
  if (rollover(s)) {
    render();
  }
  switch (a) {
    case "copy-app-link": {
  const shareUrl = "https://aarongarry.github.io/first-things-PWA/";

  try {
    await navigator.clipboard.writeText(shareUrl);
    toast("Link copied! Send it to a friend.");
  } catch {
    toast("Couldn't copy the link.");
  }
  break;
}
    case "share-app": {
  const shareUrl = "https://aarongarry.github.io/first-things-PWA/";

  if (navigator.share) {
    try {
      await navigator.share({
        title: "First Things",
        text: "Check out First Things! It's an app that helps you focus on your goals.",
        url: shareUrl
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        toast("Couldn't open sharing options.");
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast("App link copied! Send it to a friend.");
    } catch {
      toast("Couldn't copy the link.");
    }
  }
  break;
}
    case "okr-refresh":
      void refreshOkrs();
      break;
    case "nav":
      closeModal();
      go(el.dataset.to);
      break;
    case "back": {
      if (!s.onboarded && s.screen === "tone") { signOut(); break; }
      if (s.onboarded) {
        go("settings");
        break;
      }
      const steps = [
        "welcome",
        "tone",
        "conversation",
        "firstGoal",
        "calendar",
        "apps",
        "breaks",
        "tutorial",
        "suggestions",
      ];
      go(steps[Math.max(0, steps.indexOf(s.screen) - 1)]);
      break;
    }
    case "edit-number":
      go("welcome");
      break;
    case "tone":
      s.tone = v;
      render();
      break;
    case "tone-next":
      go(s.onboarded ? "settings" : "conversation");
      break;
    case "answer":
      s.answers.push(v);
      render();
      break;
    case "first-goal":
      go("firstGoal");
      break;
    case "goal-example":
      document.querySelector("[name=title]").value = v;
      break;
    case "calendar-connect": {
      cal.notice = "";
      if (!calendarApi) { cal.notice = "Calendar connection needs the cloud setup. Continue without it for now."; render(); break; }
      if (!navigator.onLine) { cal.notice = "Connect to the internet to link Google Calendar, or continue without it."; render(); break; }
      calendarBusy = true;
      render();
      try {
        // The server finds the account by number, so it must exist in the cloud.
        persistAccount();
        await accounts.sync(activePhone);
        hadCalendarKey = !!calendarKey();
        const key = calendarKey(true);
        if (!key) throw Error("This browser can’t save the calendar link. Allow website data and try again.");
        const url = await calendarApi.start(activePhone, key, location.origin + location.pathname);
        persistAccount();
        location.assign(url);
      } catch (err) {
        // A key made for this attempt was never registered; drop it so the page
        // shows the real error instead of trying to load a schedule.
        if (!hadCalendarKey) forgetDeviceKey(loginStorage, activePhone);
        calendarBusy = false;
        cal.notice = err.message;
        render();
      }
      break;
    }
    case "calendar-refresh":
      cal.notice = "";
      maybeLoadCalendar(true);
      render();
      break;
    case "calendar-next":
      cal.notice = "";
      go(s.onboarded ? "settings" : "apps");
      break;
    case "calendar-disconnect": {
      calendarBusy = true;
      render();
      try {
        if (calendarApi) await calendarApi.disconnect(activePhone, calendarKey());
        forgetDeviceKey(loginStorage, activePhone);
        cal = { ...emptyCalendar(), phone: activePhone };
        s.googleCalendar = false;
        toast("Google Calendar disconnected. Your tasks are unchanged.");
      } catch (err) {
        cal.notice = err.message;
      } finally {
        calendarBusy = false;
        render();
      }
      break;
    }
    case "toggle-app":
      s.selectedApps = s.selectedApps.includes(v)
        ? s.selectedApps.filter((x) => x !== v)
        : [...s.selectedApps, v];
      render();
      break;
    case "apps-next":
      go(s.onboarded ? "settings" : "breaks");
      break;
    case "break-minus":
    case "break-plus":
      s.requestedBreaks = Math.max(
        0,
        Math.min(10, s.requestedBreaks + (a === "break-plus" ? 1 : -1))
      );
      reconcile(s);
      render();
      break;
    case "breaks-next":
      go(s.onboarded ? "settings" : "tutorial");
      break;
    case "practice":
      if (!s.tutorial) {
        s.tutorial = true;
        render();
        toast("“Take one slow breath” — nicely done. Practice only!");
      }
      break;
    case "tutorial-next":
      s.suggestions = suggest(s);
      go("suggestions");
      break;
    case "edit-suggestion":
      taskEditor(id, "suggestion");
      break;
    case "approve-onboarding":
      completeOnboarding(true);
      break;
    case "own-tasks":
      completeOnboarding(false);
      taskEditor();
      break;
    case "new-task":
      taskEditor();
      break;
    case "edit-task":
      taskEditor(id);
      break;
    case "delete-task":
      removeTask(s, id);
      closeModal();
      render();
      toast("Task removed. Your progress and app access are up to date.");
      break;
    case "toggle-task": {
      const t = s.tasks.find((t) => t.id === id);
      if (t.done) {
        t.done = false;
        if (activePhone) forgetPhoto(loginStorage, activePhone, localDay(now(s)), t.id);
        const owner = s.goals.find((g) => g.id === t.goalId);
        if (owner && owner.stepsDone > 0) owner.stepsDone--;
        reconcile(s);
        render();
        toast(
          "“" + t.title + "” is back on your list. Earned breaks are kept."
        );
      } else if (t.photo) {
        photo = null;
        photoError = "";
        photoDialog(id);
      } else {
        const earned = completeTask(s, id);
        completion(t, earned);
      }
      break;
    }
    case "close-modal":
      closeModal();
      break;
    case "celebrate":
      celebrate();
      break;
    case "review-done":
      closeModal();
      go("home");
      break;
    case "new-goal":
      goalEditor();
      break;
    case "edit-goal":
      goalEditor(id);
      break;
    case "delete-goal":
      deleteGoal(s, id);
      closeModal();
      render();
      toast("Goal removed. Its daily tasks are still yours.");
      break;
    case "settings-page":
      go(el.dataset.to);
      break;
    case "sign-out":
      signOut();
      break;
    case "instagram-setup":
      await instagramSetup(v || "Instagram");
      break;
    case "reminders-setup":
      remindersModal();
      break;
    case "reminders-enable":
      await remindersEnable();
      break;
    case "reminders-disable":
      await remindersDisable();
      break;
    case "shortcut-copy":
      if (instagramConfig && ["url", "apiKey", "reminder"].includes(v)) {
        try { await copyText(instagramConfig[v]); toast("Copied. Paste it into Shortcuts."); }
        catch { modal.querySelector(`[data-shortcut-value="${v}"]`)?.select(); toast("Select and copy the highlighted value."); }
      }
      break;
    case "shortcut-check": {
      if (!instagramConfig) break;
      const output = modal.querySelector("#shortcut-result");
      el.disabled = true;
      output.textContent = "Checking your latest synced list…";
      try {
        const result = await checkInstagram(instagramConfig);
        output.textContent = `${result.decision === "allow" ? "Instagram stays open" : result.decision === "pause" ? "Reminder will open" : "Fresh sync needed"}: ${result.message}`;
      } catch (problem) { output.textContent = problem.message; }
      finally { el.disabled = false; }
      break;
    }
    case "profile":
      openModal(
        "A little about you.",
        `<form data-form="profile" novalidate><label class="field"><span>Name</span><input name="name" value="${esc(
          s.profile.name
        )}" maxlength="40"></label><label class="field"><span>Phone number</span><input type="tel" name="phone" value="${esc(
          s.profile.phone
        )}" autocomplete="tel" required></label><div class="form-error" role="alert"></div><button class="button" type="submit">Save profile</button><p class="small muted">Changing your number moves this account and its tasks to the new number. You’ll use it next time you sign in. A number change needs internet; name changes also work offline.</p></form>`
      );
      break;
    case "submit-photo": {
      if (!photo || photoBusy) break;
      const taskId = photoTask,
        taken = photo,
        phone = activePhone,
        originDay = s.day,
        originState = s;
      const t = s.tasks.find((t) => t.id === taskId);
      if (!t) break;
      photoBusy = true;
      photoError = "";
      photoDialog(taskId);
      const originVersion = modalVersion;
      let result;
      try {
        result = checkPhoto && phone
          ? await checkPhoto(phone, t.title, taken)
          : { fallback: true, message: "Photo checking needs the cloud setup, so your photo counts as proof." };
      } catch (problem) {
        result = { error: problem.message };
      }
      photoBusy = false;
      // Stop if the dialog was closed, the day rolled over or the account changed.
      if (originVersion !== modalVersion || originDay !== localDay(now(s)) || originState !== s || phone !== activePhone) break;
      if (result.error) {
        photoError = result.error;
        photoDialog(taskId);
        break;
      }
      const before = stats(s).banked;
      const outcome = result.fallback ? photoAttempt(s, taskId, 1) : photoAttempt(s, taskId, result.verdict === "fail" ? 0 : 1);
      if (outcome === "retry") {
        photo = null;
        photoError = `${result.reason || "I couldn’t quite see the finished task."} ${t.failures} of 3 checks tried.`;
        photoDialog(taskId);
        break;
      }
      if (phone) keepPhoto(loginStorage, phone, localDay(now(s)), taskId, taken.keep);
      photo = null;
      closeModal();
      completion(t, stats(s).banked > before ? [1] : [], outcome === "supported", result.fallback ? result.message : result.reason);
      break;
    }
    case "start-break":
      try {
        startBreak(s);
        closeModal();
        render();
        toast(
          "Your 10-minute break starts now. Selected apps are temporarily unlocked."
        );
      } catch (err) {
        toast(err.message);
      }
      break;
    case "end-break": {
      // Explain what ending now means before doing it.
      const p = breakEndPreview(s);
      if (!p) { toast("There is no break running."); break; }
      const message =
        p.outcome === "refund"
          ? "You’ve used less than 2 minutes, so this break goes back to your bank to use later."
          : p.outcome === "forfeit-repeat"
          ? "This break was already returned to your bank once, so ending it now won’t put it back."
          : `You’ve used ${Math.floor(p.used / 60000)} of 10 minutes. Ending now won’t put the rest of this break back in your bank.`;
      openModal(
        "End your break early?",
        `<p>${message}</p>${btn("End break", "confirm-end-break")}${btn("Keep my break", "close-modal", "ghost")}`
      );
      break;
    }
    case "confirm-end-break":
      try {
        const r = endBreak(s);
        closeModal();
        render();
        toast(
          r.outcome === "refund"
            ? "Break ended and saved for later. Selected apps are paused again."
            : "Break ended. Selected apps are paused again."
        );
      } catch (err) {
        toast(err.message);
      }
      break;
    case "break-detail":
      breakDetail();
      break;
    case "try-apps":
      tryApps();
      break;
    case "open-app":
      s.attemptedApp = v;
      closeModal();
      go("locked");
      break;
    case "tackle": {
      // Suggest the most urgent task that counts toward unlocking apps.
      const task = s.tasks
        .filter((t) => !t.done && !t.reminder)
        .sort((x, y) => urgencyRank(x) - urgencyRank(y))[0];
      go("home");
      if (task) toast("A place to start: “" + task.title + "”");
      break;
    }
    case "lockscreen":
      go("lockscreen");
      break;
    case "day-rules":
      rules();
      break;
    case "demo":
      demo();
      break;
    case "finish-break":
      s.activeUntil = 0;
      closeModal();
      render();
      toast(
        stats(s).remaining
          ? "Break finished. Your selected apps are paused again."
          : "Your apps are fully unlocked."
      );
      break;
    case "midnight": {
      const d = new Date(now(s));
      d.setHours(24, 0, 1, 0);
      s.timeOffset = d.getTime() - Date.now();
      rollover(s);
      closeModal();
      go("home");
      toast(
        "A fresh day. Unfinished one-time tasks carried over; daily breaks reset."
      );
      break;
    }
    case "sample-day": {
      if (USE_SUPABASE) { toast("Switch off Supabase in the config to use sample data."); break; }
      s = initial();
      s.onboarded = true;
      s.loginVerified = true;
      s.screen = "home";
      s.profile = { name: "Alex", phone: "(555) 123-4567" };
      rememberLogin();
      s.answers = [
        "I’m studying and working",
        "Friends, music, and the gym",
        "After class. I get pulled into scrolling.",
      ];
      s.goals = [
        {
          id: uid(),
          title: "Feel ready for my final exams",
          target: localDay(now(s) + 30 * 86400000),
        },
      ];
      suggest(s).forEach((t) => addTask(s, t));
      s.tasks[2].photo = true;
      closeModal();
      render();
      toast("Meet Alex’s sample day. Four tasks, two possible breaks.");
      break;
    }
    case "reset":
      openModal(
        "A fresh beginning?",
        `<p>Sign out to try another number. This account’s tasks and pending changes stay saved on this device.</p>${btn(
          "Sign out",
          "confirm-reset",
          "danger"
        )}${btn("Keep my progress", "close-modal", "ghost")}`
      );
      break;
    case "confirm-reset":
      signOut();
      break;
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.suggestion) {
    const t = s.suggestions.find((t) => t.id === e.target.dataset.suggestion);
    t.selected = e.target.checked;
    render();
  }
  if (e.target.id === "photo-upload") {
    const file = e.target.files?.[0];
    if (!file) return;
    const taskId = photoTask;
    photo = null;
    photoError = "";
    photoPreparing = true;
    photoDialog(taskId);
    const originVersion = modalVersion;
    preparePhoto(file).then(
      (ready) => { photo = ready; },
      (problem) => { photoError = problem.message; }
    ).finally(() => {
      photoPreparing = false;
      if (originVersion === modalVersion && photoTask === taskId) photoDialog(taskId);
    });
  }

if (e.target.id === "avatar-upload") {
  const input = e.target;
  const file = input.files?.[0];
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    toast("Please choose a JPG, PNG, or WebP image.");
    input.value = "";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast("Choose a picture under 8 MB.");
    input.value = "";
    return;
  }
  resizeAvatar(file)
    .then((dataUrl) => {
      const previous = s.profile.avatar;
      s.profile.avatar = dataUrl;
      persistAccount();
      if (storageFailed) {
        if (previous) s.profile.avatar = previous;
        else delete s.profile.avatar;
        toast("Your picture couldn’t be saved. Free some device storage and try again.");
        return;
      }
      render();
      toast("Profile picture updated.");
    })
    .catch(() => toast("That image couldn’t be opened. Please try another."))
    .finally(() => { input.value = ""; });
}

});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!form.dataset.form) return;
  e.preventDefault();
  rollover(s);
  const f = new FormData(form),
    values = Object.fromEntries(f.entries());
  const fail = (msg) => {
    const target = form.querySelector(".form-error");
    if (target) {
      target.className = "form-error error";
      target.textContent = msg;
    } else {
      error = msg;
      render();
    }
  };
  if (values.target && values.target < localDay()) { fail("Choose today or a future date."); return; }
  switch (form.dataset.form) {
    case "signup": {
      let phone;
      try { phone = normalizePhone(values.phone); }
      catch (problem) { fail(problem.message); break; }
      error = "";
      try { await accounts.refreshRetired(phone); activateAccount(phone, values.name.trim()); }
      catch (problem) { fail(problem.message); break; }
      render();
      syncAccounts();
      break;
    }
    case "answer": {
      const value = values.answer.trim();
      if (value) {
        s.answers.push(value);
        render();
      } else
        toast(
          "A quick reply is all we need. You can use one of the suggestions."
        );
      break;
    }
    case "first-goal": {
      s.goalDraftTitle = values.title;
      s.goalDraftTarget = values.target;
      if (!values.title.trim()) {
        fail("Give your bigger goal a name. It can be simple.");
        break;
      }
      if (!values.target) {
        fail("Choose a target date for your bigger goal.");
        break;
      }
      s.goals = [
        {
          id: s.goals[0]?.id || uid(),
          title: values.title.trim(),
          target: values.target,
          created: s.goals[0]?.created || localDay(now(s)),
          stepsDone: s.goals[0]?.stepsDone || 0,
        },
      ];
      go("calendar");
      break;
    }
    case "task": {
      const data = { ...values, photo: f.has("photo"), reminder: f.has("reminder") };
      if (!data.title.trim()) {
        fail("Give your task a name. A few words are enough.");
        break;
      }
      if (
        data.duration &&
        (!Number.isFinite(+data.duration) ||
          +data.duration < 1 ||
          +data.duration > 1440)
      ) {
        fail("Choose a duration from 1 to 1,440 minutes, or leave it blank.");
        break;
      }
      if (taskDraft.kind === "suggestion") {
        const source = s.suggestions;
        Object.assign(
          source.find((t) => t.id === taskDraft.id),
          data
        );
        closeModal();
        render();
        toast("Suggestion updated. Add it only when you’re ready.");
      } else {
        try {
          taskDraft.id ? editTask(s, taskDraft.id, data) : addTask(s, data);
          closeModal();
          render();
          toast("“" + data.title.trim() + "” saved to today.");
        } catch (err) {
          fail(err.message);
        }
      }
      break;
    }
    case "goal": {
      if (!values.title.trim() || !values.target) {
        fail(
          !values.title.trim()
            ? "Add a name for your goal."
            : "Choose a target date."
        );
        break;
      }
      const g = s.goals.find((g) => g.id === goalDraft.id);
      if (g)
        Object.assign(g, { title: values.title.trim(), target: values.target });
      else
        s.goals.push({
          id: uid(),
          title: values.title.trim(),
          target: values.target,
          created: localDay(now(s)),
          stepsDone: 0,
        });
      closeModal();
      render();
      toast("Your bigger goal is saved.");
      break;
    }
    case "profile": {
      let phone;
      const name = values.name.trim();
      if (!name || name.length > 40) { fail("Enter a name of 1–40 characters."); break; }
      try { phone = normalizePhone(values.phone); }
      catch (problem) { fail(problem.message); break; }
      if (phone !== activePhone) {
        const save = form.querySelector('button[type="submit"]');
        save.disabled = true;
        save.textContent = "Saving profile…";
        try {
          persistAccount();
          if (storageFailed) throw Error("Free some device storage before changing your number.");
          if (legacyPhone) throw Error("Wait for your previous tasks to finish importing, then try again.");
          await accounts.rename(activePhone, phone, name);
        } catch (problem) {
          fail(problem.message);
          save.disabled = false;
          save.textContent = "Save profile";
        }
      } else {
        s.profile = { ...s.profile, name, phone: activePhone };
        persistAccount();
        if (storageFailed) { fail("Your profile couldn’t be saved. Free some device storage and try again."); break; }
        closeModal();
        render();
        toast("Profile updated.");
      }
      break;
    }
  }
});
modal.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeModal();
});
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    const r = modal.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeModal();
  }
});
function updateTimers() {
  const changed = rollover(s),
    hadActive = s.activeUntil > 0;
  if (s.activeUntil && s.activeUntil <= now(s)) s.activeUntil = 0;
  if (changed || (hadActive && !s.activeUntil)) {
    render();
    if (changed) toast("A fresh day. Your daily list and breaks have reset.");
    else
      toast(
        stats(s).remaining
          ? "Your break is over. Selected apps are paused again."
          : "Your apps are fully unlocked."
      );
  }
  const seconds = Math.max(0, Math.ceil((s.activeUntil - now(s)) / 1000)),
    time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(
      2,
      "0"
    )}`;
  document
    .querySelectorAll("[data-countdown]")
    .forEach((el) => (el.textContent = time));
}
window.addEventListener("focus", updateTimers);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateTimers();
});
setInterval(updateTimers, 1000);
databaseStatus("welcome");
if (s.loginVerified) {
  try {
    const phone = normalizePhone(s.profile.phone);
    legacyPhone = loginStorage.getItem("first-things-legacy-pending");
    if (!accounts.read(phone) && USE_SUPABASE) {
      legacyPhone = phone;
      loginStorage.setItem("first-things-legacy-pending", phone);
    }
    activateAccount(phone, s.profile.name);
  }
  catch { s = initial(); rememberLogin(); }
}
// Hidden route: the Progress report is no longer in the navigation. Adding
// #progress to the app's address (for example .../index.html#progress) opens it
// for demos and grading. It only opens for a signed-in, onboarded user, so the
// welcome and setup screens can't be skipped.
function openHiddenReport() {
  if (location.hash !== "#progress" || !activePhone || !s.onboarded) return;
  go("progress");
}
window.addEventListener("hashchange", openHiddenReport);
setupPWA({ beforeUpdate: () => { persistAccount(); return !storageFailed; } });
// Google sends people back with ?calendar=connected|denied|missing|error.
const calendarResult = new URL(location.href).searchParams.get("calendar");
if (calendarResult) {
  const cleanURL = new URL(location.href);
  cleanURL.searchParams.delete("calendar");
  history.replaceState(null, "", cleanURL);
  if (s.loginVerified && activePhone) {
    // Reloading would restart onboarding, so resume on the calendar step.
    s.screen = "calendar";
    if (calendarResult === "connected") toast("Google Calendar connected.");
    else cal.notice = CALENDAR_RESULTS[calendarResult] || CALENDAR_RESULTS.error;
  } else {
    // On iPhone, Google may return to Safari instead of the Home Screen app.
    openModal("Back to First Things", `<p>${calendarResult === "connected"
      ? "Your Google Calendar is connected."
      : "Google Calendar wasn’t connected."} Switch back to your First Things Home Screen app to continue.</p><button class="button" data-action="close-modal">Got it</button>`);
  }
}
// Returning from Google in another window: check again when this one is seen.
const recheckCalendar = () => { if (!document.hidden && s.screen === "calendar" && cal.phase !== "ready") maybeLoadCalendar(true); };
window.addEventListener("focus", recheckCalendar);
document.addEventListener("visibilitychange", recheckCalendar);
// Back-button return from Google restores this page from cache with the busy state.
window.addEventListener("pageshow", (e) => { if (e.persisted && calendarBusy) { calendarBusy = false; render(); } });
render();
openHiddenReport(); // handles a page that loads with #progress already set
syncAccounts();
updateTimers();
// Optional browser-native tools share the same state and visible actions.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = (tool) => {
    try {
      Promise.resolve(
        document.modelContext.registerTool(tool, { signal: lifecycle.signal })
      ).catch(() => {});
    } catch {}
  };
  register({
    name: "read_daily_progress",
    title: "Read today’s progress",
    description:
      "Read tasks, app access, and earned breaks in the First Things local demo.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: () => ({
      day: s.day,
      ...stats(s),
      tasks: s.tasks.map(({ id, title, done, photo }) => ({
        id,
        title,
        done,
        photo,
      })),
    }),
  });
  register({
    name: "add_daily_task",
    title: "Add a task for today",
    description:
      "Add an approved task to today’s local demo list. Unfinished tasks pause selected apps unless a break is active.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1, maxLength: 180 } },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: (input) => {
      if (!s.onboarded) throw Error("Complete onboarding first.");

      if (
        !input ||
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.length > 180 ||
        Object.keys(input).some((k) => k !== "title")
      )
        throw Error("Provide a task title of 1–180 characters.");
      rollover(s);
      const task = addTask(s, { title: input.title });
      render();
      return { id: task.id, title: task.title, blocked: stats(s).blocked };
    },
  });
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}

// A neutral redirect page: no account identifiers or task data in the URL.
if (new URL(location.href).searchParams.get("instagram") === "paused") {
  openModal("First things first.", `<p>Take a moment before Instagram. Finish your first things or start an earned break, then wait for <b>All changes synced</b>.</p><p>If this is your first check today, open First Things to refresh today’s list. If this opened in Safari, switch to your First Things Home Screen app.</p><button class="button" data-action="close-modal">Got it</button><p class="small muted">This is a Shortcuts reminder, not an iOS app lock.</p>`);
  const cleanURL = new URL(location.href); cleanURL.searchParams.delete("instagram");
  history.replaceState(null, "", cleanURL);
}
