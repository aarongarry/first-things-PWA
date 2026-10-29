# First Things

First Things is a PWA for the IS-401 Project Management course. Plan goals, finish daily tasks, and earn simulated breaks with George.

**Open the app:** https://aarongarry.github.io/first-things-PWA/

## Install on iPhone

1. Open the link in **Safari** and tap **Install First Things** for the guide.
2. Tap **Share → Add to Home Screen**. Share may be inside Safari’s page menu.
3. Leave **Open as Web App** enabled if shown, then tap **Add**.
4. Open the new Home Screen icon while online once. Enter the same phone number to load your account. Let the app finish syncing before going offline.

On Android, open the link in Chrome and tap **Install First Things**. If the browser does not offer the install prompt, use **⋮ → Install app / Add to Home screen**. No app-store account or custom domain is needed.

## Phone accounts and offline use

- Enter a phone number to create or open a **demo account**. No SMS or verification code is used. A name is optional; returning accounts keep their saved name.
- US/Canadian 10-digit numbers normalize to `+1`. For other countries include the country code. Punctuation and spaces do not create separate accounts.
- **Anyone who knows the number can open and edit that demo account.** Use sample numbers and non-sensitive tasks. This is deliberately not production authentication.
- Tasks, goals, preferences, onboarding, and progress save immediately to this device. You can add, edit, delete, and complete tasks offline, including after closing and reopening the installed app.
- Changes sync when connectivity returns **while the app is open**, and when you reopen/focus it. iOS does not guarantee background sync after the app is closed. Other devices refresh on focus or every 30 seconds while visible.
- First use on a new device needs internet to load an existing cloud account. An uncached number used offline can start locally and merge when connected.
- Signing out keeps local accounts and pending edits. Clearing website data/removing app storage can erase changes that have not synced.
- Independent task additions and field edits merge. For the same field, the device syncing its pending edit last wins. Deleting an item wins over a stale edit to it. Server revisions prevent a stale full snapshot from silently overwriting newer data.
- The top status shows **All changes synced**, **Offline**, or a retryable problem. A local-storage failure is shown separately; keep the app open if that occurs.
- App updates download a complete new shell and offer **New version ready**. Tapping it saves local changes before reloading. Account data is separate from the app cache.

## What is real and what is simulated

**Real:** Home Screen installation, phone-number account lookup, persistent goals/tasks, offline editing, reconnect sync, and responsive mobile layout.

**Simulated:** app blocking, George AI, calendar connection, photo verification, and lock-screen notifications. A PWA cannot block other iPhone apps.

## Development

The frontend is plain HTML/CSS/JavaScript in `docs/`, with no build step or runtime package dependencies.

```sh
npm start
# http://localhost:4173
npm test
```

You can also run `python3 -m http.server 4173 --directory docs`. The macOS `Start First Things.command` uses this same folder. Service workers work on localhost or HTTPS; opening an HTML file directly does not enable offline use. A plain HTTP LAN URL on a phone is not sufficient for service-worker testing.

When editing locally, an installed service worker may keep serving the previous release. Close all app tabs or accept the update banner. **Bump the cache version in `docs/sw.js` whenever any cached frontend file changes**, then reload to install and accept the new version.

## Supabase setup

The project URL and browser-safe publishable key are in `docs/supabase-config.js`. Keep service-role/secret keys out of frontend code.

Run **`supabase/pwa-demo-accounts.sql`** once in the project's SQL Editor. It is repeatable and creates a separate `first_things_demo_accounts` snapshot table and two RPC functions. Table access is blocked; the intentionally unverified demo API looks up one supplied phone number. Writes use a revision check and transaction lock. No anonymous-auth setting or external SDK is required for the new PWA.

`supabase/setup.sql` and the original user/goal/task/daily ERD remain available for the earlier authenticated vertical slice. The migration does not alter or expose those records. When an old browser login and its still-valid anonymous session are present, the app imports those tasks into that remembered phone account once. An expired old session or a different browser may require a manual team-assisted transfer; old records remain in the original tables.

Set `USE_SUPABASE` to `false` for device-only persistence without cloud syncing.

## Publish

GitHub repository **Settings → Pages → Deploy from a branch → main → /docs**. HTTPS is required. This repository is configured to publish that folder automatically when `main` changes. Relative manifest URLs and the service-worker scope support the `/first-things-PWA/` subpath.

## Verification

`npm test` covers task behavior, legacy session/sync behavior, phone normalization, durable offline edits, reconnect, account isolation, two-device merge/deletion conflicts, concurrent saves, storage failure, and service-worker caching at a repository subpath.

For a device smoke test:

1. Install in Safari, enter a sample number, finish setup, and add a task. Wait for **All changes synced**.
2. Turn on airplane mode, add another task and complete one. Close and reopen the app; both edits should remain.
3. Reconnect with the app open. Wait for **All changes synced**.
4. Open the website on a second device, use the same number, and verify the tasks and completion state.
5. Sign out and use a different number; its task list should be separate.

![Original First Things ERD](docs/erd.png)
