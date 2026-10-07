# TalkSpace Project State

> AI-readable project snapshot. Read this file first, then read `TALKSPACE_PROJECT_CONTEXT.md`. This snapshot describes repository state and records historical/live claims with their evidence status rather than treating them as fresh verification.

## 1. Project Identity

- **Name:** TalkSpace
- **Local project path:** `C:/Users/manow/Downloads/Final-TalkSpace-fixed/talkspace`
- **Local development URL:** `http://localhost:5500/`
- **Purpose:** A private, one-to-one messaging application intended to feel familiar to users of modern messaging apps while protecting chat and call access through friendship, block, and presence checks.
- **Architecture:** Static HTML/CSS/browser JavaScript. There is no framework bundle, package manifest, or package-script runner. `src/app.js` owns most application/auth/messaging/presence behavior; `src/call.js` owns WebRTC; `src/settings.js` owns the standalone Settings page.
- **Technologies:** HTML, CSS, JavaScript, Supabase Auth/Postgres/Realtime, email OTP, Cloudflare Turnstile, WebRTC voice/video, and a network-only service worker/PWA manifest. Brevo SMTP is part of the supplied deployment context as the email delivery service; SMTP configuration is external to this repository and was not inspected or verified for this handoff.

## 2. Product Goal

TalkSpace is intended to provide private one-to-one communication: verified accounts, friend relationships, blocking, messages with delivered/seen state, unread counts, online presence, and voice/video calls. The governing product rule is that uncertainty must not grant access: chat/calls require the applicable friendship, block, and presence checks, and offline or unverified peers must not expose private conversation history or previews.

## 3. Current Development Status

Core engineering work is substantially complete. The current work has moved into visual polish, with real-browser/account release verification still pending.

- **Stage 1 — UI Design Foundation: COMPLETE.** Implemented primarily in `src/style.css`.
- **Stage 2 — App Shell + Navigation: NEXT.** Not yet implemented at the time of this snapshot. The current 65px top bar, approximately 280px desktop sidebar, navigation grouping, active navigation treatment, and chat-header organization have not received the planned Stage 2 pass.
- Do not start Stage 3 or redesign later surfaces as part of Stage 2.

## 4. Completed Features

### Authentication and account lifecycle

- Email OTP signup, followed by username/password and profile setup; password login uses Supabase Auth.
- Signup and login have separate Turnstile widgets and tokens. Turnstile waiting is bounded/cancellable, each widget has independent lifecycle state, callbacks are generation-checked, and expired/error tokens are cleared.
- Email validation and duplicate-submit/in-flight guards are implemented for auth operations.
- OTP verification, login, account setup, startup session restoration, profile loading, auth identity switches, and external sign-out/session changes use generation/context protections so old async work cannot restore the wrong UI or identity.
- Profile-read retry UX exists. Signed-out cleanup clears private UI/state, invalidates work, stops timers and channels, and invokes call cleanup.

### Friend requests and relationships

- Friendship is derived from directional `friend_requests` rows; there is no separate friendship table in the current frontend model.
- UI relationship states include Send Friend Request, Request Sent, Request Received, Remove Friend, checking, and unavailable/unknown states.
- A single authenticated Realtime channel handles relevant friend-request changes. Friend request lifecycle tests use mocked clients/static wiring and pass in the current suite.
- Chat and calls require an accepted friendship.

**Unresolved live-data-dependent edge case:** after accepted friendship removal, reactivating an outgoing request has shown a duplicate-key `23505` in one path and a constrained UPDATE returning zero rows in another. The exact cause is unknown; filter mismatch, concurrency, or RLS behavior are possibilities, not established findings. The lifecycle implementation checks affected-row results and refreshes visible state. Mocked tests pass, but only real Supabase/browser verification can resolve the live cause.

### Blocking and privacy gates

- The code distinguishes “I blocked this user” from “this user blocked me.” Only the blocker can remove their block.
- Block checks combine the current-user-owned block query and the existing peer-block check. Unknown/error state fails closed; it must not permit a chat, call, or conversation operation.
- Blocking prevents messaging and calls and is refreshed through the existing Realtime path.
- Private chat access requires accepted friendship and the applicable confirmed-online state. Block, friendship, or presence uncertainty clears/replaces private UI and disables relevant actions.
- Offline or unverified peer history/previews are private. The composer/send controls remain disabled and calls are denied. History is not opened/queried when the initial privacy gates fail.

### Messaging, delivery/seen, and unread counts

- Message content uses `messages.body`.
- Message sending has duplicate/in-flight and selected-user/conversation/session guards. Editing, deletion, selection, and clear-chat operations also preserve current-context checks.
- Delivery/seen state is stored in `message_status`; UI ticks represent delivered (`✓`) and seen (`✓✓`) state. Seen handling follows delivery processing and stale conversation guards.
- Per-user deletion uses `message_deleted_for`; delete-for-everyone and clear-chat have separate existing semantics.
- Unread display comes from `conversation_unread`. The frontend does not increment counts using read-modify-write. The recorded architecture uses a database INSERT trigger to increment recipient unread counts and a seen-status trigger to decrement when `seen_at` first becomes non-null. Realtime refreshes displayed counts; it does not increment them.
- **Evidence distinction:** historical project notes report testing one message, rapid multiple messages, and two sessions of the same account. Those are historical/live verification claims, not tests performed for this handoff and not established by the current checked-in mocked tests. The database trigger architecture is described by `AGENTS.md`; no SQL or live database was inspected for this snapshot.

### Friend previews and presence

- One shared `presence` row per user is refreshed by an approximately 20-second heartbeat. Online freshness is less than 45 seconds based on `last_seen`.
- A single local expiry timer covers tracked friends. Stale non-selected friends are treated as offline and their message previews are replaced with the existing private offline presentation; asynchronous preview results revalidate freshness/revision before rendering.
- Selected presence refresh captures user, peer, selection generation, and conversation context. Newer Realtime revisions take precedence over older SELECT results; stale selection/logout results are ignored and unknown/error states fail closed.
- Logout and `beforeunload` do not force the shared row offline. One browser tab cannot know whether another active session exists.
- **Known limitation:** the shared row has no per-session identity/server aggregation. It cannot perfectly aggregate multiple browsers/devices; one continuing session can keep the account online, and after the final heartbeat ends, stale online state can take up to about 45 seconds to be inferred offline.

### Voice/video calls

- Voice call lifecycle is implemented; the UI and offer handling also support video-call groundwork and video tracks.
- Friendship, block, online status, identity, and generation are checked at critical call stages. Incoming offers are validated before display/acceptance; answer/candidate/hangup/reject/timeout signals are checked against the expected peer/session.
- There is one call-signaling Realtime channel. Logout/call cleanup invalidates and removes it; login/startup restarts through the existing call lifecycle.
- Logout ends/cleans active or ringing calls, peer connections, media tracks, timers, pending ICE, and local call UI/state.
- Incoming calls have a viewport-centered dialog with caller name, voice/video indication, Accept and Reject. Active calls show peer, type, status, connected duration, Mute, and Hang Up. Duration follows the current connection/call generation.
- Rejected/missed/ended feedback uses a shared auto-hiding toast. Call layouts include safe-area/narrow-screen treatment and long-name wrapping.
- **Important limitation:** `src/call.js` configures STUN only. TURN is not configured. Do not claim reliable calls across restrictive NAT/firewall environments.

### Mobile, Settings, Privacy

- Mobile chat navigation hides the sidebar during a selected chat and provides Back to Friends. Friends, Requests, Blocked, Profile, Settings, and Privacy routes exist. The layout uses the 700px breakpoint and dynamic viewport heights; mobile controls have touch-friendly minimums.
- Settings loads and saves the authenticated profile display name, avoids unchanged writes, blocks duplicate saves, exposes loading/success/error messages, guards session changes, and broadcasts successful display-name changes to already-open app tabs. Bio is disabled and unsupported by the current profile contract.
- Privacy is a factual policy page describing current friendship/block/offline protections and does not present unsupported privacy toggles.
- Actual device and browser rendering still need validation.

### Service worker / PWA

- `index.html` registers the single `sw.js` worker in production with `updateViaCache: "none"` and requests an update on app load. The browser's normal waiting lifecycle is preserved; the code does not use `skipWaiting()` or `clients.claim()`.
- The worker is network-only for same-origin GET app resources; it bypasses browser/CacheStorage caching and does not supply an offline shell. Legacy `talkspace-*` caches are removed during activation.
- Localhost unregisters the app-scope worker and deletes legacy TalkSpace caches. Manifest and 192px/512px icons are present.

### Logging

- Routine diagnostics are off by default and enabled with `?talkspaceDebug=1`. The opt-in logger uses `console.debug`; failures/warnings remain visible through normal error/warning channels.
- Routine logging is designed to omit credentials, auth/session objects, message bodies, peer identifiers, and call signal payloads. Preserve this privacy boundary when editing diagnostics.

### Major race protections

Keep the existing auth identity/session generations, OTP/login/account-setup invalidators, Turnstile callback generations, profile retry/load generations, selected friend/conversation generations, message/history load checks, send/clear guards, typing context, presence revision/freshness checks, external-session-loss cleanup, call session generation, and Realtime channel lifecycle. These checks prevent late work from crossing users, peers, chats, widgets, or calls.

## 5. Test Status

Current repository inventory: 18 `tests/*.test.js` files using Node's built-in test runner; no `package.json` is present.

Latest known results:

- Full suite after Stage 1: **153 passed, 0 failed** in one run.
- Full suite was previously reported as **153 passed, 0 failed in three consecutive runs** during the presence/privacy regression work. Do not imply three runs occurred after the later Stage 1 edit unless rerun.
- Focused call UI/mobile/settings/privacy suite after Stage 1: **19 passed, 0 failed**.
- Presence-preview/presence-lifecycle/privacy/friend-request focused suite during presence work: **41 passed, 0 failed**.
- JavaScript syntax check after Stage 1: **25 files passed, 0 errors**.
- Historical project notes report service-worker tests at 40/40 over three runs, plus repeated auth-hardening, logger/call/mobile/settings/privacy, and call UI runs. These are historical recorded results, not newly run for this file creation.

Automated tests are mocked/static as applicable. They do not prove live Supabase, production RLS, SMTP delivery, device behavior, or complete real-browser behavior.

## 6. Real Browser / Live Supabase Verification

Final two-account A+B browser regression is intentionally postponed. The current known browser-control environment can inspect browser tabs/accessibility trees but cannot supply the DOM geometry needed for coordinate input; no suitable Chrome CDP/Playwright connection to both existing Chrome profiles was available in the earlier capability audit. Do not repeatedly retry the blocked click or work around it by changing the app.

Still pending for final release: end-to-end messaging, friend-request lifecycle including the unresolved reactivation edge, blocking, final presence/offline privacy, unread behavior, multi-session behavior, calls/device behavior, mobile visual behavior, Settings visual flow, and service-worker behavior. Perform real Supabase/account testing only in the authorized safe QA setup when supported browser control is available. This handoff creation performed no live tests.

## 7. Known Limitations / Risks

1. STUN-only WebRTC; TURN is not configured.
2. Presence is one shared row per user, not per-device/session aggregation.
3. Stale presence can take up to about 45 seconds after the final heartbeat to be inferred offline.
4. Friend removal/reactivation has unresolved live-data-dependent behavior.
5. The real A+B browser regression is pending due to automation geometry/connection limits.
6. Real mobile/device, keyboard, contrast, focus, and screen-reader verification is pending.
7. Mocked/static tests cannot prove live Supabase policy, trigger, or concurrency behavior.
8. Root Git metadata was not available at the time these handoff files were created (`git rev-parse` reported this path is not a Git repository). No clean/dirty Git status can therefore be claimed; inspect if repository metadata is restored.
9. `supabase/schema.sql` is historical/incomplete and must not be blindly executed. `supabase/unread_count_fix.sql` is migration history and must not be casually rerun.

## 8. Current UI Design Phase

### Stage 1 — UI Design Foundation — COMPLETE

Implemented in `src/style.css`: a compact evergreen token set for surfaces, semantic colors, spacing, typography, radii, and elevation; a system font stack; shared primary/neutral/destructive button treatments and hover/active/disabled states; input/placeholder/focus/invalid/disabled styles; shared focus-visible treatment; surface/status color reuse; subtle transitions; and reduced-motion handling. The Stage 1 implementation changed CSS only; no behavior/config changes were intended. Full suite and syntax checks passed after the change as listed above.

### Stage 2 — App Shell + Navigation — NEXT

Focused goals: refine desktop app proportions, sidebar/navigation grouping, active navigation presentation where existing UI state allows, search hierarchy, chat-header spacing/crowding, empty-state/content hierarchy, and surface separation while preserving mobile safety and accessibility. Keep this a presentation task. Do not change message/auth/call/privacy logic or jump into list/chat/call redesign stages.

## 9. UI Audit Findings

- The calm dark-evergreen product identity is already coherent; Stage 1 makes shared tokens and controls more consistent.
- Desktop shell remains a 65px top bar and approximately 280px sidebar.
- Friends/Requests/Blocked/Profile navigation needs clearer grouping and active-state treatment.
- Dynamic people/request/blocked rows need later dedicated visual refinement.
- Chat header can feel crowded near the 700px breakpoint.
- Empty states remain mostly plain text; unread badges and selected conversation could be more distinct.
- Call overlays have a stronger established hierarchy than dynamic lists; the phone emoji is a later optional icon polish item.
- Mobile structure exists, but real browser/device, focus, keyboard, contrast, and screen-reader checks remain pending.

## 10. Future UI Stages

1. Stage 1 — UI Design Foundation — **COMPLETE**
2. Stage 2 — App Shell + Navigation — **NEXT**
3. Stage 3 — People Lists / Panels
4. Stage 4 — Chat Hierarchy / States / Message Presentation
5. Stage 5 — Calls Visual Refinement
6. Stage 6 — Mobile + Standalone Pages
7. Stage 7 — Consistency + Accessibility + Final Polish

## 11. Important Development Rules

- No speculative refactors or feature changes during visual-only stages.
- Do not alter Supabase schema, RLS, triggers, migrations, data, or configuration without explicit authorization and current review.
- Never execute historical `supabase/schema.sql` as setup. Preserve the verified app contract (`blocked_users`, directional `friend_requests`, `conversations.user_one/user_two`, current message/status/unread tables).
- Preserve privacy checks and fail-closed behavior for friendship, block, and presence.
- Preserve all generation/session/revision checks and single-channel Realtime lifecycle.
- Preserve 45-second presence freshness and shared-row semantics unless presence redesign is expressly requested.
- Do not add logout/`beforeunload` writes that force the shared presence row offline.
- Do not expose credentials, personal account identifiers, OTPs, tokens, message contents, or private signaling data in docs/logs.
- Do not repeatedly attempt the unavailable browser automation path or claim live verification without actually completing it.
- Keep UI stages separated. Stage 2 is next; do not silently start Stage 3 or later.
- Inspect current files/tests and the available Git/file state before every task; this repository path had no Git metadata during handoff creation.

## 12. Recommended Next Action

**NEXT ACTION: Start Stage 2 — App Shell + Navigation.**

Use a focused UI-only task after reading both handoff files. Do not combine it with people lists, chat presentation, call redesign, or standalone page redesign.

## 13. Handoff Instructions for Another AI

1. Read `TALKSPACE_PROJECT_STATE.md` first.
2. Read `TALKSPACE_PROJECT_CONTEXT.md` second.
3. Inspect the actual repository and current tests before making changes; do not treat this snapshot as fresher than the code.
4. Check Git/file state if available; this handoff was created at a path without `.git` metadata.
5. Determine whether the requested behavior is already implemented and avoid repeating solved work.
6. Preserve privacy, race, session, and Realtime safeguards.
7. For UI work, honor the current stage and avoid mixing later stages into it.
8. Ask only when a decision truly requires user input; otherwise make the smallest safe choice.
9. After implementation, report files changed, behavior impact, exact tests/results, unverified items, and whether any live/browser verification occurred.
