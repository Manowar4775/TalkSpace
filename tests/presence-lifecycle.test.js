"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const agents = fs.readFileSync(path.join(__dirname, "../AGENTS.md"), "utf8");

function loadFreshnessHelper() {
    const match = app.match(/function isPresenceFresh\(presence, now = Date\.now\(\)\) \{[\s\S]*?\n\}/);
    assert.ok(match, "presence freshness helper is present");
    return vm.runInNewContext(`const PRESENCE_FRESHNESS_MS = 45000; (${match[0]})`);
}

test("presence freshness expires after the existing 45-second heartbeat window", () => {
    const isPresenceFresh = loadFreshnessHelper();
    const now = Date.parse("2026-01-01T00:00:45.000Z");
    assert.equal(isPresenceFresh({ is_online: true, last_seen: "2026-01-01T00:00:00.001Z" }, now), true);
    assert.equal(isPresenceFresh({ is_online: true, last_seen: "2026-01-01T00:00:00.000Z" }, now), false);
    assert.equal(isPresenceFresh({ is_online: false, last_seen: "2026-01-01T00:00:44.000Z" }, now), false);
    assert.equal(isPresenceFresh({ is_online: true, last_seen: "invalid" }, now), false);
    assert.equal(isPresenceFresh(null, now), false);
});

test("a continuing session heartbeat remains visible after another tab closes", () => {
    const isPresenceFresh = loadFreshnessHelper();
    const otherSessionHeartbeat = Date.parse("2026-01-01T00:00:20.000Z");
    const sharedPresenceRow = {
        is_online: true,
        last_seen: new Date(otherSessionHeartbeat).toISOString()
    };

    // Closing a different tab performs no shared-row mutation; a continuing
    // session keeps refreshing this row until its own heartbeat stops.
    assert.equal(isPresenceFresh(sharedPresenceRow, otherSessionHeartbeat + 1000), true);
    assert.equal(isPresenceFresh(sharedPresenceRow, otherSessionHeartbeat + 45000), false);
});

test("tab logout/close cannot write account-wide offline presence", () => {
    assert.doesNotMatch(app, /setOffline\s*\(/);
    assert.doesNotMatch(app, /beforeunload/);
    assert.doesNotMatch(app, /is_online\s*:\s*false/);
    assert.match(app, /\.upsert\(\{[\s\S]*?is_online:\s*true[\s\S]*?last_seen:/);
    assert.match(app, /\},\s*\n\s*20000\s*\n/);
    assert.match(agents, /45 seconds old/i);
    assert.match(agents, /Logout and tab close do not mark the shared row offline/i);
});

test("all presence sources share freshness checks and existing privacy/call gates remain", () => {
    assert.match(app, /function isFriendPresenceStateFresh\(/);
    assert.match(app, /scheduleFriendPresenceExpiry\(\)/);
    assert.match(app, /const PRESENCE_FRESHNESS_MS = 45000/);
    assert.match(app, /function updateSelectedUserStatus\(/);
    assert.match(app, /isSelectedCallPeerOnline/);
    assert.match(app, /blocked_users/);
    assert.match(app, /friendPresenceTrackingIds/);
    assert.match(app, /selectionGeneration/);
    assert.match(app, /presenceCheckInterval/);
});
