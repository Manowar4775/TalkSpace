<!--
TALKSPACE PROJECT CONTEXT / LONG-FORM HANDOFF

READ THIS AFTER TALKSPACE_PROJECT_STATE.md.

This file preserves historical reasoning, decisions, known limitations,
testing boundaries, warnings, and development lessons.

It is intentionally verbose.

A future AI should NOT assume that every item below is an active bug.
Many items describe problems that were already fixed.

Always inspect the current repository before changing anything.
-->

<!--
# Why TalkSpace exists and intended product behavior

TalkSpace is a private one-to-one messaging application intended to behave
like a modern familiar messaging product. The product combines account
creation and login, friend relationships, blocking, chat, delivery/seen
feedback, unread counts, presence, voice/video calls, and mobile navigation.
The architecture is a static browser frontend, not a framework application:
HTML pages load CSS and ordinary JavaScript files, and the browser talks to
Supabase services. `src/app.js` owns a large share of app behavior;
`src/call.js` owns call lifecycle and signaling; `src/settings.js` owns the
standalone Settings flow.

The product's core promise is privacy-aware communication. Access to a private
conversation is conditional. A successful account login by itself is not
enough: for the selected peer, the app must establish the applicable online
state, an accepted friendship, and a verified unblocked state. When any of
those checks is unknown or fails, the UI must fail closed. This rule is part
of product behavior, not an optional security enhancement.

The project uses Supabase Auth, Postgres and Realtime, Cloudflare Turnstile,
and WebRTC. The operator-provided deployment context names Brevo SMTP for
email delivery. SMTP configuration belongs to the external Supabase/provider
setup; it is not a frontend feature. Do not put configuration values,
passwords, public or private tokens, service-role keys, OTPs, account UUIDs,
or other private identifiers into either handoff file or routine logs.

Local development URL: `http://localhost:5500/`.
Local project path: `C:/Users/manow/Downloads/Final-TalkSpace-fixed/talkspace`.
The project root currently has no Git metadata in this environment. A future
agent must inspect whether that remains true and must not call the tree clean
or dirty without usable repository status.
-->

<!--
# Current facts versus historical claims

Always distinguish these evidence types:

1. **Current source and checked-in tests** show what the app and mocks/static
   checks implement. This is the first thing to inspect on a new task.
2. **Historical owner-reported live checks** can be useful context, but they
   are not automatically current or independently reproducible. Mark them as
   historical/reported unless the evidence is still available and explicitly
   rechecked.
3. **Mocked/static automated tests** do not prove live Supabase policies,
   database triggers, email delivery, browser layout, device behavior, or
   production WebRTC reachability.
4. **A real browser/account regression** has not been completed for final
   release. Do not turn planned/pending tests into claims of completed tests.

The repository has 18 test files under `tests/` and no package.json. The most
recent run after the Stage 1 stylesheet work completed with 153 passing tests,
zero failures, in one full-suite run. An earlier presence/privacy verification
reported three consecutive full-suite runs at 153/153. Those are different
time points: do not imply the Stage 1 stylesheet was followed by three full
runs. The latest Stage 1 verification also reports 19 focused call/mobile/
settings/privacy tests passing, and 25 JavaScript files passing `node --check`.

Historical status recorded by the project owner also says unread behavior was
checked with one message, rapid multiple messages, and two sessions of one
account; the service-worker suite was reported as 40/40 over three runs; and
authentication hardening and several feature-focused suites passed repeatedly.
Those statements are retained as historical reports only. They are not
proof that a fresh live Supabase test ran during creation of these handoff
files. No tests were run while creating this context.
-->

<!--
# Privacy philosophy: friendship, blocks, presence, and offline content

## Friendship is the access relationship

Friendship is represented by accepted directional rows in `friend_requests`.
There is no separate friends table in the current frontend model. Direction
matters because `A -> B` and `B -> A` are different historical rows. The
relationship classifier must inspect both directions, account for pending,
accepted, rejected, and removed states, and avoid duplicate inserts when a
row already exists. Requests, the accepted relationship, removal, and
re-request are all part of this same lifecycle. A chat or call must not be
offered as available until friendship is verified as required by its flow.

## Blocks are bilateral communication barriers with directional ownership

The app distinguishes “I blocked this user” from “this user blocked me”. The
record owner is the only person who can remove that block. The other person's
block is a state to respect, not a record that the current user may delete.
Block status is derived from `blocked_users` and the existing peer-block check
(including the existing RPC path). If either direction cannot be confirmed,
the result is unknown, not unblocked. Unknown must not allow messaging,
conversation opening, or calling. Do not simplify this to a single boolean
that loses block direction, and do not add a second Realtime listener.

## Why offline users must not reveal private history or previews

Offline privacy means the content itself is unavailable. Showing an “offline”
label while leaving a last-message preview visible is not sufficient. The app
must avoid opening/loading private history when the initial presence condition
fails; clear/replace any prior selected-chat messages when the selected peer
goes offline or becomes unknown; disable the composer/send action and call
controls; and hide each friend's last-message preview once cached presence
expires, even when that friend is not the currently selected conversation.

This has two async consequences. First, an in-progress last-message fetch must
recheck the current friend state/revision/freshness before painting content.
An old read must not restore a preview after a newer offline event. Second,
Realtime message/presence updates must use the same privacy gates and must not
reveal content simply because they arrive after the initial check. Preserve
the selected-user, conversation, auth identity, and generation validations.

The previously identified non-selected-friend stale-preview gap is fixed in
the current source with cached `last_seen`, a single local expiration timer
for tracked friends, and freshness/revision checks around async previews.
This does not query Supabase periodically for every friend and does not create
one timer per row. Foreground/visibility reevaluation also schedules a local
freshness check. Do not regress the requirement that an expired friend
preview is replaced/hidden, not merely relabeled.

## Unknown states fail closed

Network, RLS, RPC, malformed response, or stale-context errors are not proof
of permission. Unknown friendship or block status must not expose messages or
enable communication. Unknown selected presence must keep history/composer/
calls unavailable. When the response belongs to a different auth identity,
selected peer, conversation, request generation, or call generation, ignore
it. Never “fix” a stuck-looking state by treating an error as online,
unblocked, or friends.

The Privacy page now describes behavior the application supports. It says
offline chat history and last-message previews are hidden and identifies
unsupported visibility/bio preferences as unavailable. Any future UI copy
must continue to reflect what the current app can enforce; do not add fake
privacy controls.
-->

<!--
# Presence design and its deliberate limitations

The app uses one shared presence row keyed by user, with `is_online` and
`last_seen` in the current verified contract recorded by project guidance.
The application heartbeat runs approximately every 20 seconds. Presence is
considered fresh only while `last_seen` is less than 45 seconds old. This is
freshness-based inference, not a server lease system and not per-device
aggregation.

Logout and `beforeunload` intentionally do not write account-wide offline
presence. One tab cannot know whether another device/tab is still connected;
an offline write from a closing tab could incorrectly mark a continuing
session offline. Once the final heartbeat stops, the old row may be treated
as online until the roughly 45-second freshness window elapses. A remaining
session can keep refreshing the shared row and the user online.

The selected-presence async bug was concrete: an immutable `const online`
binding could later be reassigned if the cached Realtime revision changed
while the SELECT was pending, throwing “Assignment to constant variable”.
The current implementation uses a mutable result and, more importantly,
validates the captured account, selected peer, selection generation, and
conversation context after the await. If Realtime changed the friend state,
the newer cached revision wins; stale cached presence is expired before it is
used. A stale SELECT may not overwrite a newer presence state. Error/unknown
remains fail-closed.

The stale non-selected preview issue and selected-presence revision race have
focused mocked regression tests. The freshness threshold and shared-row
architecture must remain unchanged unless the owner explicitly asks to
redesign presence. True multi-session aggregation would need an authorized
database/server design; it is outside normal UI and reliability work.
-->

<!--
# Authentication hardening and why generations exist

Auth UI and session restoration had several lifecycle boundaries that need
to remain independent. Startup session restoration can race with a user
choosing Login/Signup. A login can finish after Back, after a newer login, or
after a different identity becomes current. OTP verification can finish after
the auth view changes or a later OTP request supersedes it. Account setup can
resume after Back/sign-out/auth identity change while getUser, updateUser,
profile upsert, or profile load is pending. Profile loads/retries can return
for a prior account after an A-to-B identity switch.

The current app uses auth session/load generations, identity-transition state,
login operation generations/in-flight state, account-setup generations,
profile retry/load generations, and identity comparisons at async boundaries.
Current auth work should be invalidated when the user changes intent or when
the provider emits a different identity. The signed-out path clears private
DOM/state and removes the existing authenticated channel. It also starts call
cleanup while the current identity is still available for best-effort
signaling, then completes the shared cleanup. Do not add parallel auth
listeners or a second sign-out implementation.

Signup uses email OTP before username/password/profile setup; login uses
email/password. Cloudflare Turnstile is independently rendered for signup and
login. A previous reliability issue was unbounded 500ms-style polling when
the Turnstile library failed to load. It is fixed using bounded/cancellable
waiters with independent signup/login lifecycles. Waits end when the library
is ready, when the finite limit is reached, or when the auth UI request is
obsolete. Callback generations prevent an old success/expiry/error callback
from setting/clearing a replacement widget's token. Keep tokens single-use,
clear them on expiry/error/reset/removal, and never log or persist them.

The current auth UX also includes email validation, OTP resend cooldown and
fresh CAPTCHA requirement, duplicate submission protection, invalid OTP
rejection before provider verification, and accessible profile-load retry.
Do not repeat these already-completed hardening tasks unless current code
inspection identifies a regression.

Past implementation bugs recorded in current project context include:

* stale session/profile results could restore the wrong account UI;
* OTP/login/account-setup completions could apply after leaving their view;
* unbounded Turnstile wait polling could continue when the library never
  became available;
* old widget callbacks could affect a replacement widget;
* a selected presence revision update could reassign a `const` and throw;
* a non-selected friend's preview could outlive the 45-second freshness
  window.

Those items are documented as fixed in the current repository. Do not assume
they remain open defects; inspect their regression tests and current source.
-->

<!--
# Friend-request history, Realtime behavior, and unresolved live edge

The friend-request lifecycle module classifies both row directions and owns
the stateful operations used by the app. Relevant UI states include checking
relationship, Relationship unavailable, Send Friend Request, Request Sent,
Request Received, accepted friendship/Remove Friend, pending acceptance or
rejection, and removed/rejected history. Only the intended directional row
should be reactivated when appropriate. A unique directional constraint
means blind INSERTs are unsafe.

The current app maintains one authenticated `talkspace-realtime` channel.
Friend-request INSERT/UPDATE/DELETE changes are filtered for relevance to
the signed-in user; relevant relationship/request UI is refreshed through
existing loaders and current selection should be preserved. Do not add a
duplicate channel/listener for the same table or bypass user/session
generation checks.

There is an unresolved, live-data-dependent accepted-to-remove-to-re-request
case. A browser path once observed duplicate key `23505`; another reactivation
path observed an UPDATE returning zero affected rows. The exact live cause was
not identified. Possible explanations such as query filter mismatch,
concurrent state changes, or RLS are hypotheses only; none has been proven.
The lifecycle code checks whether an UPDATE affected a row and refreshes the
visible relationship instead of reporting false success or blindly inserting.
The mocked lifecycle suite passes but cannot identify the production cause.
Real authenticated Supabase/browser verification is still needed before
claiming this path resolved. Do not casually change RLS, uniqueness, or schema
to make the mock pass.
-->

<!--
# Message status and unread-count architecture

Message body is stored/displayed through `messages.body`. The app loads
messages only after the relevant privacy gates and filters per-user deletion
records. “Delete for Me” uses `message_deleted_for`; delete-for-everyone uses
the message soft-delete state; Clear Chat uses the app's guarded per-user
clear path. Editing updates message content/edited state. Preserve selected
user/conversation/auth identity generations for load, send, edit, delete,
delivery, seen, and clear operations.

Message sending has an in-flight guard. It captures the original text and
conversation context, rechecks that the same authenticated user/peer/chat is
still selected after asynchronous work, and only clears the composer if the
input still matches the submitted text. This avoids duplicate sends and
avoids losing a new draft typed while an older send was pending.

Delivery and seen status live in `message_status`, keyed in the app's
verified contract by message ID. Delivery must precede seen processing. UI
uses one check mark for delivered and two for seen. Keep tick meaning and
trigger ordering consistent. Realtime status changes update UI; they do not
permit stale chat writes.

Unread counts are database-trigger-driven. The frontend reads
`conversation_unread` for display and uses the existing guarded open-chat
clear flow only after message/seen handling succeeds. A message INSERT
trigger atomically increments the recipient count. The seen transition
decrements through a database trigger when `seen_at` first becomes non-null.
The frontend must never restore a client-side SELECT, increment, UPSERT
pattern because concurrent sends can lose updates. Realtime refreshes the
badge and does not increment the count itself.

The project owner has reported historical checks with one message, rapid
multiple messages, and two same-account sessions. The source/test repository
does not itself constitute fresh proof of production trigger behavior. No
live database verification occurred during creation of this handoff. Treat
the trigger design as protected; any SQL/database task needs current
authorization, schema/RLS/trigger review, and focused evidence.
-->

<!--
# Calls, WebRTC, and their UI

`src/call.js` owns one separate signaling channel named
`talkspace-call-signals`; the main app owns `talkspace-realtime`. Call code
uses generation/session checks and a single cleanup path. Logout/cleanup
invalidates the signaling generation and stops its channel. Peer connection,
local/remote tracks, call/ring/duration timers, pending ICE candidates, and
local UI are cleaned through existing lifecycle functions. Do not create a
second signaling channel or substitute a new cleanup path.

Calls require verified friendship, verified unblocked status, and current
online availability in their existing flows. Permission checks happen at
critical boundaries (including before/after media acquisition and before
offer signaling). Incoming offers are handled as new calls only after caller
validation. Subsequent answers/candidates/hangups/rejects/timeouts must belong
to the expected peer and active generation. Late call callbacks cannot affect
a new session/call. Unknown or failed permission checks deny the call.

Voice lifecycle is implemented, while video is present as a supported call
type/UI path. Incoming overlay indicates voice versus video, shows caller
identity, and provides Accept/Reject in an accessible modal dialog. Active
panel identifies peer/type/status, displays duration only once connected,
and provides Mute/Hang Up. Duration callbacks check the current peer
connection and generation. Rejected/missed/ended feedback reuses the shared
auto-hiding notification mechanism rather than starting duplicate toast
timers. Layout includes safe-area padding, scroll containment, wrapping for
long peer names, and larger narrow-screen targets. Continue protecting all
of this while polishing visuals.

The RTC config in source has Google STUN only. There is no TURN server
configuration. TURN has not been provisioned/configured in this project
state; the historical context does not establish a more specific reason for
its absence, so do not invent one. STUN-only may fail for restrictive NAT or
firewall paths. Do not claim universal WebRTC reliability. TURN would require
authorized service/configuration decisions and is not a visual foundation
change.
-->

<!--
# Mobile behavior and standalone account pages

At the mobile breakpoint, selected chat becomes a full-height single task;
the desktop sidebar is hidden and a Back to Friends control returns through
the existing friend loader. Search/navigation and account panels coordinate
through existing panel-navigation helpers. Friends, Requests, Blocked, and
Profile are currently content panels rather than redesigned mobile screens.
The chat uses dynamic viewport height and contained message scrolling, and
the composer/actions have touch-friendly minimum heights. Call overlays also
use safe-area and narrow viewport rules. Settings and Privacy are standalone
pages linked from the sidebar and each other.

The structural mobile support is implemented, but real devices, keyboard
interaction, browser chrome/viewport resizing, and touch behavior are not
verified in the blocked automation environment. Never call static CSS
inspection a device test.
-->

<!--
# Settings and Privacy behavior

Settings currently loads the signed-in profile and saves only
`display_name`. Unchanged values do not issue writes. Duplicate save attempts
are guarded; the UI reports load/save/success/error states, and pending work
checks session identity/generation before applying feedback or propagating
the value. Successful changes use the existing localStorage event mechanism
so other already-open app tabs can update the displayed name. The Bio field
is intentionally disabled because the current profile contract does not
support persisting it. Do not make disabled controls look active or claim
they save.

The Privacy page describes enforced friend-only communication, blocks,
fail-closed checks, offline history/previews, and currently available
settings. It does not offer invented online-visibility/profile-visibility
controls. The display name is an implemented setting; bio and those privacy
preferences are not currently user-configurable.
-->

<!--
# Service worker and cache decisions

The application does not provide an offline shell. The worker handles
same-origin GET resources as network-only and bypasses HTTP/CacheStorage
caching for those resources. Legacy cache names beginning `talkspace-` are
removed on activation. Production registration uses `updateViaCache: "none"`
and requests an update on app load. Normal waiting/update lifecycle is
intentional: the app does not call `skipWaiting()` or `clients.claim()`, so an
open chat/call is not forcibly switched mid-session. Localhost unregisters
the app-scope service worker and clears the app's old caches to reduce stale
local assets during development. Manifest and icon assets remain.

Do not add cache-first/offline behavior casually: authentication and live
communication still need network access, and stale authenticated UI is a
privacy risk. Service-worker changes need dedicated mocked lifecycle tests
and later actual browser verification.
-->

<!--
# Logging and privacy decisions

Routine diagnostics are opt-in through `?talkspaceDebug=1`; otherwise the
logger helper suppresses routine debug calls. Enabled routine diagnostics
use `console.debug`. Failures remain available through deliberate error or
warning channels. Keep messages, OTPs, passwords, access/session objects,
tokens, personal account UUIDs, peer/caller identifiers, full signaling
payloads, and message-status payloads out of routine logs. The project has
removed sensitive traces in prior logging hardening; inspect current logger
and tests before changing the policy. Do not “temporarily” add sensitive
logs and forget to remove them.

Performance tracing is also opt-in. Preserve the debug gate and avoid
exposing message or identity payloads while measuring chat-open stages.
-->

<!--
# Historical schema, database, and configuration guardrails

The frontend's current contract uses `blocked_users`, directional
`friend_requests`, `conversations.user_one/user_two`, `messages.body`,
`message_status`, `message_deleted_for`, `conversation_unread`, `presence`,
and `call_signals`, plus profile data. This summary is not a replacement for
current live schema or RLS inspection.

The checked-in `supabase/schema.sql` is historical/incomplete and contains
old or incompatible names including `blocks`, `friendships`, and older
conversation fields. README and AGENTS explicitly warn against running it
against the current project. `supabase/unread_count_fix.sql` is migration
history reported applied in the live project; do not rerun casually or
recreate its triggers/functions. Do not infer current live policy from a SQL
file. Never apply SQL, change schema/RLS/Realtime publication, mutate real
user data, or edit production Supabase/Turnstile/SMTP configuration during a
UI task. Verify and obtain explicit authorization for any future database
work.

`src/config.js` is browser-visible configuration. Never paste its values
into a handoff, issue, test output, or response. Frontend configuration may
include public settings only; private provider/service secrets must not be
shipped to the browser.
-->

<!--
# Browser/live verification boundary

The final two-account A+B browser regression has been explicitly postponed
until final verification/release. Earlier browser-control checks could
inspect existing Chrome tabs and accessibility trees but failed to provide
element geometry; coordinate input returned “coordinate input geometry is
unavailable”. The environment audit did not identify an attachable Chrome
CDP/Playwright/DOM-geometry connection for the existing profiles. Do not
repeat the same blocked coordinate attempt, do not click into accounts by
guessing coordinates, and do not change the app to work around an automation
limitation.

When an approved, supported browser connection becomes available at final
verification, use the established safe two-account QA setup rather than a
personal account. Test both identities for friend requests, messaging,
unread counts, blocking, offline privacy, calls, multi-session behavior, and
race conditions. Avoid exposing account credentials, OTPs, tokens, UUIDs, or
private data. Do not report live browser or Supabase behavior until exercised.

Until then, use mocked tests and static inspection with explicit labels.
Important pending checks include end-to-end messaging, live friend request
removal/reactivation, blocking, presence/offline privacy, unread triggers,
multi-session presence/unread behavior, actual call devices/NAT, mobile layout,
Settings appearance, service-worker lifecycle, and visual accessibility.
-->

<!--
# UI audit and current design stage

The completed static UI audit found that the evergreen identity is coherent:
deep page background, darker navigation, slightly lifted cards, green
actions, sage secondary text, and green-tinted messages. The 65px desktop
topbar and roughly 280px sidebar give a recognizable app shell. Mobile chat
navigation, back-to-friends behavior, safe-area call panels, Settings, and
Privacy pages already exist.

The main weaknesses recorded were uneven styling for dynamically rendered
friend/request/blocked rows and states, unclear active navigation, a crowded
chat header near the 700px breakpoint, simple empty states, weakly styled
unread badges and selected conversation, small metadata, and the lack of a
consistent focus treatment before Stage 1. The phone emoji in the call UI is
a later optional polish item. The prior audit was static, not a rendered
browser or device acceptance test.

## Stage 1: Design Foundation — COMPLETE

Stage 1 changed `src/style.css` only. It introduced a compact token foundation
for evergreen surfaces, semantic colors, spacing, typography, radii, and
elevation; a system sans-serif stack; shared neutral/primary/destructive
button styles with hover/pressed/disabled/focus-visible states; shared
input/placeholder/focus/invalid/disabled treatment; semantic color reuse;
subtle transitions; and reduced-motion handling. It was intended to change
presentation only. No HTML/JS or app behavior changes were made in Stage 1.

## Stage 2: App Shell + Navigation — NEXT

Keep Stage 2 focused on desktop shell proportions, sidebar/nav grouping,
active navigation appearance using existing state where possible, search
area hierarchy, chat-header spacing/crowding, surface separation, and
empty-state/content hierarchy. Maintain mobile safety and keyboard
accessibility. Preserve all IDs/listeners, panel navigation, selected-chat
logic, auth/session behavior, messages, friendship, block/presence/privacy
guards, and call behavior. Stage 2 is not a new design system or a framework
migration. It must not be mixed with people-row redesign (Stage 3), chat
message redesign (Stage 4), call visual refinement (Stage 5), full mobile/
standalone page refinement (Stage 6), or final polish (Stage 7).

Future sequence:

* Stage 1: Design Foundation — COMPLETE
* Stage 2: App Shell + Navigation — NEXT
* Stage 3: People Lists / Panels
* Stage 4: Chat Hierarchy / States / Message Presentation
* Stage 5: Calls Visual Refinement
* Stage 6: Mobile + Standalone Pages
* Stage 7: Consistency + Accessibility + Final Polish

Do not silently skip ahead. At the end of Stage 2, stop and report exact
files, visible changes, tests/checks, behavior impact, and what remains
unverified.
-->

<!--
# Engineering lessons and regressions not to reintroduce

* An error is not permission. Friendship/block/presence checks must fail
  closed.
* Hiding a stale label is not enough; private preview/history content itself
  must be removed or withheld.
* Async results need identity plus relevant selection/conversation/widget/
  call generation checks. A `finally` block or a visual label does not
  protect against stale work by itself.
* Realtime is another asynchronous source and must follow the same privacy
  gates as initial reads. Do not add duplicate subscriptions or let a stale
  SELECT overwrite a newer Realtime revision.
* Directional friend-request history and unique directional keys matter.
  Do not blindly insert after a relationship state transition.
* Unread increments belong to database triggers; do not implement client-side
  read-modify-write counters.
* A closing tab cannot own account-wide offline status when other sessions
  share one presence row.
* A current visual state can be improved in CSS without changing the app's
  security/session architecture. Keep design-stage scope small.
* Mocked success is not production proof. Report test type, count, and limits.
* Do not use the historical SQL file as an operational setup guide.
* Do not treat the project as blank or repeat hardening already present. Read
  current source/tests before choosing work.
-->

<!--
# Instructions for a future AI continuing this handoff

Read `TALKSPACE_PROJECT_STATE.md` first and this file second. Inspect the
actual current repository, tests, and available Git/file state before coding.
Find whether the requested feature is already implemented. Keep any task
focused. For UI work, continue with Stage 2 only and do not fold in later UI
stages. For behavior/security work, preserve existing fail-closed gates,
generations, selection/revision checks, and single-channel lifecycle.

Do not modify schema/RLS, run SQL, touch live data, alter external
configuration, create test accounts, or perform browser/account actions
unless the user explicitly authorizes that work. Do not expose secrets.
Run relevant existing tests after an implementation change; avoid inventing
a large test framework. Report exact files, behavior impact, commands and
results, and what was or was not verified live.
-->

<!--
FINAL HANDOFF RULE:

The project is already substantially engineered.

Do not treat it as a blank project.

Before implementing anything:
1. Read TALKSPACE_PROJECT_STATE.md.
2. Read this file.
3. Inspect the current code.
4. Determine whether the requested feature is already implemented.
5. Preserve existing race protections and privacy guarantees.
6. Make the smallest appropriate change.
7. Run relevant tests.
8. Report exactly what changed and what remains unverified.

CURRENT NEXT PLANNED WORK:
Stage 2 — App Shell + Navigation.

Do not silently jump to later UI stages.
-->
