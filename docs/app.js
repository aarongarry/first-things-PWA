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
  rollover,
  deleteGoal,
  suggest,
} from "./model.js";
import { restoreLogin, saveLogin } from "./session.js";
import { USE_SUPABASE, SUPABASE_URL, SUPABASE_KEY } from "./supabase-config.js";
import { createCloud } from "./cloud.js";
import { normalizePhone, accountSnapshot, applySnapshot, createAccountStore } from "./offline.js";
import { setupPWA } from "./pwa.js";
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
  chatBusy = false,
  chatError = false,
  chatDraft = "",
  pendingMessage = "",
  toastTimer,
  returnTo = "home",
  taskDraft = null,
  goalDraft = null,
  calendarError = false,
  calendarBusy = false,
  modalVersion = 0;
let activePhone = null;
let lastSnapshot = null;
let syncTimer;
let legacyPhone = null;
let legacyImport = null;
let storageFailed = false;
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
const accounts = createAccountStore({
  storage: loginStorage,
  remote: USE_SUPABASE ? createCloud() : null,
  online: () => navigator.onLine,
  report(phone, phase, message) {
    if (phone === activePhone && !storageFailed) databaseStatus(phase, message);
  },
  renamed(oldPhone, newPhone, snapshot) {
    if (activePhone !== oldPhone) return;
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
    applySnapshot(s, snapshot);
    lastSnapshot = accountSnapshot(s);
    if (!wasOnboarded && s.onboarded) s.screen = "home";
    rememberLogin();
    if (!modal.open && !document.activeElement?.matches('input, textarea, select')) render();
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
  settings:
    '<circle cx="12" cy="12" r="4"/><path d="m10 2-1 3-3 1-3-1-2 4 2 3-1 3 3 3h3l2 4h4l1-3 3-1 3 1 2-4-2-3 1-3-3-3h-3l-2-4Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  unlock:
    '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 7-2M12 14v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
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
    ["chat", "George", "chat"],
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
    chat: chat,
    settings: settings,
    locked: locked,
    lockscreen: lockscreen,
  };
  root.innerHTML = (map[s.screen] || home)();
  persistAccount();
  if (s.screen === "chat" || s.screen === "conversation")
    root.scrollTop = root.scrollHeight;
  document.querySelector("#phone-time").textContent = new Date(
    now(s)
  ).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
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
    )}</textarea></label><div class="chips"><button type="button" data-action="goal-example" data-value="Feel ready for my final exams">Be ready for finals</button><button type="button" data-action="goal-example" data-value="Build a consistent fitness routine">Move more</button></div><label class="field"><span>Target date</span><input type="date" name="target" value="${
      s.goalDraftTarget ?? g?.target ?? localDay(now(s) + 30 * 86400000)
    }"></label><p class="small muted">A direction to work toward, not a deadline for every task. You can always change it.</p>${
      error ? `<div class="error" role="alert">${esc(error)}</div>` : ""
    }<button class="button">Save my first goal</button></form>`
  );
}
function calendar() {
  return step(
    "A little context<br>for your day.",
    "Connecting a calendar helps George see where a small task might fit. It’s completely optional.",
    4,
    `<div class="calendar-illustration">${icon(
      "calendar"
    )}<span>Make space,<br>not more pressure.</span></div>${
      s.calendar
        ? `<div class="success-note">✓ Google Calendar connected in this demo</div><div class="card"><p class="section-label">SAMPLE SCHEDULE</p><div class="calendar-event"><b>10:00</b><span>Psychology lecture<small>60 minutes</small></span></div><div class="calendar-event"><b>13:30</b><span>Library study group<small>45 minutes</small></span></div><div class="calendar-event"><b>16:00</b><span>Room for a small win<small>20 minutes free</small></span></div></div>`
        : `<div class="card row"><span class="google-g">G</span><div><b>Google Calendar</b><p class="small muted" style="margin:4px 0">A simulated connection.<br>No sign-in or real calendar access.</p></div></div>`
    }${
      calendarError
        ? '<div class="error" role="alert">The calendar couldn’t connect. Your setup is saved. Try again, or continue without it.</div>'
        : ""
    }`,
    s.calendar
      ? `${btn("Continue", "calendar-next")}${
          s.onboarded
            ? btn("Disconnect calendar", "calendar-disconnect", "ghost")
            : ""
        }`
      : `${btn(
          calendarBusy ? "Connecting…" : "Connect Google Calendar",
          "calendar-connect",
          "",
          calendarBusy ? "disabled" : ""
        )}${btn(
          s.onboarded ? "Done" : "Skip for now",
          "calendar-next",
          "ghost"
        )}${btn(
          "Demo: simulate connection failure",
          "calendar-fail",
          "ghost",
          calendarBusy ? "disabled" : ""
        )}`
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
            a.short
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
    }</div><p class="small muted">This prototype demonstrates app blocking inside the demo only. It doesn’t control your device.</p>`,
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
    todo = s.tasks.filter((t) => !t.done);
  return `<section class="page daily"><header class="daily-header"><div><span class="section-label">${today()}</span><h1>Your day, ${esc(
    name
  )}<span class="blue">.</span></h1></div><button class="profile-circle" data-action="nav" data-to="settings" aria-label="Open settings">${esc(
    name[0]?.toUpperCase()
  )}</button></header><div class="progress-card"><div><span class="overline">YOUR FIRST THINGS</span><h2>${
    st.total
      ? st.remaining === 0
        ? "Look at you go."
        : `${st.remaining} little step${st.remaining === 1 ? "" : "s"} left.`
      : "A fresh start."
  }</h2><span class="progress-detail">${st.done} of ${
    st.total
  } tasks complete</span></div><div class="progress-ring" style="--progress:${
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
      : `<button data-action="break-detail" aria-label="Break details">${icon(
          "clock"
        )}</button>`
  }</div><div class="task-heading"><h2>Today’s list <span>${
    st.total
  }</span></h2><button class="icon-btn blue" data-action="new-task" aria-label="Add a task">${icon(
    "plus"
  )}</button></div>${
    !st.total
      ? `<div class="empty-state">${icon(
          "spark"
        )}<h3>A little space for possibility.</h3><p>Add something you want to do today.<br>A few words are all you need.</p>${btn(
          "Add my first task",
          "new-task",
          "secondary"
        )}</div>`
      : todo.length
      ? todo.map(taskRow).join("")
      : `<div class="completed-banner"><span>✦</span><h3>First things, done.</h3><p>You made time for what matters.<br>Your apps are fully unlocked.</p><button class="text-link" data-action="celebrate">Enjoy this little moment</button></div>`
  }${
    done.length
      ? `<div class="done-label">COMPLETED · ${done.length}</div>${done
          .map(taskRow)
          .join("")}`
      : ""
  }<button class="add-task" data-action="new-task">${icon(
    "plus"
  )} Add a little first thing</button><button class="george-home" data-action="nav" data-to="chat">${avatar()}<span><b>Big task on your mind?</b><small>Let’s find a small place to start.</small></span>${icon(
    "chat"
  )}</button>${
    s.calendar
      ? '<div class="calendar-mini">' +
        icon("calendar") +
        ' Next up: library study group · 1:30 PM <span class="pill">DEMO</span></div>'
      : ""
  }<p class="day-note">A new day starts at midnight. <button data-action="day-rules">How it works</button></p></section>${navigation(
    "home"
  )}`;
}
function taskRow(t) {
  const goal = s.goals.find((g) => g.id === t.goalId);
  return `<div class="task-card ${
    t.done ? "completed" : ""
  }"><button class="task-check" data-action="toggle-task" data-id="${
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
      t.photo ? "Photo check" : null,
      goal?.title,
    ]
      .filter(Boolean)
      .map(esc)
      .join(" · ") || "Your own little first thing"
  }</small></button>${
    t.photo && !t.done
      ? `<span class="photo-indicator">${icon("camera")}</span>`
      : ""
  }<button class="task-menu" data-action="edit-task" data-id="${
    t.id
  }" aria-label="Edit ${esc(t.title)}">${icon("more")}</button></div>`;
}
function goals() {
  return `<section class="page"><div class="page-top"><span class="section-label">THE BIGGER PICTURE</span><button class="icon-btn blue" data-action="new-goal" aria-label="Add goal">${icon(
    "plus"
  )}</button></div><h1>Things worth<br>working toward<span class="blue">.</span></h1><p class="body-copy">Your daily steps have somewhere to go.</p>${
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
            )}</h2><div class="small muted">${icon(
              "calendar"
            )} Target: ${dateText(
              g.target
            )}</div><div class="goal-progress"><span>${
              associated.filter((t) => t.done).length
            } of ${
              associated.length
            } associated tasks done today</span><div><i style="width:${
              associated.length
                ? (associated.filter((t) => t.done).length /
                    associated.length) *
                  100
                : 0
            }%"></i></div></div><button class="button secondary" data-action="goal-steps" data-id="${
              g.id
            }">${icon("spark")} Ask George for next steps</button>${
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
function chat() {
  return `<section class="page chat-page"><div class="chat-header">${avatar()}<div><h1>George</h1><span>Your ${tones[
    s.tone
  ].label.toLowerCase()} first-things friend</span></div><span class="pill">DEMO AI</span></div><div class="chat-history">${bubble(
    s.tone === "direct"
      ? "Let’s choose one useful step. What needs your attention?"
      : s.tone === "gentle"
      ? "Hey, I’m here. We can make a big thing feel a little smaller."
      : "Hey, " +
        esc(s.profile.name) +
        ". A little stuck, or just need a nudge? Let’s figure it out."
  )}${s.messages
    .map((m) =>
      m.role === "user"
        ? `<div class="user-bubble">${esc(m.text)}</div>`
        : bubble(esc(m.text))
    )
    .join("")}${
    chatBusy
      ? bubble(
          '<span class="typing">● ● ●</span> Thinking of a small next step…'
        )
      : ""
  }${
    chatError
      ? `<div class="error">I couldn’t get a reply ready. Your message is safe.<button class="text-link" data-action="retry-chat">Try again</button></div>`
      : ""
  }${
    s.chatSuggestions?.length
      ? `<div class="chat-proposals"><p class="section-label">A FEW IDEAS — YOUR CHOICE</p>${s.chatSuggestions
          .map(
            (t) =>
              `<div class="suggestion-card"><b>${esc(
                t.title
              )}</b><p class="small muted">${t.duration} min · ${esc(
                t.why
              )}</p><div class="row"><button class="button secondary compact" data-action="accept-chat-task" data-id="${
                t.id
              }">Add to today</button><button class="text-link" data-action="edit-chat-task" data-id="${
                t.id
              }">Adjust</button><button class="icon-btn" data-action="reject-chat-task" data-id="${
                t.id
              }" aria-label="Dismiss suggestion">${icon(
                "close"
              )}</button></div></div>`
          )
          .join("")}</div>`
      : ""
  }</div><div class="chips"><button data-action="chat-prompt" data-value="Help me break down my goal">Break down my goal</button><button data-action="chat-prompt" data-value="I’m feeling overwhelmed">I’m overwhelmed</button><button data-action="chat-prompt" data-value="Give me a little motivation">A little motivation</button></div><form class="composer" data-form="chat"><input name="message" aria-label="Message George" value="${esc(
    chatDraft
  )}" placeholder="What’s on your mind?" maxlength="1000"><button aria-label="Send message" ${
    chatBusy ? "disabled" : ""
  }>${icon("send")}</button></form></section>${navigation("chat")}`;
}
function settings() {
  return `<section class="page"><span class="section-label">MAKE IT YOURS</span><h1>A little more you<span class="blue">.</span></h1><div class="profile-card"><span class="profile-circle">${esc(
    s.profile.name[0]?.toUpperCase()
  )}</span><div><b>${esc(s.profile.name)}</b><small>${esc(
    s.profile.phone
  )}</small></div><button class="text-link profile-edit" data-action="profile" aria-label="Edit profile">Edit ${icon(
    "edit"
  )}</button></div><p class="section-label">YOUR DAILY RHYTHM</p>${[
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
      s.calendar
        ? "Connected · simulated Google Calendar"
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
    )}<p class="section-label" style="margin-top:27px">EXPLORE THE PROTOTYPE</p><button class="setting-row" data-action="try-apps">${icon(
    "phone"
  )}<span><b>Try a distracting app</b><small>See why it’s paused or unlocked</small></span><span>›</span></button><button class="setting-row" data-action="lockscreen">${icon(
    "lock"
  )}<span><b>Lock-screen preview</b><small>A little reminder from George</small></span><span>›</span></button><button class="setting-row" data-action="demo">${icon(
    "spark"
  )}<span><b>Demo controls</b><small>Explore resets and recovery states</small></span><span>›</span></button><button class="setting-row" data-action="day-rules">${icon(
    "clock"
  )}<span><b>What happens at midnight?</b><small>Daily reset and prototype assumptions</small></span><span>›</span></button><button class="setting-row" data-install>${icon("phone")}<span><b>Install First Things</b><small>Add to your Home Screen</small></span><span>›</span></button><button class="setting-row" data-action="sign-out">${icon("back")}<span><b>Sign out / switch account</b><small>Your saved tasks stay on this device</small></span><span>›</span></button><p class="privacy-note">Tasks are saved on this device and sync when you’re online with the app open. Demo phone accounts do not use verification.<br>AI, calendars, photos, and app blocking are simulated.</p></section>${navigation(
    "settings"
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
        }.</p></div>${btn("Back to my day", "nav", "", 'data-to="home"')}`
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
      : kind === "chat"
      ? s.chatSuggestions
      : s.tasks;
  const t = source?.find((x) => x.id === id) || {
    title: "",
    duration: "",
    recurrence: "none",
    photo: false,
    goalId: "",
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
      )}</select></label><label class="toggle-label"><span><b>Verify with a photo</b><small>Optional. Otherwise, just check it off.</small></span><input type="checkbox" name="photo" ${
      t.photo ? "checked" : ""
    }></label><p class="small muted">This task goes on today’s list. Weekly repeats follow today’s weekday; monthly repeats follow the calendar day, or the last day in a shorter month.</p><div class="form-error" role="alert"></div><button class="button">${
      kind === "chat" ? "Save suggestion" : id ? "Save changes" : "Add to today"
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
    )}</textarea></label><label class="field"><span>Target date</span><input type="date" name="target" value="${
      g.target
    }"></label><div class="form-error" role="alert"></div><button class="button">Save goal</button>${
      id
        ? `<button type="button" class="button danger" data-action="delete-goal" data-id="${id}">Remove goal</button><p class="small muted">Your daily tasks will stay in your list.</p>`
        : ""
    }</form>`
  );
}
function completion(t, earned = [], support = false) {
  render();
  const prefix =
    s.tone === "gentle"
      ? "That’s a lovely little step."
      : s.tone === "direct"
      ? "Done. Nice follow-through."
      : "A little win looks good on you!";
  toast(
    `${prefix} “${t.title}” is complete.${
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
        ? `<img src="${photo}" alt="Photo selected for review">`
        : `${icon("camera")}<span>Add a photo to review first</span>`
    }</div>${
      photoError
        ? `<div class="error" role="alert">${esc(photoError)}</div>`
        : ""
    }<div class="row">${btn(
      photo ? "Replace sample" : "Take demo photo",
      "sample-photo",
      "secondary"
    )}<label class="button secondary upload-label">Upload photo<input type="file" accept="image/*" id="photo-upload"></label></div><p class="small muted">Photos stay in this browser. The demo camera uses George as a sample image; all checks are simulated.</p><label class="field"><span>Demo verification result</span><select id="photo-result"><option value="pass">Photo accepted</option><option value="fail">Photo needs another try</option><option value="upload-fail">Upload fails (doesn’t count)</option></select></label>${btn(
      photoBusy ? "Checking your photo…" : "Submit photo",
      "submit-photo",
      "",
      photoBusy ? "disabled" : ""
    )}<p class="privacy-note">${
      t.failures
        ? `${t.failures} unsuccessful check${
            t.failures === 1 ? "" : "s"
          } so far. After three, George trusts your effort.`
        : "You can review or replace your photo before submitting."
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
          )}${btn("Fail George’s next reply", "fail-next-chat", "secondary")}`
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
            a.short
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
        : btn("Back to my day", "close-modal")
    }`
  );
}
function respond(text, retry = false) {
  if (chatBusy) return;
  chatDraft = "";
  if (!retry) s.messages.push({ role: "user", text });
  pendingMessage = text;
  chatError = false;
  chatBusy = true;
  s.screen = "chat";
  render();
  setTimeout(() => {
    chatBusy = false;
    if (s.failNextChat) {
      s.failNextChat = false;
      chatError = true;
      render();
      return;
    }
    const g = s.goals.find((g) => g.id === s.chatGoal) || s.goals[0];
    s.chatGoal = "";
    let response;
    if (/overwhelm|stress|hard|tired/i.test(text))
      response =
        s.tone === "direct"
          ? "Make the task smaller. Pick one thing you can do in five minutes, then reassess."
          : s.tone === "gentle"
          ? "You don’t have to carry the whole day at once. Take a breath; we can choose a five-minute start."
          : "Let’s turn the volume down a little. One small task, then a pause to see how you feel.";
    else if (/motiv|encourag/i.test(text))
      response =
        s.tone === "direct"
          ? "Your next move doesn’t need to be impressive. It needs to be small enough to start. Pick your first unfinished task."
          : s.tone === "gentle"
          ? "A slow start is still a start. You’re allowed to take this one little thing at a time."
          : "You don’t need a perfect day to make progress. Your next small win is right there.";
    else {
      response = `${
        s.tone === "direct"
          ? "Let’s make it actionable."
          : s.tone === "gentle"
          ? "We can take this gently."
          : "Let’s find an easy place to start."
      } ${
        g
          ? `For “${g.title},” here are a couple of small steps.`
          : "Here are two little steps you could try."
      } ${
        s.answers[2]
          ? `You mentioned “${s.answers[2]}” — keep the first step short.`
          : ""
      } Add only what works for you.`;
      s.chatSuggestions = suggest(s, g).slice(0, 2);
    }
    s.messages.push({ role: "george", text: response });
    render();
  }, 850);
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
    case "calendar-connect":
    case "calendar-fail":
      calendarBusy = true;
      calendarError = false;
      render();
      setTimeout(() => {
        calendarBusy = false;
        calendarError = a === "calendar-fail";
        s.calendar = !calendarError;
        render();
        if (s.calendar) toast("Your sample calendar is connected.");
      }, 800);
      break;
    case "calendar-next":
      calendarError = false;
      go(s.onboarded ? "settings" : "apps");
      break;
    case "calendar-disconnect":
      s.calendar = false;
      render();
      toast("Calendar disconnected. Your tasks are unchanged.");
      break;
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
    case "goal-steps":
      s.chatGoal = id;
      go("chat");
      respond(
        "Help me find smaller steps for " +
          s.goals.find((g) => g.id === id).title
      );
      break;
    case "chat-prompt":
      respond(v);
      break;
    case "retry-chat":
      respond(pendingMessage, true);
      break;
    case "accept-chat-task": {
      const t = s.chatSuggestions.find((t) => t.id === id);
      addTask(s, t);
      s.chatSuggestions = s.chatSuggestions.filter((t) => t.id !== id);
      render();
      toast("“" + t.title + "” added to today.");
      break;
    }
    case "edit-chat-task":
      taskEditor(id, "chat");
      break;
    case "reject-chat-task":
      s.chatSuggestions = s.chatSuggestions.filter((t) => t.id !== id);
      render();
      break;
    case "settings-page":
      go(el.dataset.to);
      break;
    case "sign-out":
      signOut();
      break;
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
    case "sample-photo": {
      photo = new URL("george.png", location.href).href;
      photoError = "";
      photoDialog(photoTask);
      break;
    }
    case "submit-photo": {
      if (!photo) {
        photoError =
          "Add or take a demo photo first. No attempt has been counted.";
        photoDialog(photoTask);
        break;
      }
      const result = document.querySelector("#photo-result").value;
      if (result === "upload-fail") {
        photoError =
          "That photo couldn’t upload. Try again or replace it. This doesn’t count as a failed check.";
        photoDialog(photoTask);
        break;
      }
      const taskId = photoTask,
        originVersion = modalVersion,
        originDay = s.day,
        originState = s;
      photoBusy = true;
      el.disabled = true;
      el.textContent = "Checking your photo…";
      setTimeout(() => {
        photoBusy = false;
        if (
          originVersion !== modalVersion ||
          originDay !== localDay(now(s)) ||
          originState !== s
        )
          return;
        const t = s.tasks.find((t) => t.id === taskId);
        if (!t) return;
        const before = stats(s).banked;
        const outcome = photoAttempt(s, taskId, result === "pass" ? 0.92 : 0.5);
        if (outcome === "retry") {
          photoError = `I couldn’t quite see the completed task. Try another angle or a clearer photo. ${t.failures} of 3 checks tried.`;
          if (modal.open) photoDialog(taskId);
        } else {
          closeModal();
          completion(
            t,
            stats(s).banked > before ? [1] : [],
            outcome === "supported"
          );
        }
      }, 900);
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
      const task = s.tasks.find((t) => !t.done);
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
    case "fail-next-chat":
      s.failNextChat = true;
      closeModal();
      go("chat");
      toast("Demo: George’s next reply will fail, with a retry option.");
      break;
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
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
      photoError =
        "Choose an image under 8 MB. This doesn’t count as a failed check.";
      photoDialog(photoTask);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      photo = reader.result;
      photoError = "";
      photoDialog(photoTask);
    };
    reader.onerror = () => {
      photoError =
        "That image couldn’t be opened. Please try another. No attempt was counted.";
      photoDialog(photoTask);
    };
    reader.readAsDataURL(file);
  }
});
document.addEventListener("input", (e) => {
  if (e.target.name === "message") chatDraft = e.target.value;
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
        },
      ];
      go("calendar");
      break;
    }
    case "task": {
      const data = { ...values, photo: f.has("photo") };
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
      if (taskDraft.kind === "suggestion" || taskDraft.kind === "chat") {
        const source =
          taskDraft.kind === "chat" ? s.chatSuggestions : s.suggestions;
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
        s.profile = { name, phone: activePhone };
        persistAccount();
        if (storageFailed) { fail("Your profile couldn’t be saved. Free some device storage and try again."); break; }
        closeModal();
        render();
        toast("Profile updated.");
      }
      break;
    }
    case "chat":
      if (values.message.trim()) respond(values.message.trim());
      break;
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
setupPWA({ beforeUpdate: () => { persistAccount(); return !storageFailed; } });
render();
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
