# TalkSpace — Permanent Project Handoff

This document is for a future AI assistant or Codex agent continuing work on the current TalkSpace repository. It describes the checked-in application, current local changes, verified test results, and owner-reported real-device results. Treat current source and tests as authoritative over older status snapshots. Where this document cannot establish a live or production fact, it labels that fact as **owner-reported** or **Not verified**.

## 1. Project overview

**TalkSpace** is a browser-based private, one-to-one messaging application. Its goal is to provide familiar modern-messenger behavior—accounts, friends, private chat, presence, delivery/seen state, and voice/video calls—while enforcing friendship, block, authentication, and presence restrictions.

The app is built as static HTML, CSS, and browser JavaScript. It uses Supabase Auth, Postgres, and Realtime; Cloudflare Turnstile for signup/login CAPTCHA; and WebRTC for calls. There is no frontend framework build and no `package.json`. Node's built-in test runner runs the regression suite.

Local development serves the repository root, commonly at `http://localhost:5500/` with Python's HTTP server or an equivalent static server. Production is reported at [https://talkspace-app.netlify.app/](https://talkspace-app.netlify.app/), hosted on Netlify and associated with the GitHub repository. The Git remote and branch are confirmed locally; the active Netlify deployment configuration and automatic-deploy settings are **Not verified** from this repository.

The deployment uses a low-cost/static-hosting approach and managed services. Exact current account plans and costs are **Not verified**. The frontend contains only public browser configuration. Never place private credentials or service-role keys in this repository.

## 2. Current architecture

The app is a small static web application with a deliberately centralized main controller. Reuse the existing modules and checks; do not introduce a framework or duplicate lifecycle systems as part of a focused change.

| Area | Files and responsibility |
|---|---|
| Main app shell | `index.html` contains authentication screens, dashboard/navigation, account popover, relationship panels, chat, call controls, incoming-call UI, and the video/audio elements. It loads the application scripts in dependency order. |
| Main application | `src/app.js` owns most client state and behavior: authentication/session restoration, profile loading, SPA navigation, friends/requests/blocked lists, friendship/block permission checks, conversation and message operations, presence, typing, unread UI, and the single authenticated app Realtime channel. It is a large browser-script monolith. |
| Calling | `src/call.js` owns voice/video media acquisition, peer connections, call UI, signaling writes and Realtime handling, ICE staging, permissions, timers, and centralized call cleanup. Treat it as concurrency-sensitive. |
| Friend relationships | `src/friend-request-lifecycle.js` classifies directional request rows and performs send/reactivate/accept/reject/remove operations. Lifecycle mutations use `talkspace_friend_request_transition_v1` for the narrow RPC operations where required. |
| Turnstile lifecycle | `src/turnstile-lifecycle.js` provides bounded/cancellable waiting for the Cloudflare Turnstile API. `src/app.js` owns the signup/login widget state, callbacks, tokens, and provider requests. |
| Settings | `setting.html` is the standalone Settings page. `src/settings.js` provides the shared controller used by the app and standalone page; it loads and saves the supported display name. |
| Privacy | `privacy.html` is a factual policy/information page. It must describe enforced behavior and must not imply unsupported privacy controls exist. |
| Styling | `src/style.css` contains the shared visual system, desktop/mobile layout, navigation, chat, and call surfaces. `index.html` links it. |
| Logging | `src/logger.js` provides opt-in diagnostics. Routine logs are enabled with `?talkspaceDebug=1`; operational warnings/errors remain visible. Keep private content, identifiers, and call payloads out of logs. |
| PWA | `sw.js` is a network-only worker for same-origin GET resources and cleans old TalkSpace caches. `manifest.json` contains install metadata and icon references. `assets/icon-192.png` and `assets/icon-512.png` are the icons. |
| Public configuration | `src/config.js` contains browser-visible Supabase URL/key and Turnstile site key. It is not a place for secrets. `.env.example` documents that public values live in `src/config.js`; the app does not load a server environment file. Do not copy values into this document. |
| Supabase artifacts | `supabase/schema.sql` is historical/incomplete and does not describe the verified current live contract. `supabase/unread_count_fix.sql` and the friend-request RPC review SQL files are migration/review artifacts, not casual setup scripts. |
| Tests | `tests/*.test.js` uses Node's built-in test runner with mocked clients and static wiring checks. It covers auth, account setup, friend lifecycle, blocking, calls, presence, navigation, privacy, Settings, Turnstile, PWA, and related races. It is not a substitute for live-browser or device testing. |
| Project guidance | Read `AGENTS.md`, `README.md`, and this document first. `TALKSPACE_PROJECT_STATE.md`, `TALKSPACE_PROJECT_CONTEXT.md`, and `TALKSPACE_FINAL_HANDOFF.md` contain useful history but include older status/test claims; prefer this document plus current source for present state. |

Messaging does not have a separate messaging module today; its implementation is primarily in `src/app.js`. Avoid duplicating that behavior in new files without an explicitly approved architectural change.

## 3. Authentication

Signup currently requests an email OTP through Supabase Auth, verifies it, then collects username/password and creates/loads the application profile. Login uses email/password through Supabase Auth. The browser uses separate Cloudflare Turnstile widgets/tokens for signup and login; widget callbacks are generation-checked, tokens are single-use, and the code clears/resets token state on error, expiration, or view changes. Email validation, duplicate-submit guards, bounded Turnstile loading, and stale-operation checks are present.

The app restores the existing Supabase session on startup and uses one auth-state listener. Auth/session generations prevent late login, OTP, profile, or account-setup work from restoring an obsolete identity. Identity changes and sign-out clear private app state and stop the current authenticated Realtime and call lifecycle through existing cleanup paths. Preserve the distinction between a real signed-out state and a transient auth/network error.

Brevo SMTP is mentioned in owner-provided deployment context as the email delivery provider. Its current configuration and delivery behavior are external to the repository and **Not verified** here. Do not put SMTP settings or credentials into frontend code or this document.

Security constraints: never add a Supabase service-role key, Turnstile secret, SMTP secret, password, access token, or private credential to frontend code, tests, logs, or documentation. Client-side checks complement, but do not replace, Supabase Auth and RLS.

## 4. Database and Supabase

The following is the current application contract recorded in `AGENTS.md` and repository code. It is not a new live database inspection. Do not infer additional columns or constraints from the historical `supabase/schema.sql`.

| Entity | Current role |
|---|---|
| `profiles` | Public-facing profile data and the supported display name/username fields. Public profile reads avoid exposing email. Exact full live schema is **Not verified** here. |
| `presence` | One shared row per user with `user_id`, `is_online`, and `last_seen` in the verified app contract. |
| `friend_requests` | Directional relationship history using `sender_id`, `receiver_id`, `status`, and `id`. Accepted rows represent friendship; there is no separate friends table in the current frontend model. |
| `blocked_users` | Directional block records. The app distinguishes “I blocked this user” from “they blocked me.” There is no live `blocks` table in the current application contract. |
| `conversations` | Pair conversation lookup/creation uses `id`, `user_one`, `user_two`, and `created_at` in the verified app contract. |
| `messages` | Conversation messages. The app uses `body` and soft-delete/edit/clear metadata, including `deleted_at`, `edited_at`, and `cleared_for_users`. |
| `message_status` | Delivery and seen status keyed by `message_id`, with `delivered_at` and `seen_at`. |
| `message_deleted_for` | Per-user “Delete for Me” records. |
| `conversation_unread` | Per-user/conversation unread source with `unread_count` and `updated_at`. Database triggers are the intended count mutation mechanism; the frontend displays Realtime refreshes and must not use client-side read/increment/upsert. |
| `call_signals` | WebRTC signals using `caller_id`, `receiver_id`, `signal_type`, `signal_data`, and `created_at`. Per-call correlation is carried inside the JSON `signal_data`; no schema column was added for it. |

`src/app.js` calls the existing `has_user_blocked_me` RPC. `src/friend-request-lifecycle.js` calls `talkspace_friend_request_transition_v1(p_request_id, p_action)` for lifecycle transitions. The review SQL documents a narrowly privileged SECURITY DEFINER executor/identity-accessor architecture. It exists to support valid lifecycle transitions without broadening ordinary receiver-only RLS. Do not weaken the policy or add direct client UPDATE/DELETE as a workaround.

The checked-in `supabase/schema.sql` is explicitly outdated/incomplete relative to the current app/live contract. `supabase/unread_count_fix.sql` is migration history reported as applied to the live project. Do not execute or reapply either as part of routine work. Any SQL, schema, trigger, function, publication, or RLS change needs a deliberate current-contract review and explicit authorization. This document creation did not inspect live database state.

## 5. Security and privacy rules

These are product invariants, not optional UI preferences:

- Authentication is required for private app features.
- Private chat and calling require the applicable accepted-friendship relationship.
- Blocks in either relevant direction deny communication. Only the blocker owns/removes their block.
- Relationship, block, or presence errors/unknown states fail closed. An error is not equivalent to “allowed” or “unblocked.”
- Private history/previews are not exposed when friendship, block, or required online checks fail. Offline chat should replace/clear private content and disable message/call actions according to the existing flow.
- UI gates are defense-in-depth. Preserve RLS and RPC authorization; never broaden policies to make a frontend operation succeed.
- The browser must never contain a service-role key or other server-only secret.
- Do not add TURN servers or change provider/network configuration without explicit approval.
- Do not bypass call permission rechecks, request lifecycle rules, stale-context guards, or cleanup to make a flow appear faster.
- Keep diagnostic output free of message bodies, private profile data, credentials, and signaling payloads.

## 6. Friend system

Friendship is derived from directional `friend_requests` rows; row direction and history matter. The lifecycle module classifies both directions as incoming/outgoing pending or rejected and accepted. The UI can show send, sent/pending, received, remove, checking, or unavailable states.

Current lifecycle:

1. With no applicable row, send inserts one directional pending request.
2. An outgoing pending or incoming pending row prevents a duplicate request.
3. The receiver accepts or rejects the incoming row through the lifecycle RPC.
4. Removing an accepted relationship transitions the accepted row to rejected through the RPC.
5. Re-requesting after a rejected outgoing request reactivates that same directional row through the RPC; it must not blindly insert a duplicate because the live system previously returned a unique-key violation.
6. Realtime relationship changes refresh the appropriate views through the existing single authenticated app channel and session/selection guards.
7. Blocking is a separate directional `blocked_users` relation, not a friend-request status.

The current RPC name confirmed in frontend code is `talkspace_friend_request_transition_v1`; actions in the reviewed SQL are `accept`, `reject`, `remove`, and `reactivate`. Current live definition/policy state is **Not verified** during this documentation task. Preserve the narrow SECURITY DEFINER executor architecture and receiver-only ordinary RLS. Do not add direct authenticated lifecycle updates or widen RLS.

An earlier live reactivation attempt showed zero affected rows in one path, while prior history also records a duplicate-key issue. The exact live cause was not established; the current implementation verifies the RPC response and refreshes pair state rather than falsely reporting success. Mock tests do not settle live RLS/data behavior.

## 7. Messaging

Conversations are looked up/created for the user pair. `src/app.js` owns opening chats, sending/loading, editing/deleting, clear-chat, typing, delivery/seen, unread presentation, and the related Realtime handling.

- Messages use `messages.body`; personal deletion uses `message_deleted_for`; delete-for-everyone and clear-chat have their separate existing semantics.
- Send/edit/delete/clear flows guard duplicate submissions and capture user, peer, conversation, and selection generations so late work cannot overwrite a different chat.
- The one authenticated `talkspace-realtime` channel handles relevant message, message-status, unread, typing, friendship, block, and presence events. Preserve its singular lifecycle and context checks.
- Delivery is recorded before seen; UI ticks are `✓` delivered and `✓✓` seen. Do not reorder the trigger-dependent semantics casually.
- Unread count changes are database-trigger-driven. The app listens for current count changes; it must not restore read-modify-write increments in JavaScript.
- Clear Chat is per-user and context-guarded. Do not run it against test/live content without explicit authorization.
- Chat opening was optimized using measured stage logging behind `?talkspaceDebug=1`, parallel reads where safe, and checks that avoid loading private history before access gates. The navigation work makes relationship view shells appear before asynchronous data loads and batches independent profile reads.

Existing fixes cover stale chat selection, identity switching, delivery/seen races, typing context, unread updates, and Realtime refresh. The test suite covers these as mocked/static cases; it does not prove production trigger or RLS behavior.

## 8. Presence

Presence is one shared per-user row, not a per-device lease model. `setOnline()` writes online state and `startPresenceHeartbeat()` refreshes approximately every 20 seconds. Readers consider `last_seen` fresh for less than 45 seconds. Expired/unknown presence must not reveal private history or allow calls.

Logout/tab close do not force the shared row offline because another device/session may still be active. After the final heartbeat stops, a reader may take up to the 45-second freshness window to infer offline. One still-running session can keep the account online. Exact simultaneous multi-device aggregation is not implemented.

The repository contains mocked tests for freshness, expiry, stale async results, and preview privacy. An earlier controlled browser test did not achieve a reliable offline transition; offline privacy was therefore inconclusive in that test. Do not claim that a newly observed real offline transition was verified here. Current source still has the shared-row limitation.

## 9. Calling system — current safeguards

`src/call.js` implements both voice and video calls through a shared call starter. Voice requests audio; video requests audio and video. Incoming UI shows caller/call type with Accept and Reject; active UI presents call status, peer, duration, mute, and hangup. Browser permissions are required.

Before calls proceed, the current paths verify authenticated identity, friendship, block state, and online availability at relevant boundaries. Incoming calls are verified before being presented/accepted. Unknown permission state fails closed. Logout/block changes use existing cleanup and signaling paths.

Current lifecycle details:

- One `RTCPeerConnection` handles each active call; the existing RTC config is STUN-only. TURN is intentionally not configured.
- Offers, answers, candidates, and terminal signals use the existing `call_signals` table/Realtime channel. The JSON `signal_data` envelope includes `session_id` and a `payload`; old signals without an ID fail closed. Both participating clients should use the same current build for calls.
- Outgoing ICE candidates are staged until the offer insert succeeds, then flushed in order. Incoming ICE that arrives before a verified offer finishes its permission checks is staged under the pending offer context, then moved into the existing queue. Candidates are applied only after the matching connection/remote description is ready.
- The 30-second ringing timer remains. The 45-second connection-establishment timer is bounded and cleared after connection or cleanup.
- A definite `failed` peer connection triggers shared cleanup and failure feedback. A `disconnected` state receives a 15-second recovery window; reconnection clears that timer, otherwise the same call instance is cleaned up.
- A synchronous in-memory single-flight guard blocks a second outgoing start while permission/media setup is pending. It is shared by voice and video and released on completion/error.
- The call session ID scopes connection/timer callbacks, signaling, async permission/media work, ICE, and cleanup. A late event from call A must not mutate a later call B, even to the same peer. Missing IDs are ignored.
- `cleanupCall()` is the central cleanup path for connection handlers, peer connection, local/remote media, video/audio elements, timers, staged ICE, call panels, duration, and state. Do not create parallel cleanup systems.
- Incoming accept is guarded against duplicate accept attempts. Preserve block/privacy restrictions and the existing Realtime channel lifecycle.

### Owner-reported real-device result

The owner reports that after the latest lifecycle fix, voice calling worked in both directions and approximately 5–6 repeated video calls in each direction succeeded between a laptop and phone. Audio/video worked, with no recurring false “busy on another call” or “Connecting → Connection lost” failure observed in that final regression. This is a real-device result reported by the owner, not a test performed during this handoff-document task. Automated tests also currently pass (see section 16).

Earlier direction-specific video failures and connection-lifecycle symptoms are historical, resolved reports according to the latest owner test. Do not treat them as current defects without reproducing them on the current build.

## 10. WebRTC and call race-fix history

The current safeguards exist because signaling and browser media operations can complete out of order:

1. **ICE timing:** candidates could arrive before the offer insert/remote description. Caller candidates are now queued until offer insertion; early incoming candidates are scoped to the verified pending offer and promoted into the existing candidate queue.
2. **Stale connection state:** `failed` or prolonged `disconnected` could leave the user/peer connection marked active. The code now uses shared cleanup, with a 15-second disconnected recovery window and the existing 45-second connection-establishment limit.
3. **Overlapping starts:** two rapid clicks could both wait for permissions/media. A synchronous shared starter guard now reserves the attempt before awaits.
4. **Stale signals:** caller/receiver identity alone could allow a delayed signal from a prior call to affect a new call with the same peer. Signals now include a generated per-call session ID in JSON `signal_data`; missing/mismatched IDs are ignored.
5. **Asynchronous callbacks/timers:** permission/media results, offer/answer work, candidates, Realtime callbacks, and timeout callbacks validate their captured call instance before mutating current state.
6. **Central cleanup:** all call failure/end paths use `cleanupCall()` with a session scope where appropriate, so cleanup cannot tear down a replacement call.

Changes to `src/call.js` must be small, evidence-driven, and accompanied by tests for call A/call B races and existing ICE ordering. Do not rewrite negotiation, alter voice behavior, add TURN, or change backend schema to address hypothetical failures. The signal format change is intentionally fail-closed for old clients/signals; update both devices together when testing.

## 11. UI and navigation

The main authenticated shell has Home, Find People, Friends, Friend Requests, and Blocked Users. The SPA includes dedicated views/routes for Profile, Settings, and Privacy & Safety. The top-right circular Account control opens its popover for Profile, Settings, and Privacy & Safety. Logout is a separate red Home-only dashboard action positioned at the bottom-right.

Friends uses the dedicated view/navigation architecture. Friend Requests and Blocked Users use the shared list/view mechanisms. Mobile navigation includes Back behavior; opening a chat from Friends and using chat Back can return to Friends. Chat header controls include voice/video and a friend-request action where appropriate; management actions are grouped into More on narrow layouts. Incoming/active call UI has responsive viewport/safe-area handling.

`index.html` owns the semantic markup and controls; `src/app.js` owns view selection/rendering and handlers; `src/style.css` owns layout/breakpoints. Preserve current privacy checks and view generations when changing navigation. Do not rely on old audit screenshots; inspect the current rendered app for visual acceptance. Automated mobile tests check structure/wiring, not actual device geometry/accessibility.

## 12. Performance and UX work already completed

- Navigation paints destination view shells before loading relationship data; independent profile reads are batched/parallelized where safe. Preserve empty/loading states and fail-closed privacy behavior.
- Chat opening was instrumented and optimized using stage measurements and safe parallel reads. Diagnostics are opt-in with `?talkspaceDebug=1`; there is no verified universal before/after millisecond claim to repeat here.
- Mobile chat layout uses the existing responsive system, dynamic viewport sizing, scrollable message/list areas, reachable controls, compact header actions, and Back navigation.
- Dashboard logout/account placement, dedicated navigation views, account popover, and friend-request chat action have been implemented.
- Loading/retry/empty-state behavior exists for several profile, relationship, Settings, and auth flows.
- Multiple async race fixes cover navigation, profile/session loads, Turnstile callbacks, messages, presence, friend relationships, and calls.

These are descriptions of implementation and tested logic, not a claim that every visual detail was re-audited on every screen size in this task. Do not invent performance numbers; run an actual measurement before making quantitative claims.

## 13. PWA, caches, and stale builds

`index.html` registers one production service worker (`sw.js`) with `updateViaCache: "none"` and requests an update. The worker sends same-origin GET app resources to the network without using the browser/CacheStorage cache, does not provide an offline app shell, and removes obsolete `talkspace-*` caches on activation. It does not forcibly take over a waiting page with `skipWaiting()`/`clients.claim()`. Localhost unregisters the app-scope worker and removes legacy TalkSpace caches to reduce stale local assets.

Earlier visual testing was confused by an older build/tab. Always verify that the current browser URL and visible navigation/build match the intended workspace before visual verification. Refresh/update the worker as appropriate and do not assume an open PWA tab has switched versions during a call. Authenticated features require network access; do not cache private messages or authenticated app data for offline use.

## 14. Cloudflare and Turnstile

Cloudflare Turnstile protects signup and password login through separate site widgets and short-lived tokens. The site key is public browser config; the paired secret is external and must never be documented or placed in frontend files. Cloudflare hostname configuration was updated for the renamed production hostname according to the owner.

- Production hostname: `talkspace-app.netlify.app`.
- Temporary local HTTPS Quick Tunnel hostname reported for recent testing: `screensavers-corrections-reminder-edt.trycloudflare.com`.

The Quick Tunnel hostname is temporary/random and is not production infrastructure or a permanent allowed-origin/configuration target. A new tunnel can have a different hostname. Never add secrets or rely on a temporary tunnel for deployment.

## 15. Local development and device testing

Use the project root as `<project-root>`; do not hard-code a personal machine path into docs or code. From that directory, a simple HTTP server is:

```powershell
python -m http.server 5500
```

Open `http://localhost:5500/` on the laptop. For mobile camera/microphone testing, the phone must access the laptop-hosted page in a secure context. Plain HTTP on a LAN IP is generally not a secure origin for `getUserMedia`; use HTTPS. Owner-reported temporary Quick Tunnel method:

```powershell
cloudflared tunnel --url http://localhost:5500
```

Open the generated HTTPS `trycloudflare.com` URL on the phone and laptop, sign into separate authorized test accounts, and test both directions. Do **not** install a CA certificate on the phone for this Quick Tunnel flow. Stop the temporary server/tunnel with `Ctrl+C` in their respective terminals. Keep the tunnel URL temporary and do not put credentials in command history or documentation.

Real-device behavior is stronger evidence for browser media/network lifecycle than mocked tests. Do not test destructive actions on real accounts without explicit approval.

## 16. Automated test status

The current repository contains **21** `tests/*.test.js` files. The current full suite was run during the latest call-lifecycle work:

```text
node --test tests/*.test.js
179 tests passed, 0 failed
```

The focused call suites include `tests/call-lifecycle.test.js`, `tests/call-ui.test.js`, and `tests/block-call-lifecycle.test.js`; they cover single-flight starts, failure cleanup, disconnected recovery, stale session/timer isolation, correlated voice/video signaling, incoming ICE staging, and call UI/security wiring. Other suites cover account/auth/OTP/Turnstile, friend lifecycle, blocks, presence, privacy, messaging-related navigation, Settings, PWA, and logger behavior. Tests use mocks/static checks and do not prove live Supabase/RLS behavior or device/network WebRTC.

Latest syntax verification during the same call implementation checked **29 JavaScript files** with `node --check`; all passed. `git diff --check` passed. This handoff-document task does not alter application code. Re-run the full suite and checks after future code changes.

There is no `package.json` or npm test script.

## 17. Git and GitHub status

The repository is on branch `master`. Current HEAD is `71442fa` (`Initial TalkSpace release checkpoint`), and local `origin/master` points to the same commit. The configured GitHub remote is `Manowar4775/TalkSpace`. The repository was initialized and the initial checkpoint pushed, as confirmed by history/remote state.

**Current working tree is not clean.** The call-lifecycle changes after the checkpoint are local and uncommitted/unpushed:

- modified: `src/call.js`
- modified: `tests/block-call-lifecycle.test.js`
- modified: `tests/call-ui.test.js`
- untracked: `tests/call-lifecycle.test.js`

Do not commit or push these automatically. Inspect the exact diff and obtain explicit instruction before publishing. This handoff file will itself be a new documentation-only change unless later committed by the owner. No commit or push is made as part of this task.

## 18. Netlify production status

The owner identifies [https://talkspace-app.netlify.app/](https://talkspace-app.netlify.app/) as production. Deployment is reported as GitHub-backed and using `master`; the actual current Netlify project settings and automatic deployment behavior are **Not verified** from repository files. Do not assume every push deploys, and do not deploy without explicit approval.

The “Powered by Netlify” badge was disabled through the Netlify project configuration (General → Powered by Netlify badge) according to the completed owner-approved operation; it was not controlled by TalkSpace source. The current production badge state was not rechecked during this documentation task.

The latest call-lifecycle source/test changes are local and uncommitted, so they are **not in the production build**. Production should be updated only after the owner approves publishing, remaining planned features are complete, and final automated plus real-device regression passes.

## 19. Current release status

**Current:** TalkSpace is a substantially completed application, not a blank project. The local code includes auth, profiles, friendship, blocking, private messaging, delivery/seen, unread handling, presence, responsive navigation, settings/privacy, and voice/video calling.

**Owner-reported real-device status:** messaging and delivery/seen worked; voice calls succeeded both ways; repeated video calls succeeded both directions after the latest lifecycle fix as detailed in section 9. These observations are not recreated by this handoff task.

**Release boundary:** the latest call fix and tests are still local/uncommitted. Production has not been updated with them. Production deployment remains intentionally pending further feature work and final regression approval. A GitHub backup checkpoint exists, but it does not include the current local call changes.

## 20. Known limitations and not-fully-verified items

- Presence is a shared per-user row without exact per-device aggregation; a final offline inference can take up to about 45 seconds. A prior controlled offline browser attempt was inconclusive.
- TURN is not configured. Calls may fail on restrictive NAT/firewall networks despite successful tested device paths.
- Live current schema/RLS/functions were not queried during this handoff. Repository SQL has historical review artifacts; do not treat them as current live proof.
- Real-device call results above are owner-reported. Automated tests are mocked/static; neither proves all browsers/network paths.
- Netlify auto-deploy settings, badge's current visible state, Brevo delivery setup, and live Supabase policy state are **Not verified** during this document task.
- The Quick Tunnel host is temporary, not a stable production/test endpoint.
- Full current visual/accessibility acceptance across all browsers and screen sizes is **Not verified** by this task. Older docs report past browser automation limitations; reproduce only if a current verification request requires it.
- Friend request reactivation had an unresolved live-data-dependent issue in earlier testing; current code fails safely and tests mock the RPC response. Recheck only with authorized live QA evidence.

Resolved historical reports (including the directional video-call issue and stale call cleanup symptoms) are not current known bugs in light of the latest owner-reported regression. Reopen only with a current reproducible failure.

## 21. Future feature backlog — not implemented

These are ideas only. Do not start them without an explicit feature request and appropriate backend/security review.

1. **Delete Account:** permanently delete TalkSpace application data and the Supabase Auth identity. Reusing the same Gmail must not silently restore the old account; the user should be able to register a fresh account/username. This may require a carefully authorized server-side/Edge Function flow. Never expose service-role credentials to the frontend.
2. **Minimize incoming/active call UI:** collapse a call into a floating bar while continuing to chat and restore the call UI later.
3. **Voice messages/notes:** record and send longer spoken messages in chat.
4. **Video-call polish:** address only additional issues demonstrated on current supported devices; the latest repeated two-way test is reported successful.
5. Older project notes also list Google/Gmail sign-in, mobile OTP login, a first-login privacy notice, clearer offline privacy explanation, clearer media-permission waiting feedback, and further mobile/accessibility polish. These remain backlog ideas and are not existing features.

## 22. Current priority and next step

The next phase is not a redevelopment of core features. A future assistant should:

1. Read this handoff and `AGENTS.md`, then inspect current source and existing docs.
2. Check `git status` and review uncommitted changes before editing.
3. Avoid repeating solved investigations unless current evidence shows regression.
4. Work only on explicitly approved future features or reproducible defects; preserve the existing architecture and security checks.
5. Bundle related approved changes where that makes review and regression safer.
6. Run the complete automated suite after code changes and validate critical real-device behavior before release.
7. Do not deploy to Netlify until the feature batch and regression are complete and the owner explicitly authorizes deployment.

## 23. Important “do not break” checklist

- [ ] Do not weaken RLS or replace narrow lifecycle RPC authorization with direct broad writes.
- [ ] Do not expose service-role, Turnstile, SMTP, database, or user credentials.
- [ ] Do not add TURN or change deployment/provider configuration without explicit approval.
- [ ] Do not remove friendship, block, online/presence, or fail-closed privacy checks.
- [ ] Do not casually modify `src/call.js`; preserve session, generation, timer, candidate, and centralized cleanup guards.
- [ ] Do not replace working architecture with an unrequested rewrite or duplicate listeners/cleanup paths.
- [ ] Do not modify SQL/database/RLS without explicit approval and current contract review.
- [ ] Do not deploy or push unfinished work without explicit authorization.
- [ ] Do not assume old bugs are still present; reproduce against the current source/build.
- [ ] Do not repeat investigations already completed without a concrete evidence gap.
- [ ] Prefer focused changes with regression tests and preserve successful voice/video behavior.
- [ ] Do not delete test-account content or perform destructive live actions without approval.

## 24. Useful commands

Run from `<project-root>`:

```powershell
# Full automated suite
node --test tests/*.test.js

# Syntax check the documented core files
node --check src/app.js
node --check src/call.js
node --check src/friend-request-lifecycle.js
node --check tests/friend-request-lifecycle.test.js

# Inspect all JavaScript files (PowerShell)
Get-ChildItem src, tests -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# Repository state/review
git status --short --branch
git diff --check
git diff

# Static local HTTP server
python -m http.server 5500

# Temporary HTTPS Cloudflare Quick Tunnel
cloudflared tunnel --url http://localhost:5500
```

Stop each foreground server/tunnel with `Ctrl+C`. The Quick Tunnel hostname changes and should not be written into permanent app config. Never paste secrets into commands or their output.

## 25. Handoff summary — for a new AI starting here

Read this file first, then `AGENTS.md` and the existing project documentation. Inspect the current `git status` before making changes. TalkSpace is already a substantially completed messaging application with carefully guarded auth, privacy, friend lifecycle, messaging, presence, and WebRTC behavior. Do not rebuild completed features or act on assumptions from an old conversation. Start from the current code and tests; clearly separate what is verified, owner-reported, and **Not verified**. Ask for explicit authorization before backend/security/database or deployment changes, and do not commit or push without instruction.
