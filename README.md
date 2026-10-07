# TalkSpace

TalkSpace is a browser-based social messaging application built with HTML, CSS, and JavaScript. It uses Supabase for authentication, data, and Realtime; Cloudflare Turnstile for signup/login CAPTCHA; and WebRTC for voice and video calls.

## Current features

- Email OTP verification during signup, username/password account setup, and email/password login.
- Profiles and directional friend requests, including accepting, removing, and requesting friendship again.
- Blocking, with messaging and calls denied when access checks fail or a block is present.
- Friends-only private chat, with offline message history and previews hidden.
- Message editing/deletion, delivery and seen indicators, typing status, and database-triggered unread counts.
- Freshness-based online status, voice/video calls, and a responsive mobile layout.
- Settings that load and save the signed-in user's display name.
- A network-only service worker and install metadata; the app does not provide an offline application shell.

These features are implemented in the current application. They are not a future development roadmap.

## Run locally

Serve the project root over HTTP. For example, use VS Code Live Server or run:

```text
python -m http.server 5500
```

Then open `http://localhost:5500/`. TalkSpace needs network access to its configured services. No `package.json` or package-script runner is present; automated tests use Node's built-in test runner.

## Authentication and service configuration

Signup verifies an email OTP before account setup. Signup and password login use Cloudflare Turnstile tokens with Supabase Auth. The browser uses the project's public Supabase configuration; never put a service-role key, private Turnstile secret, password, or token in frontend files or documentation.

This repository is not a guide for provisioning or migrating the live backend. Use the authorized project's existing service configuration and its verified database contract.

## Database warning

Do **not** run `supabase/schema.sql` against the current TalkSpace project. That checked-in file is historical and incomplete; its table names and relationships do not match the currently verified application contract. In particular, the app uses `blocked_users` (not `blocks`) and derives friendship from directional `friend_requests` rows (there is no separate `friendships` table in the current frontend model). The current app also uses `conversations.user_one` and `conversations.user_two`.

Do not use the old schema as a migration or as the source of truth for the live database. Any future database work requires an authorized, current schema and policy review. The unread-count SQL is migration history, not a setup step to rerun casually.

## Presence and call limitations

Presence uses one shared row per user. The app treats a user as online only while `last_seen` is less than 45 seconds old. Because the row has no per-session identity or server-side aggregation, it cannot perfectly represent multiple browser/device sessions: one active session can keep the shared user online, and after the final heartbeat stops, offline status may take up to the freshness window to be inferred.

WebRTC currently configures STUN only; TURN is not configured. Calls may therefore be unreliable in restrictive NAT or firewall environments.

## Tests and verification

Run the automated suite from the project root:

```text
node --test tests/*.test.js
```

These tests use mocked clients and static source checks. They do not establish live Supabase or real-browser behavior. Automated coverage is substantial, but final real-browser/account regression verification remains pending. Do not describe that verification as complete until it has actually been performed.

JavaScript syntax can be checked with `node --check` on the JavaScript files under `src/` and `tests/`. There is no package script for these checks.

## Service worker

The service worker sends same-origin GET requests to the network without using the browser or CacheStorage cache and removes legacy TalkSpace caches on activation. It does not cache an offline app shell; authenticated features require network access.
