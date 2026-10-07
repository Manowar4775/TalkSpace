"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/app.js");
const css = read("src/style.css");
const index = read("index.html");

function sourceBetween(source, start, end) {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    assert.notEqual(startAt, -1, `missing source marker: ${start}`);
    assert.notEqual(endAt, -1, `missing source marker: ${end}`);
    return source.slice(startAt, endAt);
}

test("public profile is a dedicated email-free view with an explicit back action", () => {
    const panel = sourceBetween(index, '<section id="publicProfilePanel"', '<div id="friendRequestsPanel"');
    assert.match(panel, /id="publicProfileBackBtn"/);
    assert.match(panel, /id="publicProfileAvatar"/);
    assert.match(panel, /id="publicProfileDisplayName"/);
    assert.match(panel, /id="publicProfileUsername"/);
    assert.match(panel, /id="publicProfileRelationship"/);
    assert.doesNotMatch(panel, /email|uuid|auth.?id/i);
    assert.match(css, /#publicProfilePanel:not\(\.hidden\)/);
    assert.match(css, /\.publicProfileContent\s*\{/);
    assert.match(css, /\.publicProfileDetails\s*\{/);
});

test("public profile reads only public profile fields and fails closed on block checks", () => {
    const profile = sourceBetween(app, "async function openPublicProfile(", "function returnFromPublicProfile()");
    assert.match(profile, /await getBlockState\(user\.id\)/);
    assert.ok(profile.indexOf("await getBlockState(user.id)") < profile.indexOf('.from("profiles")'));
    assert.match(profile, /\.select\("id, username, display_name, avatar_url"\)/);
    assert.match(profile, /latestBlockState\.unknown \|\| latestBlockState\.blockedByMe \|\| latestBlockState\.blockedMe/);
    assert.match(profile, /relationship\.verified && relationship\.isFriend/);
    assert.match(profile, /Friend request received/);
    assert.match(profile, /Friend request sent/);
    assert.doesNotMatch(profile, /email|\.insert\(|\.update\(|createOrReuseRequest/i);
});

test("Find People and Friends expose separate profile and chat actions", () => {
    const search = sourceBetween(app, "async function searchUsers(", "async function openUser(");
    assert.match(search, /class="userProfileTrigger"/);
    assert.match(search, /class="userResultOpenChat"/);
    assert.match(search, /openPublicProfile\(user, "findPeople"\)/);
    assert.match(search, /openUser\(user, perf\)/);

    assert.match(app, /class="friendProfileTrigger"/);
    assert.match(app, /openPublicProfile\(friend, "friends"\)/);
    assert.match(app, /class="openFriendBtn"/);
    assert.match(app, /function returnFromPublicProfile\(\)[\s\S]*?\$\("friendsBtn"\)\.click\(\)/);
});

