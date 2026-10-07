# TalkSpace — Final Project Handoff

> Prepared 7 October 2026 for continuation of the existing TalkSpace project. This document combines current-source inspection with the project owner's recent A+B browser-test report. It is not a fresh independent audit of production Supabase.

## 1. Executive Summary

TalkSpace is a static HTML/CSS/browser-JavaScript private messaging app using Supabase Auth, Postgres, and Realtime, Cloudflare Turnstile, and WebRTC. Its core features include email OTP signup, password login, profiles, directional friend requests, blocking, online-only private chat, delivery/seen status, unread counts, typing, presence, voice/video calls, mobile navigation, and a network-only PWA service worker.

The recent owner-reported A+B regression covered the friendship lifecycle, block/unblock behavior, messaging and Realtime status, unread/typing, voice calls, and video calls. The video flow succeeded after the browser's camera/microphone permission prompt was granted. Proper offline-state and full real-device mobile checks remain outstanding. Do not interpret mocked tests as proof of live database policy or production behavior.

## 2. Current Project Status

- Core product behavior is implemented; current continuation is verification, small UI polish, and release readiness.
- The final A+B regression described below was reported as completed in the recent project conversation. Checked-in `TALKSPACE_PROJECT_STATE.md` and `TALKSPACE_PROJECT_CONTEXT.md` contain earlier status snapshots that still describe that regression as pending. Treat those statements as stale where they conflict with the newer report in this handoff; inspect current source before changing behavior.
- Workspace path: `C:\Users\manow\Downloads\Final-TalkSpace-fixed\talkspace`.
- Local URL: `http://localhost:5500/`.
- There is no `package.json`; tests use Node's built-in test runner.
- Git metadata was not available in earlier inspection of this project directory. Check current repository status before claiming a clean/dirty tree or preparing a release checkpoint.

## 3. Product Goal

Enable private one-to-one communication while requiring verified identity, the correct friendship state, no blocking relationship, and valid presence before exposing chat or call access. Uncertain or failed checks must deny access (fail closed). Private history and previews are part of the privacy boundary, not merely UI decoration.

## 4. Architecture

- Static browser app: `index.html`, `src/*.js`, `src/style.css`, `setting.html`, `privacy.html`.
- `src/app.js` owns most authentication, profiles, friend relationships, blocking, messaging, presence, and app Realtime behavior.
- `src/friend-request-lifecycle.js` owns directional request classification and lifecycle operations.
- `src/call.js` owns call signaling, WebRTC, call state, and call UI lifecycle.
- `src/settings.js` owns the standalone Settings page.
- Supabase provides auth, database, functions/RPCs, and Realtime. The frontend must use only public browser credentials.
- WebRTC uses STUN configuration; a TURN service is not configured in the current source/docs. Calls can be unreliable across restrictive networks.
- Brevo SMTP is part of the operator-provided email-delivery setup; its external configuration has not been inspected here.

## 5. Authentication

- Signup verifies an email OTP, then collects username/password/profile details.
- Login uses email/password.
- Signup and login have independent Cloudflare Turnstile widgets and single-use tokens, expiry/error handling, bounded waiting, and stale-callback protection.
- Auth/session generations protect profile loading, OTP, startup restoration, identity changes, and signed-out cleanup from stale async results.
- Current product flow does not include Google/Gmail login or mobile OTP login; those remain future ideas.
- Do not store credentials, OTPs, tokens, account UUIDs, SMTP secrets, or Turnstile secrets in this handoff or logs.
- Brevo delivery configuration is external and not verified by repository inspection.

## 6. Profiles and Settings

- Profile display names are used throughout people, chat, and call UI.
- Settings supports loading and saving the authenticated user's display name with duplicate-save and session-context guards.
- Bio editing/saving was not fully verified in the recent regression and appeared disabled; follow up against the current profile contract before treating it as a bug or enabling it.
- Recent browser test loaded profile/settings and verified display-name editing. Do not claim bio editing passed.

## 7. Friend Requests and Relationships

- Friendship is derived from directional `friend_requests` rows; there is no separate friendship table in the current frontend model.
- The app reads both directions and distinguishes incoming/outgoing pending and rejected rows, accepted friendship, and no relationship.
- UI states include Send Friend Request, Request Sent, Request Received, Remove Friend, and transient checking/unavailable states.
- New directional requests remain normal INSERTs. Existing rejected outgoing requests are reactivated through the lifecycle RPC. Do not insert a duplicate `(sender_id, receiver_id)` row.
- Relevant friend-request Realtime events refresh relationship state for both sessions; preserve the single authenticated Realtime lifecycle and stale-context checks.
- Recent A+B browser regression reported send, receive, accept, reject, re-request, and relationship restoration working, including Realtime updates.

## 8. Remove Friend Lifecycle — Security Architecture

A real bug existed: the previous frontend directly updated `friend_requests`, while live RLS only permitted the receiver to update. Removing a friend from the sender side returned no changed row and left the relationship accepted.

The final architecture routes lifecycle transitions through:

`public.talkspace_friend_request_transition_v1(text, text)`

It uses the dedicated `talkspace_friend_request_executor` NOLOGIN/NOBYPASSRLS role and the postgres-owned identity accessor `public.talkspace_request_identity_v1()` so the executor does not need direct access to the protected `auth` schema. The live migration/RPC was reported applied. The lifecycle RPC is intended to remain the database authority; frontend checks are convenience and must not be treated as a security boundary.

Current frontend source in `src/friend-request-lifecycle.js` calls the RPC with `p_request_id` and `p_action`. Accept, reject, remove, and reactivate use the actual request row ID. New request creation remains an INSERT. Direct lifecycle UPDATE/DELETE fallbacks must not be restored.

Expected lifecycle authorization:

| Transition | Authorized participant |
|---|---|
| `pending → accepted` | Receiver only |
| `pending → rejected` | Receiver only |
| `rejected → pending` | Original sender only |
| `accepted → rejected` (remove) | Either participant |

The owner reported that live Remove Friend succeeded after the RPC architecture was deployed. Review SQL files in `supabase/` are not proof of live schema state; do not execute historical or review-only SQL. Any future database work requires explicit authorization and a current live-schema review.

## 9. Blocking

- Block ownership is directional: a user may remove their own block, never another user's block.
- The app distinguishes “I blocked this user” from “this user blocked me.” Reads/check failures are unknown and fail closed.
- A historical defect left the already-open peer chat unchanged and let an outgoing call display Calling/Ringing after a block. The reported fix broadcasts block state, verifies it in the receiving session, replaces the chat with a blocked state, clears/hides private content, disables composer and call controls, cleans matching active/pending calls, and rejects/cleans blocked incoming offers.
- Realtime block/unblock handling refreshes selected-peer state. Unblock restores normal behavior only after friendship/presence checks pass.
- The owner reported the block/unblock flows, blocked chat state, blocked call restrictions, and call cleanup passing in A+B regression. Preserve this behavior and fail-closed checks.

## 10. Messaging

- One-to-one private messaging is available only when applicable friendship, block, and presence checks pass.
- Message text is stored/read through `messages.body`.
- The app guards sends against duplicate submissions and stale user/peer/conversation/session state.
- Existing private history is hidden/cleared when access is lost; do not leave an old chat visible behind a blocked/offline state.
- Realtime message delivery and selected-conversation refresh must retain the current auth/peer/conversation generation checks.
- Clear Chat exists. It was deliberately not activated during the final regression to preserve test content.
- The owner reported A→B and B→A message delivery through Realtime with no duplicate messages in the regression. Persistent test messages may remain in the live test accounts; do not delete them without authorization.

## 11. Message Delivery / Seen / Ticks

- `message_status` tracks delivered and seen status.
- Single tick means delivered; double tick means seen.
- Delivery and seen updates are guarded against stale conversation/account context.
- A+B regression reported incoming delivery and seen status updates working, including the visible tick changes.

## 12. Unread Counts

- `conversation_unread` drives unread counts.
- Current documented design uses database-side insert/seen triggers for increment/decrement, while frontend Realtime refreshes displayed counts rather than doing client-side read-modify-write increments.
- Recent A+B regression reported unread behavior passing. This is owner-reported live verification, not a fresh trigger/RLS audit.

## 13. Typing

- Typing state is broadcast through the existing Realtime path and is tied to the current conversation/context.
- Context changes, blur/cleanup, and stale-session guards prevent a delayed typing event from appearing in the wrong chat.
- The owner reported typing behavior passing in the recent regression.

## 14. Presence

- Presence uses one shared row per user with heartbeat about every 20 seconds and a freshness threshold of about 45 seconds.
- Multiple sessions share the same account presence row; this is not per-device aggregation.
- Logout or `beforeunload` intentionally does not force the shared user row offline because another session may still be active.
- Presence reads and preview rendering are guarded by freshness/revision/context checks. Unknown/error state denies private access.

## 15. Offline Privacy

Private history, previews, message composition, and calls depend on the peer being recognized as currently online according to the app's presence rules. If presence is offline, stale, or unknown, private content/actions should be hidden or disabled.

**Status: NOT FULLY LIVE VERIFIED / NEEDS PROPER OFFLINE TEST.** In the recent regression, navigating the second account away for roughly 50 seconds did not make it display Offline. This does not establish that offline privacy is broken; the test did not successfully produce/observe an offline transition. The single shared-row architecture can keep a user online while another session continues heartbeats, and stale state may take up to the freshness window to expire.

## 16. Voice Calls

- Voice call start checks identity, accepted friendship, block status, and peer presence before negotiating.
- Outgoing, incoming, accept, reject, cancel, hangup/end, signaling, media cleanup, timeout, and logout cleanup are implemented in `src/call.js`.
- Incoming offers are validated before they are shown or accepted; unauthorized/blocked/busy calls are rejected/cleaned up.
- The owner reported voice accept/end and reject/caller-cancel passing, and blocked call restrictions passing.
- Voice ring/timeout behavior was **NOT TESTED** in the recent regression.
- Browser microphone permission is required. STUN is configured; TURN is not.

## 17. Video Calls

**Video call core flow works according to the latest observed A+B regression. Do not document video calling as broken.** The initial “nothing happened” observation was explained by an unnoticed browser camera/microphone permission prompt. After permission was granted, video call successfully started and ended normally.

- Video uses the shared call starter with video enabled; it requests `getUserMedia({ audio: true, video: true })`. Voice requests audio only.
- Camera and microphone permission must be granted by the browser.
- Two browser sessions on the same physical laptop may contend for its camera. Prefer testing across a phone and laptop for final confidence.
- Optional UX improvement: show a visible “Requesting camera and microphone permission…” state while the permission request is pending. This is a future polish item, not a confirmed call-core defect.
- The owner reported no relevant console errors in the final regression checks.

## 18. WebRTC and Signaling

- Call signaling uses the authenticated Realtime channel and validates peer/session/generation at call stages.
- Local/remote streams, peer connection, ICE state, timers, pending candidates, and call UI are cleaned up on end, reject, logout, and block detection.
- Current source/docs describe STUN-only configuration. There is no TURN relay. Avoid promising call reliability on every NAT/firewall/network.
- Do not rewrite WebRTC absent a reproduced defect.

## 19. UI / Navigation

- The main UI includes app navigation, friends/requests/blocked views, profile, chat, call surfaces, and incoming-call UI.
- Recent A+B regression exercised relationship and privacy states, request actions, chat, calls, settings/privacy, refresh, and return-to-chat flows.
- **Known minor issue:** the Friends list view displays the heading “Friend Requests.” The markup is in `index.html` around the shared friend-requests panel heading; the Friends navigation handler sets `friendPanelView = "friends"` in `src/app.js` around line 8272 but the shared heading is not updated. Correct the wording in a separate targeted UI task.
- Clear Chat was discovered but intentionally not activated in the regression to avoid deleting existing test content.

## 20. Mobile / Responsive

- Mobile navigation and selected-chat/back-to-friends flow exist; CSS uses responsive breakpoints and touch-oriented controls.
- Mobile-related implementation is not equivalent to full device validation.
- Full real phone/tablet testing, keyboard behavior, viewport/safe-area details, focus, contrast, and screen-reader checks remain outstanding. Make changes only against observed issues.

## 21. Settings / Privacy

- Standalone settings and privacy pages are present.
- Display-name settings load/save was reported working.
- Bio behavior remains unverified/appeared disabled.
- Privacy copy should match enforced behavior. Do not add controls the backend/app cannot enforce.

## 22. PWA / Service Worker

- `sw.js` is network-only for same-origin GET requests and removes legacy TalkSpace caches; it does not provide an offline shell.
- Production registers the worker from `index.html`; localhost cleanup removes the app-scope worker and legacy caches, as documented in the project snapshot.
- Authenticated features require the network. Preserve the worker's no-stale-app behavior and do not introduce an offline cache for private content.

## 23. Security Architecture — DO NOT BREAK

- Never place Supabase service-role credentials, database passwords, JWT secrets, Turnstile secrets, or SMTP secrets in frontend code or this document.
- Browser Supabase access uses public client configuration; RLS remains a required enforcement layer.
- Friendship is required for private messaging/calls; block status denies communication.
- Presence, block, and relationship uncertainty must fail closed.
- Lifecycle transitions stay on the dedicated RPC; keep its executor narrow and keep authorization in the database function/policies.
- Do not restore direct authenticated lifecycle UPDATE/DELETE paths or broadly widen RLS to make the UI work.
- Do not expose `auth.users` or grant the executor broad auth-schema access. Preserve the intended identity-accessor architecture and hardened function settings.
- Frontend gating is defense-in-depth, never a substitute for RLS/RPC authorization.
- Preserve stale-response/session/conversation/call generation safeguards and privacy-safe logging.

## 24. Important Files

| File | Purpose |
|---|---|
| `index.html` | Main app markup, auth screens, navigation, friend/request panel, chat/call controls, video elements, service-worker registration. |
| `src/app.js` | Auth, profile, relationships, blocking, messaging, presence, unread, typing, and app Realtime. |
| `src/friend-request-lifecycle.js` | Directional relationship classification, request creation/reactivation, accept/reject/remove RPC calls, and Realtime refresh planning. |
| `src/call.js` | WebRTC, outgoing/incoming call handling, signaling, block checks, media, and cleanup. |
| `src/settings.js` | Standalone display-name Settings behavior. |
| `src/config.js` | Public browser Supabase/Turnstile config; never copy values into handoff/logs. |
| `src/style.css` | Main responsive styles and visual system. |
| `setting.html` | Settings page shell. |
| `privacy.html` | Privacy information page. |
| `sw.js` | Network-only service worker and legacy cache cleanup. |
| `manifest.json` | PWA install metadata/icons. |
| `tests/*.test.js` | Node built-in mocked/static regression suite; not live integration coverage. |
| `supabase/friend_request_lifecycle_rpc_review.sql` | Review/migration artifact for lifecycle RPC architecture; do not execute casually. |
| `supabase/friend_request_identity_accessor_review.sql` | Review/migration artifact for identity accessor/policy integration; do not execute casually. |
| `supabase/schema.sql` | Historical/incomplete schema, explicitly not authoritative for current live backend. |
| `supabase/unread_count_fix.sql` | Historical migration artifact; do not rerun casually. |
| `README.md`, `AGENTS.md` | Setup, security, architecture, and development guardrails. |
| `TALKSPACE_PROJECT_STATE.md`, `TALKSPACE_PROJECT_CONTEXT.md` | Older project snapshots; useful context but parts of their test/release status are stale relative to this newer handoff. |

## 25. Important Functions

Locations below are approximate and were checked against current source during handoff preparation; re-run search before editing.

| Function | File | Approx. location | Purpose |
|---|---|---:|---|
| `callTransition` | `src/friend-request-lifecycle.js` | 104 | Sends `p_request_id` and `p_action` to the lifecycle RPC. |
| `createOrReuseRequest` | `src/friend-request-lifecycle.js` | 112 | Inserts a new request or reactivates the current user's rejected outgoing row. |
| `decideIncomingRequest` | `src/friend-request-lifecycle.js` | 197 | Accepts/rejects an incoming row through the lifecycle transition path. |
| `removeAcceptedRelationship` | `src/friend-request-lifecycle.js` | 251 | Removes using the accepted row ID and `remove` action. |
| `openUser` | `src/app.js` | 3570 | Selects a peer after relationship/presence/block checks. |
| `getBlockState` | `src/app.js` | 3807 | Determines block direction and unknown/fail-closed state. |
| `showBlockedChatState` | `src/app.js` | 3869 | Clears/replaces private chat UI and disables communication controls. |
| `refreshSelectedUserBlockState` | `src/app.js` | 3924 | Rechecks selected peer block/presence and restores or denies chat. |
| `handleBlockStatusBroadcast` | `src/app.js` | 4018 | Verifies a Realtime block/unblock event and refreshes selected state. |
| `broadcastBlockStatus` | `src/app.js` | 4602 | Broadcasts block-status changes. |
| `openConversation` | `src/app.js` | 4780 | Opens chat only after access gates and context checks. |
| `markMessagesAsDelivered` | `src/app.js` | 4992 | Applies delivered status for incoming messages. |
| `markMessagesAsSeen` | `src/app.js` | 5290 | Applies seen status and associated UI/read behavior. |
| `updateSelectedUserStatus` | `src/app.js` | 7097 | Refreshes selected-peer presence while rejecting stale results. |
| `startRealtime` | `src/app.js` | 7268 | Starts authenticated app Realtime subscriptions. |
| `sendMessage` | `src/app.js` | 6934 | Sends a message under current friendship/block/presence/context checks. |
| `startVoiceCall` | `src/call.js` | 529 | Shared voice/video call start and media acquisition path. |
| `acceptIncomingCall` | `src/call.js` | 827 | Accepts an authorized incoming call. |
| `rejectIncomingCall` | `src/call.js` | 1386 | Rejects an incoming call and cleans signaling/UI. |
| `handleCallSignal` | `src/call.js` | 1581 | Validates and dispatches signaling events. |
| `cleanupCall` | `src/call.js` | 2234 | Resets active/ringing call resources and UI state. |
| `handleBlockedPeerCall` | `src/call.js` | 2494 | Cleans/rejects call state when the peer becomes blocked. |
| `startCallRealtime` | `src/call.js` | 2673 | Starts call signaling subscription. |
| `loadProfile` / `saveSettings` | `src/settings.js` | 36 / 77 | Loads profile and saves display name with state guards. |

## 26. Tests and Verification History

There are 18 `tests/*.test.js` files and no package manifest. Run with `node --test tests/*.test.js` when verification is requested and appropriate.

Historical checkpoints reported in the project conversation:

- Friend-request lifecycle focused tests: **18 passed**; full suite: **157 passed**.
- Block-call lifecycle focused tests: **15 passed**; full suite: **162 passed**.
- More recent project snapshot records a later full-suite checkpoint of **153 passed** after a separate UI stage. These counts refer to different checkpoints; do not combine or call any one the current result without a fresh run.
- During the most recent read-only video diagnosis, `node --test tests/call-ui.test.js tests/block-call-lifecycle.test.js` reported **10 passed**, and `node --check src/call.js` passed.
- Tests are mocked/static as applicable. They do not prove current production RLS, database triggers, SMTP delivery, live browser behavior, or real device/network WebRTC.

Other historical completed work includes auth/Turnstile hardening, presence/privacy race fixes, message delivery/seen and unread/typing work, service-worker reliability, call UI and cleanup, mobile navigation, logging cleanup, and performance improvements. Preserve these safeguards; inspect the specific test/source before changing them.

## 27. Latest A+B Regression

The recent owner-reported regression used:

- Account A: Aarish (`aarish123`)
- Account B: Ujjwal (`ujjwal123`)

No passwords or other credentials belong in this handoff. The account labels above are test identities, not secrets.

Reported successful areas:

- Initial authentication/profile/presence and relationship/chat access.
- Send request, receive request, accept, reject, re-request, remove friend, and relationship restoration.
- Block/unblock, blocked chat state, blocked call prevention, and security checks.
- Messaging Realtime, delivery/seen ticks, unread counts, typing, refresh, and returning to chat.
- Friend Requests actions, privacy/safety view, and Remove Friend confirmation.
- Voice call accept/end and reject/caller cancel.
- Video call start and end after granting the browser camera/microphone permission.
- No relevant console errors were observed in the final checks.

Not fully verified or still outstanding:

- Offline privacy/offline call denial: the second account remained Online after navigation away for about 50 seconds, so a proper offline transition was not achieved.
- Logout/login was not fully verified in that regression.
- Voice call timeout was not tested.
- Full real mobile/responsive/device validation remains to be done.
- Profile bio behavior needs follow-up.
- Same-laptop camera contention may affect two-session video testing.
- Direct database/RLS inspection was not part of the browser regression.

## 28. Confirmed / Reported Working

Based on current source plus the owner's recent live regression report: friend request lifecycle including Remove Friend RPC, block/unblock chat/call restrictions, Realtime messaging and status indicators, unread and typing behavior, voice call basic paths, video call after media permission, and display-name settings. Keep the evidence labels clear: the browser observations are owner-reported; this document creation did not rerun them.

## 29. Known Limitations

1. Offline privacy was not conclusively exercised because presence did not transition Offline in the test.
2. Presence is a shared row, not per-device session aggregation; one active session can keep the account Online.
3. STUN-only WebRTC; no TURN relay is configured.
4. Full mobile-device, accessibility, and responsive verification is pending.
5. Bio editing/saving remains unclear/unsupported in the current profile flow.
6. Friends view uses the incorrect “Friend Requests” heading.
7. Enter-to-send behavior was inconsistent in one observed manual attempt; Send button worked. Reproduce once before changing it.
8. Video media permission waiting could use clearer feedback; core call succeeded after permission was granted.
9. Live SQL/RLS claims in review files are not an authoritative current schema; do not infer current production state from historical SQL.

## 30. Remaining Work by Priority

### P0 — Release confidence

- **NEEDS VERIFICATION:** Proper two-account offline presence/privacy test where the peer actually becomes Offline; verify content, composer, and calls are denied.
- **NEEDS VERIFICATION:** Final account/session regression including logout/login and a clean controlled QA dataset where appropriate.
- **NEEDS VERIFICATION:** Full real mobile-device pass and any targeted fixes based on observed behavior.
- **NEEDS ACTION WHEN APPROPRIATE:** Create a Git/GitHub backup/release checkpoint after checking current repository metadata and asking the owner before external publishing.

### P1 — Important follow-up

- **KNOWN MINOR ISSUE:** Change the Friends panel heading so Friends does not read “Friend Requests.”
- **NEEDS VERIFICATION:** Reproduce Enter-to-send inconsistency once; do not infer a bug from one attempt.
- **NEEDS VERIFICATION:** Clarify profile bio capability/behavior against the current profile contract.
- **NEEDS VERIFICATION:** Test voice timeout and call behavior across separate devices/networks.

### P2 — Polish / future

- **FUTURE UX:** Show explicit “Requesting camera and microphone permission…” state while media permission is pending.
- **POLISH:** Complete remaining visual/mobile/accessibility refinements after real-device observation.

## 31. Future Ideas — Not Implemented

- Google/Gmail sign-in.
- Mobile OTP login.
- First-login privacy notice/card.
- Clearer privacy indicators and explanation when private chat is unavailable because the peer is offline.
- Better visible media-permission feedback.
- Further mobile experience polish.

Do not describe these as existing capabilities or combine them into an unrelated fix.

## 32. WORK THAT HAS ALREADY BEEN DONE — DO NOT REDO WITHOUT A REGRESSION

- Remove Friend sender-side failure and the secure friend-request lifecycle RPC architecture.
- Executor/auth identity-access problem addressed through the identity accessor architecture; do not grant broad auth access as a workaround.
- Blocked chat not updating in an already-open session and blocked caller entering a ringing state.
- Message delivered/seen ticks, unread count handling, typing race, friend-selection race, clear-chat race, and friend-request Realtime refresh protections.
- External session-loss cleanup, presence freshness/revision and stale-preview handling, and authentication/Turnstile hardening.
- Service-worker/cache reliability and privacy-safe diagnostic logging.
- Call UI, call cleanup, and mobile navigation work.
- Performance improvements and README/AGENTS/project handoff documentation cleanup.

Check current code and reproduce an issue before reopening any of these areas.

## 33. Recommended Next Steps

1. Read this handoff completely, then read `TALKSPACE_PROJECT_STATE.md`, `TALKSPACE_PROJECT_CONTEXT.md`, `AGENTS.md`, and `README.md`; treat older status claims as time-stamped context.
2. Inspect current source and tests before assuming old behavior.
3. Run a proper A+B offline/presence privacy check and record the actual transition.
4. Perform real phone/laptop responsive and call testing; fix only issues observed.
5. Correct the small Friends heading issue in a separately scoped task.
6. Reproduce Enter-to-send once and clarify bio behavior.
7. Run final A+B regression and appropriate automated tests after changes.
8. Check Git/release backup options and coordinate with the owner before publishing or modifying external state.

Do not restart the project or redo the lifecycle/block fixes without evidence of regression.

## 34. Rules for the Next AI

- Read this handoff before changing anything and inspect current code first.
- Preserve the friend-request RPC architecture; do not restore direct lifecycle mutations.
- Do not execute or apply SQL, change Supabase, or modify RLS without explicit authorization and a current review.
- Never add service-role credentials or other secrets to the frontend, tests, docs, or logs.
- Preserve fail-closed friendship/block/presence privacy checks and message/call cleanup.
- Preserve generation, session, conversation, presence-revision, and Realtime lifecycle guards.
- Make minimal targeted changes and do not mix unrelated features.
- Test real behavior before declaring a browser/device issue; distinguish mocked results from live evidence.
- Keep offline privacy marked unverified until the peer demonstrably becomes Offline.
- Keep video documented as working after media permission; do not propose a WebRTC rewrite absent a reproduced failure.
- Ask before destructive database actions. Tell the owner before a GitHub/release publication step.

## 35. Final Release Checklist

- [ ] Confirm current repository/Git state and identify the actual release commit.
- [ ] Run the full automated suite and JavaScript syntax checks after final edits.
- [ ] Verify live friend request transitions and block/unblock on authorized QA accounts.
- [ ] Verify proper Offline transition, hidden history/previews, disabled messaging, and denied calls.
- [ ] Verify voice/video calls across separate devices; include permission and timeout behavior.
- [ ] Verify mobile navigation/layout on real devices and accessibility basics.
- [ ] Resolve or explicitly accept the Friends heading, Enter-key, and profile-bio follow-ups.
- [ ] Confirm no secrets are exposed and no historical/review-only SQL was accidentally applied.
- [ ] Prepare an owner-approved Git/GitHub backup/release checkpoint.

---

Handoff creation is documentation only. No application source, SQL, Supabase configuration, RLS policy, or database state should be changed as part of creating or updating this document.
