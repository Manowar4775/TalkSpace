# TalkSpace — Agent and Maintainer Guide

This file describes the repository as it currently exists and records safety constraints for future work. It is not a database migration guide. When code, old documentation, and verified live database information disagree, do not guess: state what is known and verify the authoritative source before changing anything.

## Project overview

TalkSpace is a browser-based social messaging application. Its current user-facing features include Supabase email/password authentication with email OTP signup verification, Cloudflare Turnstile, profiles, display-name settings, directional friend requests, blocking, online-only private chat, message delivery/seen ticks, unread badges, typing broadcasts, presence, and WebRTC voice/video calls. It is a static HTML/CSS/JavaScript project rather than a bundled framework application.

Technology and runtime:

- Browser JavaScript, HTML, and CSS; Supabase Auth, Postgres, and Realtime; Cloudflare Turnstile; WebRTC.
- `index.html` loads the Supabase JS v2 browser bundle and the local scripts in dependency order. It requires a browser and network access to the configured services.
- `src/config.js` provides browser-visible Supabase and Turnstile public configuration. Never put a Supabase service-role key, private Turnstile secret, password, or token in frontend files.
- A local HTTP server is needed for normal browser testing and service-worker behavior. The repository README suggests VS Code Live Server or `python -m http.server 5500`, then `http://localhost:5500/`.
- No `package.json`, bundler, or package-script test runner is present. Tests use Node's built-in test runner.

## Repository structure

| Path | Responsibility |
| --- | --- |
| `index.html` | Main authenticated app and auth screens; loads external libraries and local scripts, registers the service worker, and contains the app's main DOM. |
| `src/app.js` | Main application state, auth, profiles, friendships, blocking, chat, messages, presence, unread counts, typing, and the authenticated Realtime channel. It is a large browser-script monolith. |
| `src/call.js` | WebRTC voice/video lifecycle, media, call UI, `call_signals` persistence/Realtime, permission checks, and call cleanup. |
| `src/logger.js` | Small opt-in browser diagnostics helper; routine diagnostics are disabled unless `?talkspaceDebug=1` is added to the URL. |
| `src/friend-request-lifecycle.js` | Shared friend relationship classification and lifecycle operations; exposed to browser code and CommonJS tests. |
| `src/config.js` | Public browser configuration for Supabase and Turnstile. Do not copy its values into docs, logs, or generated artifacts. |
| `src/style.css` | Main application styling, including a mobile breakpoint at 700px. |
| `tests/friend-request-lifecycle.test.js` | Node built-in automated tests for friend request lifecycle behavior and selected app wiring. These tests use a mocked client/static source checks; they do not contact the live database. |
| `supabase/schema.sql` | Checked-in historical/incomplete schema SQL. It is not a reliable representation of the current live database; see the warning below. |
| `supabase/unread_count_fix.sql` | Local SQL migration/history for trigger-based unread counts. It was reported successfully applied to the live project. Do not rerun it casually. |
| `sw.js` | Network-only service worker for same-origin GET requests. It removes legacy TalkSpace CacheStorage entries during activation and does not provide an offline shell. |
| `manifest.json` | PWA name, start URL, display mode, theme/background colors, and icon paths. |
| `setting.html` | Settings page markup; `src/settings.js` loads the signed-in profile and persists the supported display name. |
| `privacy.html` | Static privacy-policy page. |
| `README.md` | Older starter/setup documentation. Some database and feature statements are stale; do not follow its schema execution instructions without current verification. |
| `.env.example` | Reminder not to put secrets in a static frontend; notes that public settings are in `src/config.js`. |
| `.gitignore` | Git ignore rules. |
| `assets/` | Static assets, including PWA icons. |

There is no root `package.json`, lockfile, `CONTRIBUTING` file, or existing `AGENTS.md` in this repository at the time this guide was created.

## Supabase architecture and current live contract

The frontend references the tables below. The listed live columns are based on the project owner's prior manual live-database verification, not on treating `supabase/schema.sql` as authoritative. Do not infer unlisted columns from this guide. Live policies were separately reported as manually checked; this guide does not replace a fresh policy audit.

| Table | Application purpose and verified contract details |
| --- | --- |
| `profiles` | Public profile lookup and display. Verified columns: `id`, `username`, `display_name`, `avatar_url`, `created_at`, `updated_at`. The frontend reads/writes profile data in `src/app.js`; call UI also looks up caller display details in `src/call.js`. |
| `presence` | Online/last-seen status. Verified columns: `user_id`, `is_online`, `last_seen`. `src/app.js` updates the current user's status, polls/reads peers, and handles Realtime changes. |
| `blocked_users` | Directional blocks. The frontend uses the current user's blocker/blocked identity to distinguish “I blocked them” from “they blocked me”; it also handles block Realtime. There is no live `blocks` table. Only use columns actually confirmed in the live database/code before changing queries. |
| `friend_requests` | Directional relationship and request history. Verified columns used by the app: `sender_id`, `receiver_id`, `status` (and row `id`). Pending/accepted/rejected states drive requests, friendship, removal, and re-request. There is no separate friends table in the current frontend model. |
| `conversations` | Pair conversation lookup/create. Verified columns: `id`, `user_one`, `user_two`, `created_at`. |
| `messages` | Chat records. Verified columns: `id`, `conversation_id`, `sender_id`, `body`, `created_at`, `deleted_at`, `edited_at`, `cleared_for_users`. The frontend uses `body`; personal deletion is represented separately in `message_deleted_for`. |
| `message_status` | Delivery/seen state. Verified columns: `message_id` (UUID primary key referencing `messages.id`), `delivered_at`, `seen_at`; the live design requires delivered state before seen state. The frontend upserts by `message_id` and reads status for ticks. |
| `message_deleted_for` | Per-user “Delete for Me” records. Verified columns: `message_id`, `user_id`, `deleted_at`. |
| `conversation_unread` | Current unread source and UI badge state. Verified columns: `conversation_id`, `user_id`, `unread_count`, `updated_at`, primary key `(conversation_id,user_id)`. |
| `call_signals` | WebRTC signalling records. Verified columns: `caller_id`, `receiver_id`, `signal_type`, `signal_data`, `created_at`. |

### Live database versus repository SQL — read before any database work

**The checked-in `supabase/schema.sql` is outdated/incomplete compared with the current live Supabase database.** The owner verified that live uses `blocked_users` (not `blocks`), `conversations.user_one/user_two`, and the message/status/deletion/unread tables described above. The old SQL contains incompatible historical names/designs, including `blocks`, `friendships`, and `user1_id/user2_id`-style conversation fields. The local schema file must not be used to infer the live contract or to “synchronize” the live database.

The owner also reported that `supabase/unread_count_fix.sql` has already been successfully applied live. Do not execute it again or recreate its functions/triggers without explicit authorization and a fresh migration review. Before any database change, inspect the current app contract, verify current live schema and RLS when authorized, and propose a focused migration only if expressly requested. Never modify live Supabase as an incidental code task.

## Authentication and session lifecycle

- Signup requests an email OTP with `signInWithOtp` and the signup Turnstile token, verifies via `verifyOtp`, then collects username/password and creates the profile. Password login uses `signInWithPassword` and passes its Turnstile CAPTCHA token.
- Turnstile widgets/tokens are managed by the signup/login render, success, expiration, error, reset, and removal handlers in `src/app.js`. Tokens are single-use and should not be persisted or logged.
- `loadCurrentUser()` loads the authenticated user/profile before revealing private UI. `initializeApp()` checks the existing session at startup. A single `client.auth.onAuthStateChange` listener synchronizes session changes; `SIGNED_OUT` invokes `cleanupSignedOutState()`.
- `cleanupSignedOutState()` clears user/profile/selection and private DOM state, invalidates stale work, stops timers, removes the main authenticated Realtime channel, and invokes the call logout cleanup. The logout button attempts call cleanup, handles sign-out errors, and then uses the same signed-out cleanup. It does not mark shared presence offline because another session may remain active.
- Preserve the distinction between a verified signed-out session and a transient query/auth error. Do not add another auth listener or competing cleanup implementation.

## Friendship model and lifecycle

Friendship is derived from directional `friend_requests` rows, not a separate friends table. Direction matters: `A → B` and `B → A` are distinct historical rows. `FriendRequestLifecycle.classifyRows()` reads both directions and distinguishes outgoing/incoming pending or rejected from an accepted relationship.

Expected lifecycle behavior:

```text
no directional row → INSERT pending request
outgoing rejected row → UPDATE that same row to pending
outgoing pending → do not duplicate
incoming pending → receiver may accept or reject
accepted row → Remove Friend transitions existing accepted history to rejected
removed/rejected history → request again using the existing direction rules
```

The live database previously returned `23505 duplicate key value violates unique constraint "friend_requests_sender_id_receiver_id_key"`; therefore do not blindly insert when the same directional row already exists. Reverse-direction rows remain distinct and must be considered during classification and UI decisions. The friend list is built from accepted relationship rows; request and action state refresh through the current loaders and the single authenticated `friend_requests` Realtime listener.

**LIVE DIAGNOSTIC STATUS: unresolved / requires authenticated live verification if needed.** A real browser attempt to reactivate a rejected outgoing row returned a zero-row UPDATE result. The exact live cause was not established because the investigating Codex session lacked authenticated database inspection. Do not state that RLS, a status mismatch, or concurrency was proven to be the cause. The lifecycle module now checks the affected-row result and refreshes visible pair state; mocked tests cannot resolve the live cause.

## Chat privacy, friendship, and blocking

Private chat requires an accepted friendship and the applicable confirmed-online presence state. `openUser()` resets old chat contents, checks presence, block direction, and friendship, and only then opens/loads private conversation history. Offline, blocked, unknown, or not-friends states clear/replace prior messages and disable the composer/actions. Stale selection/load generations protect against old asynchronous results painting into a newly selected chat. Treat privacy checks as fail-closed.

Blocking uses `blocked_users`; there is no `blocks` table in the live database. “I blocked this user” and “this user blocked me” are separate states. The own-block query and `has_user_blocked_me` RPC are combined by `getBlockState()`. A query/RPC failure is represented as unknown, not unblocked. Unknown block state must not enable messaging/calling or create/open a conversation. Preserve the existing block/unblock ownership semantics and the one `blocked_users` Realtime subscription.

## Messaging architecture

- `openConversation()` looks up/creates a pair using `user_one` and `user_two`. Message rows use `messages.body`.
- `sendMessage()` captures authenticated user, peer, conversation, text, and selection generation before awaiting; it uses an in-flight guard and checks the captured context around async work. It clears the input only if the value remains the original submission.
- `loadMessages()` loads messages and per-user deletion rows, filters messages hidden for the current user, performs delivery then seen processing, reads status for current-user messages for initial tick rendering, and checks chat/load generations before applying results. Keep offline/privacy guards intact.
- Delivery and seen rows are stored in `message_status`, keyed/upserted by `message_id`. The intended ticks are delivered `✓`, seen `✓✓`; do not change status semantics or ordering casually.
- Editing keeps message body separate from visual labels and updates `edited_at`. Delete for everyone uses the message's soft-delete state; Delete for Me uses `message_deleted_for`; Clear Chat uses its existing guarded per-user clearing flow. Preserve stale chat/user checks in each operation.
- Typing uses the authenticated channel broadcast and captures the original conversation context for the delayed stop event.
- Selection state is reset when changing chats; send, edit, delete, and clear operations have stale-context/concurrency safeguards. Search existing handlers before adding any.

## Unread-count architecture — protected decision

Unread counts are database-trigger-driven, not frontend read-modify-write increments. The installed migration makes message INSERT increment the recipient's `conversation_unread` row atomically, and message delivery/seen processing drives the corresponding seen decrement through database triggers. The frontend must not restore the old SELECT → increment → upsert pattern. `conversation_unread` is the displayed unread source; its Realtime subscription refreshes UI/badges and does not increment the database count. Opening a conversation uses `loadOpenedConversationAndClearUnread()` after current-chat messages/seen handling and validates user, selection, conversation, and generation before clearing.

Do not casually alter this trigger architecture, ordering, or unread-clear guards. Require a concrete issue, focused regression tests, and explicit authorization before database work.

## Presence

`presence` has one status row keyed by `user_id` in the verified application contract. `setOnline()` upserts the current user as online and `startPresenceHeartbeat()` refreshes it about every 20 seconds. Presence readers consider a row online only while its `last_seen` heartbeat is less than 45 seconds old. Logout and tab close do not mark the shared row offline, because an individual tab cannot know whether another browser/device session remains active; after the last heartbeat, readers infer offline when the freshness window expires. Peer presence is read by chat opening, friend previews, and call availability; the Realtime presence-table handler refreshes relevant visible state. Private chat and calls must rely on confirmed current online state as required by their existing flows.

Known architectural limitation: the current single row has no per-session identity or server-side lease aggregation, so it cannot report exact multi-session presence or retire one session atomically. Freshness prevents indefinitely stale online status, and avoiding per-tab offline writes prevents one tab from explicitly taking another session offline, but actual multi-session aggregation requires an authorized database/server presence design. Do not make presence schema/architecture changes without authorization.

## Realtime architecture

- `src/app.js:startRealtime()` owns one authenticated channel named `talkspace-realtime`. It handles typing broadcast and database changes including `friend_requests`, `messages`, message edits, `message_status`, `conversation_unread`, `blocked_users`, and `presence`.
- Friend-request Realtime resolves the affected peer, ignores rows unrelated to the current user, refreshes relevant request/friend UI through existing loaders, guards session/generation, and is designed to preserve the selected chat.
- Message INSERT handling updates the open chat/status flow and UI; it must not manually increment unread counts. Message-status events update tick state; unread Realtime updates badges only.
- `src/call.js:startCallRealtime()` owns one separate channel named `talkspace-call-signals` for `call_signals` INSERT events. It is invalidated/removed during logout and call cleanup.
- Keep subscriptions singular. Reuse channel lifecycle and session checks; never create a second subscription for an already-handled table/event.

## Voice/video calling

`src/call.js` implements WebRTC media/call lifecycle; `startVoiceCall(targetUserId, isVideoCall)` supports audio and optional video tracks. `call_signals` carries offers, answers, ICE candidates, and call termination/rejection/timeout signals. Incoming UI supports answer/reject; busy-call behavior and timeout cleanup are implemented.

Call permission is intentionally strict: peer must be verified online when required, block state must be verified and clear, accepted friendship must exist, and permission/session/peer checks are repeated at critical async boundaries. Incoming offers are discovered before there is an active peer, then validated; subsequent signals must belong to the expected peer/generation. Unknown/error permission results deny the call. Do not weaken these rules.

`cleanupCall()` is the shared cleanup path for peer connection, local/remote media, timers, ICE candidates, and local call UI/state. `stopCallRealtime()` invalidates and removes the signalling channel; `endCallSessionForLogout()` composes the existing call cleanup for logout. Do not add a competing cleanup system.

## Performance architecture

Chat opening has been profiled and optimized based on measurements. Current safeguards include parallel message/deleted-for reads, skipping offline history, avoiding repeated known-peer block checks in delivery processing, and limiting the final status read to current user's rendered messages. The unread clear overlaps the final status read only after successful seen processing and current selection validation. Preserve these correctness gates.

`[TalkSpace Performance]` chat-open measurements remain in `src/app.js`, but are collected and reported only when the opt-in `?talkspaceDebug=1` flag is present. Profile real stages before further optimization; avoid speculative query reordering or status/unread semantic changes.

## Browser diagnostics

Routine lifecycle, auth-success, Realtime, friend-request, and call traces use `src/logger.js` and are disabled by default. To enable them while developing, add `?talkspaceDebug=1` to the local app URL; these traces use `console.debug` and omit message contents, authentication/session objects, peer IDs, and call signal payloads. Operational failures remain on `console.error` or `console.warn` regardless of this flag. Chat-open performance measurements are also collected and reported only when this opt-in flag is present.

## Service worker and PWA

`index.html` registers one `sw.js` registration in production with `updateViaCache: "none"` and requests an update on app load. The worker fetches same-origin GET requests from the network with HTTP caching disabled and does not cache the app shell; authenticated features require a live network connection, so an offline shell would not make the app functional. On activation it removes old CacheStorage entries prefixed `talkspace-`. It does not call `skipWaiting()` or `clients.claim()`, so an already-open tab is not forcibly switched to another app version during a chat or call. Localhost development unregisters the app-scope worker and deletes legacy TalkSpace caches to avoid persistent stale local assets. The manifest continues to provide the standalone install metadata and existing icons.

## Testing and verification

Run the existing automated lifecycle suite:

```text
node --test tests/friend-request-lifecycle.test.js
```

Syntax checks:

```text
node --check src/app.js
node --check src/call.js
node --check src/friend-request-lifecycle.js
node --check tests/friend-request-lifecycle.test.js
```

The lifecycle suite currently has 16 tests and passed three consecutive runs during the latest repository verification for this guide. Its mocked lifecycle tests and static wiring checks do not prove live Supabase behavior. Keep verification claims distinct:

- **Mocked automated tests** verify deterministic code paths against a fake client.
- **Static checks** catch JavaScript syntax errors and some wiring assumptions.
- **Live browser tests** exercise real auth, network, Realtime, and database behavior.
- **Human visual/device acceptance** is needed for layout, accessibility, and actual mobile/desktop interaction.

The application has no test script in `package.json` because no package manifest exists. Use the explicit Node commands above.

## Rules for future AI agents

### Before coding

1. Read this `AGENTS.md` and inspect the relevant current implementation.
2. Inspect existing tests and search for existing functions, event handlers, and subscriptions before adding any.
3. Run relevant tests before changes and understand the architecture involved.
4. Treat current source, tests, and verified live evidence as evidence; old README/schema content can be stale.

### During coding

1. Make the smallest justified change and preserve working behavior.
2. Preserve privacy/security checks, fail-closed behavior, and async/session/selection safeguards.
3. Reuse the current architecture; do not create duplicate helpers, listeners, subscriptions, or cleanup systems.
4. Do not modify the database architecture unless explicitly requested. Never infer live schema from stale SQL.
5. Do not broaden a focused task into unrelated cleanup or refactoring.

### After coding

1. Run relevant tests and syntax checks; rerun tests after any fix.
2. For concurrency-sensitive changes, repeat tests and add a regression case for important lifecycle behavior.
3. Never disable/remove a test just to pass the suite or weaken security/privacy checks to satisfy a test.
4. Inspect the changed files and search for duplicate definitions/handlers/subscriptions.
5. Report exact files/functions changed, commands/results, limitations, and what could not be tested.
6. Never claim live database, browser, or device behavior was verified unless it was actually exercised.

## Architectural decisions that must not be casually changed

- Friendship is represented by directional `friend_requests` rows; there is no separate friends table in the current UI model. Direction and rejected history matter because of the live unique directional constraint.
- Rejected outgoing rows are reactivated in place to avoid a duplicate-key INSERT.
- Chat requires accepted friendship and the applicable confirmed-online state to protect private history.
- Blocks prevent messaging and calls; block direction affects which party sees which state.
- Unknown security/permission checks fail closed; error is not equivalent to unblocked/allowed.
- Unread counts use installed database triggers; frontend Realtime only updates the UI.
- Authenticated and call Realtime subscriptions must remain singular and be cleaned up on sign-out.
- Message sends are guarded against duplicate submissions and stale chat switches.
- Stale async results must not update a newer chat or authenticated session.
- Call permissions require verified friendship and block state and are rechecked at critical boundaries.
- The 16-test friend-request regression suite is part of the repository safety net and must be preserved.

These choices exist to preserve privacy, respect directional request history/uniqueness, avoid unread races, and prevent asynchronous work from crossing chat/session boundaries.

## Instructions for a New AI Coding Agent

1. Read `AGENTS.md`.
2. Inspect the relevant source files and current tests.
3. Run existing tests before changing anything.
4. Determine whether the request touches any protected architecture above.
5. Make a minimal implementation and add/update regression tests.
6. Repeat tests where concurrency or lifecycle races are involved.
7. Run the listed syntax checks.
8. Review the diff and check for duplicate functions, handlers, or Realtime subscriptions.
9. Report exact files/functions changed and exact verification results.
10. Never claim live browser/database behavior was verified unless it was actually tested against that environment.
